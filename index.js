/**
 * Alexa Smart Home Skill — AWS Lambda Handler
 *
 * Entry point for an Alexa Smart Home Skill backend. Receives Smart Home
 * directives from the Alexa Voice Service, resolves the caller's identity
 * via Auth0, and forwards device commands to your smart home backend API.
 *
 * Supported directives:
 *   - Alexa.Discovery      → device discovery
 *   - Alexa.Authorization  → account linking (AcceptGrant)
 *   - Alexa.PowerController → TurnOn / TurnOff
 *   - Alexa.RangeController → fan speed (1–5)
 *   - Alexa / ReportState  → current device state
 *
 * All configuration is read from Lambda environment variables — no secrets
 * are stored in this file. See .env.example for the full variable list.
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// ─── Configuration ────────────────────────────────────────────────────────────
// All values come from Lambda environment variables (Configuration → Environment variables).

const API_KEY            = process.env.API_KEY;            // API key sent to the backend on every request
const BACKEND_API_URL    = process.env.BACKEND_API_URL;    // Base URL of your smart home backend (no trailing slash)
const AUTH0_USERINFO_URL = process.env.AUTH0_USERINFO_URL; // Auth0 /userinfo endpoint — resolves access token → email
const MANUFACTURER_NAME  = process.env.MANUFACTURER_NAME;  // Brand name shown in the Alexa app under device details
const MODEL_NAME         = process.env.MODEL_NAME;         // Device model name shown in the Alexa app
const DEVICE_LIST_PATH   = process.env.DEVICE_LIST_PATH;   // Backend path: returns all devices for a given user email
const DEVICE_CONTROL_PATH = process.env.DEVICE_CONTROL_PATH; // Backend path: sends on/off or speed commands to a device
const DEVICE_STATE_PATH  = process.env.DEVICE_STATE_PATH;  // Backend path: returns the current state of a single device

// ─── Shared HTTP Headers ──────────────────────────────────────────────────────
// Reused on every backend request. Content-Type is text/plain because the
// backend expects a raw JSON string in the body rather than parsed JSON.

const BACKEND_HEADERS = {
    'api-key': API_KEY,
    'Content-Type': 'text/plain'
};

// ─── Alexa Capability Definitions ────────────────────────────────────────────
// Capability objects are declared once at module level and reused across all
// discovery responses, avoiding object recreation on every invocation.

/**
 * Alexa capabilities for a switch or bulb device.
 * Supports: power on/off and endpoint health reporting.
 */
const switchCapability = [
    {
        "type": "AlexaInterface",
        "interface": "Alexa.PowerController",
        "version": "3",
        "properties": {
            "supported": [{ "name": "powerState" }],
            "retrievable": false,
            "proactivelyReported": false
        }
    },
    {
        "type": "AlexaInterface",
        "interface": "Alexa.EndpointHealth",
        "version": "3.2",
        "properties": {
            "supported": [{ "name": "connectivity" }],
            "proactivelyReported": false,
            "retrievable": false
        }
    },
    {
        // Required by every Smart Home endpoint to identify the Alexa API version
        "type": "AlexaInterface",
        "interface": "Alexa",
        "version": "3"
    }
];

/**
 * Alexa capabilities for a fan device.
 * Supports: power on/off, fan speed (range 1–5), and endpoint health reporting.
 * The RangeController instance "Fan.Speed" maps to the Alexa built-in
 * asset "Alexa.Setting.FanSpeed" so users can say "set fan speed to 3".
 */
const fanCapability = [
    {
        "type": "AlexaInterface",
        "interface": "Alexa.PowerController",
        "version": "3",
        "properties": {
            "supported": [{ "name": "powerState" }],
            "retrievable": false,
            "proactivelyReported": false
        }
    },
    {
        "type": "AlexaInterface",
        "interface": "Alexa.EndpointHealth",
        "version": "3.2",
        "properties": {
            "supported": [{ "name": "connectivity" }],
            "proactivelyReported": true,
            "retrievable": true
        }
    },
    {
        "type": "AlexaInterface",
        "interface": "Alexa.RangeController",
        "instance": "Fan.Speed",
        "version": "3",
        "properties": {
            "supported": [{ "name": "rangeValue" }],
            "proactivelyReported": false,
            "retrievable": false,
            "nonControllable": false
        },
        "capabilityResources": {
            "friendlyNames": [
                { "@type": "asset", "value": { "assetId": "Alexa.Setting.FanSpeed" } },
                { "@type": "text", "value": { "text": "Speed", "locale": "en-US" } }
            ]
        },
        "configuration": {
            // Fan speed range exposed to Alexa: 1 (slowest) to 5 (fastest)
            "supportedRange": {
                "minimumValue": 1,
                "maximumValue": 5,
                "precision": 1
            },
            // Named presets let users say "set fan to maximum" or "set fan to low"
            "presets": [
                {
                    "rangeValue": 5,
                    "presetResources": {
                        "friendlyNames": [
                            { "@type": "asset", "value": { "assetId": "Alexa.Value.Maximum" } },
                            { "@type": "asset", "value": { "assetId": "Alexa.Value.High" } },
                            { "@type": "text", "value": { "text": "Highest", "locale": "en-US" } },
                            { "@type": "text", "value": { "text": "Fast", "locale": "en-US" } }
                        ]
                    }
                },
                {
                    "rangeValue": 1,
                    "presetResources": {
                        "friendlyNames": [
                            { "@type": "asset", "value": { "assetId": "Alexa.Value.Minimum" } },
                            { "@type": "asset", "value": { "assetId": "Alexa.Value.Low" } },
                            { "@type": "text", "value": { "text": "Lowest", "locale": "en-US" } },
                            { "@type": "text", "value": { "text": "Slow", "locale": "en-US" } }
                        ]
                    }
                }
            ]
        }
    },
    {
        "type": "AlexaInterface",
        "interface": "Alexa",
        "version": "3"
    }
];

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Resolves an Alexa OAuth access token to the linked user's email address
 * by calling the Auth0 /userinfo endpoint.
 *
 * @param {string} token - OAuth 2.0 access token from the Alexa directive scope
 * @returns {Promise<string|undefined>} The user's email, or undefined if the token is invalid
 */
async function getUser(token) {
    try {
        const response = await axios.get(AUTH0_USERINFO_URL, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data.email;
    } catch (error) {
        console.error('getUser failed:', error.message);
        return undefined;
    }
}

// ─── Device Discovery ─────────────────────────────────────────────────────────

/**
 * Fetches all smart home devices registered to a user from the backend API
 * and converts them into the Alexa endpoint format required by the Discovery response.
 *
 * Devices with missing required fields (endpointid, id, switch_id, gatewayId)
 * are silently excluded from the response.
 *
 * @param {string} email - The user's email address
 * @returns {Promise<Object[]>} Array of Alexa-formatted endpoint objects
 */
async function getDeviceList(email) {
    const response = await axios.post(
        `${BACKEND_API_URL}${DEVICE_LIST_PATH}`,
        JSON.stringify({ email }),
        { headers: BACKEND_HEADERS }
    );

    const devices = response.data.data;
    console.log('Device list:', devices);

    const deviceList = devices.map(device => {
        // Map backend device type to the correct Alexa display category
        let displayCategories;
        if (device.type === 'switch') displayCategories = ['SWITCH'];
        else if (device.type === 'fan')    displayCategories = ['FAN'];
        else if (device.type === 'bulb')   displayCategories = ['LIGHT'];
        else return null; // Skip unknown device types

        // Skip any device that is missing required identifiers
        if (!device.endpointid || !device.id || !device.switch_id || !device.gatewayId) return null;

        return {
            endpointId: device.endpointid,
            manufacturerName: MANUFACTURER_NAME,
            friendlyName: device.name,
            description: device.desc,
            displayCategories,
            additionalAttributes: {
                manufacturer: MANUFACTURER_NAME,
                model: MODEL_NAME
            },
            // The cookie is passed back by Alexa on every subsequent directive,
            // giving us the backend IDs needed to target the correct physical device.
            cookie: {
                gatewayId: device.gatewayId,
                switchId: device.id,
                id: device.switch_id
            },
            capabilities: device.type === 'fan' ? fanCapability : switchCapability
        };
    });

    return deviceList.filter(Boolean);
}

// ─── Directive Handlers ───────────────────────────────────────────────────────

/**
 * Handles Alexa.Discovery / Discover
 * Resolves the caller's Auth0 token to an email, fetches their device list,
 * and returns all devices as Alexa endpoints.
 *
 * @param {Object} request - Alexa Smart Home directive
 * @returns {Promise<Object>} Alexa Discover.Response event
 */
async function handleDiscoveryRequest(request) {
    const token = request?.directive?.payload?.scope?.token;
    const email = await getUser(token);
    const endpoints = await getDeviceList(email);
    // Reuse the incoming header and rename it to the response directive
    const header = { ...request.directive.header, name: 'Discover.Response' };
    return { event: { header, payload: { endpoints } } };
}

/**
 * Handles Alexa.Authorization / AcceptGrant
 * Called once when the user links their account in the Alexa app.
 * No token storage is required here — Auth0 handles the OAuth flow.
 *
 * @param {Object} request - Alexa Smart Home directive
 * @returns {Object} Alexa AcceptGrant.Response event
 */
function handleAuthorizationRequest(request) {
    const header = { ...request.directive.header, name: 'AcceptGrant.Response' };
    console.log('AcceptGrant Response:', JSON.stringify({ header, payload: {} }));
    return { event: { header, payload: {} } };
}

/**
 * Handles Alexa.PowerController / TurnOn and TurnOff
 * Sends a boolean power command to the backend and returns the confirmed
 * new power state to Alexa.
 *
 * @param {Object} request - Alexa Smart Home directive
 * @returns {Promise<Object>} Alexa Response event with updated powerState property
 * @throws {Error} If the backend returns a non-200 status
 */
async function handlePowerControlRequest(request) {
    const { name } = request.directive.header;
    const isOn = name === 'TurnOn';
    // The physical device ID is stored in the cookie set during discovery
    const switchId = request?.directive?.endpoint?.cookie?.id;

    const body = JSON.stringify({ switch_id: [switchId], value: isOn, type: 'switch' });
    const response = await axios.post(
        `${BACKEND_API_URL}${DEVICE_CONTROL_PATH}`,
        body,
        { headers: BACKEND_HEADERS }
    );

    if (response.status !== 200) {
        throw new Error(`Power control failed with status ${response.status}`);
    }

    const now = new Date().toISOString();
    return {
        context: {
            properties: [
                {
                    namespace: 'Alexa.PowerController',
                    name: 'powerState',
                    value: isOn ? 'ON' : 'OFF',
                    timeOfSample: now,
                    uncertaintyInMilliseconds: 3000
                },
                {
                    namespace: 'Alexa.EndpointHealth',
                    name: 'connectivity',
                    value: { value: 'OK' },
                    timeOfSample: now,
                    uncertaintyInMilliseconds: 200
                }
            ]
        },
        event: {
            header: {
                namespace: 'Alexa',
                name: 'Response',
                messageId: uuidv4(),
                correlationToken: request?.directive?.header?.correlationToken,
                payloadVersion: '3'
            },
            endpoint: {
                scope: {
                    type: request?.directive?.endpoint?.scope?.type,
                    token: request?.directive?.endpoint?.scope?.token
                },
                endpointId: request?.directive?.endpoint?.endpointId
            },
            payload: {}
        }
    };
}

/**
 * Handles Alexa.RangeController / SetRangeValue
 * Sets the fan speed on the target device. The backend expects the speed
 * value prefixed with "s" (e.g. "s3" for speed 3) to distinguish a speed
 * command from a raw numeric switch value.
 *
 * @param {Object} request - Alexa Smart Home directive
 * @returns {Promise<Object>} Alexa Response event with updated rangeValue and powerState properties
 * @throws {Error} If the backend returns a non-200 status
 */
async function handleRangeControlRequest(request) {
    const fanSpeed = request?.directive?.payload?.rangeValue;
    const switchId = request?.directive?.endpoint?.cookie?.id;

    // Backend expects speed as "s1"–"s5" to distinguish from boolean switch commands
    const body = JSON.stringify({ switch_id: [switchId], value: `s${fanSpeed}`, type: 'fanspeed' });
    const response = await axios.post(
        `${BACKEND_API_URL}${DEVICE_CONTROL_PATH}`,
        body,
        { headers: BACKEND_HEADERS }
    );

    if (response.status !== 200) {
        throw new Error(`Range control failed with status ${response.status}`);
    }

    const now = new Date().toISOString();
    return {
        event: {
            header: {
                namespace: 'Alexa',
                name: 'Response',
                messageId: uuidv4(),
                correlationToken: request?.directive?.header?.correlationToken,
                payloadVersion: '3'
            },
            endpoint: {
                scope: {
                    type: request?.directive?.endpoint?.scope?.type,
                    token: request?.directive?.endpoint?.scope?.token
                },
                endpointId: request?.directive?.endpoint?.endpointId
            },
            payload: {}
        },
        context: {
            properties: [
                {
                    // Setting a speed implicitly means the fan is on
                    namespace: 'Alexa.PowerController',
                    name: 'powerState',
                    value: 'ON',
                    timeOfSample: now,
                    uncertaintyInMilliseconds: 0
                },
                {
                    namespace: 'Alexa.RangeController',
                    instance: 'Fan.Speed',
                    name: 'rangeValue',
                    value: fanSpeed,
                    timeOfSample: now,
                    uncertaintyInMilliseconds: 5000
                },
                {
                    namespace: 'Alexa.EndpointHealth',
                    name: 'connectivity',
                    value: { value: 'OK' },
                    timeOfSample: now,
                    uncertaintyInMilliseconds: 5000
                }
            ]
        }
    };
}

/**
 * Handles Alexa / ReportState
 * Queries the backend for the live state of a single device and returns
 * it to Alexa as a StateReport. Used by the Alexa app and routines to
 * verify device state before or after an action.
 *
 * @param {Object} request - Alexa Smart Home directive
 * @returns {Promise<Object>} Alexa StateReport event with current powerState
 */
async function handleReportStateRequest(request) {
    // switchId here refers to the internal backend device ID (stored as switchId in the cookie)
    const switchId = request?.directive?.endpoint?.cookie?.switchId;

    const body = JSON.stringify({ id: switchId });
    const response = await axios.post(
        `${BACKEND_API_URL}${DEVICE_STATE_PATH}`,
        body,
        { headers: BACKEND_HEADERS }
    );

    const switchData = response.data.data[0];
    console.log('Switch state:', switchData);

    return {
        event: {
            header: {
                namespace: 'Alexa',
                name: 'StateReport',
                messageId: uuidv4(),
                correlationToken: request?.directive?.header?.correlationToken,
                payloadVersion: '3'
            },
            endpoint: {
                endpointId: request?.directive?.endpoint?.endpointId
            },
            payload: {}
        },
        context: {
            properties: [{
                namespace: 'Alexa.PowerController',
                name: 'powerState',
                value: switchData.state ? 'ON' : 'OFF', // true = ON, false = OFF
                timeOfSample: new Date().toISOString(),
                uncertaintyInMilliseconds: 3000
            }]
        }
    };
}

// ─── Lambda Entry Point ───────────────────────────────────────────────────────

/**
 * Main AWS Lambda handler — entry point for all Alexa Smart Home directives.
 *
 * Lambda invokes this function with the full Alexa directive as `request`.
 * The function routes to the appropriate handler based on the directive
 * namespace and name, then returns the handler's response directly.
 * Unhandled directives are logged and return undefined (Lambda treats this
 * as a successful invocation with no response body).
 *
 * @param {Object} request - Alexa Smart Home directive (the Lambda event object)
 * @returns {Promise<Object|undefined>} Alexa-formatted response object
 */
exports.handler = async function (request) {
    console.log('Request:', JSON.stringify(request, null, 2));

    const { namespace, name } = request.directive.header;

    if (namespace === 'Alexa.Discovery' && name === 'Discover') {
        return handleDiscoveryRequest(request);
    } else if (namespace === 'Alexa.PowerController') {
        return handlePowerControlRequest(request);
    } else if (namespace === 'Alexa.Authorization' && name === 'AcceptGrant') {
        return handleAuthorizationRequest(request);
    } else if (namespace === 'Alexa' && name === 'ReportState') {
        return handleReportStateRequest(request);
    } else if (namespace === 'Alexa.RangeController') {
        return handleRangeControlRequest(request);
    }

    console.warn('Unhandled directive:', namespace, name);
};
