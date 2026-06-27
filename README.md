# Alexa Smart Home Custom Lambda

A fully generic, reusable AWS Lambda function that serves as the backend for an **Alexa Smart Home Skill**. It handles device discovery, power control, fan speed, and state reporting — all driven by environment variables so you can wire it up to any smart home backend without changing a line of code.

Built as a reference implementation: clone it, set your env vars, deploy, and you have a working Alexa Smart Home Skill backend in minutes.

---

## How It Works

```
User: "Alexa, turn on the fan"
          │
          ▼
  Alexa Voice Service
          │  Smart Home directive (JSON)
          ▼
  Alexa Smart Home Skill
          │  Triggers
          ▼
  AWS Lambda  ──► Auth0  (OAuth token → user email)
          │
          ▼
  Your Smart Home Backend API
          │
          ▼
  Physical Devices (Switches / Fans / Bulbs)
```

**Account linking** is handled via Auth0 OAuth 2.0. When a user enables the Alexa skill and links their account, Alexa receives an access token. On every request the Lambda exchanges that token for the user's email via the Auth0 `/userinfo` endpoint, then queries your backend for their registered devices.

---

## Supported Alexa Directives

| Namespace | Directive | What it does |
|---|---|---|
| `Alexa.Discovery` | `Discover` | Fetches all devices linked to the user's account |
| `Alexa.Authorization` | `AcceptGrant` | Completes Alexa account linking |
| `Alexa.PowerController` | `TurnOn` / `TurnOff` | Turns a switch, fan, or bulb on or off |
| `Alexa.RangeController` | `SetRangeValue` | Sets fan speed (range 1–5) |
| `Alexa` | `ReportState` | Returns the current power state of a device |

## Supported Device Types

| `type` field in your API | Alexa Category | Alexa Capabilities |
|---|---|---|
| `switch` | `SWITCH` | PowerController, EndpointHealth |
| `fan` | `FAN` | PowerController, RangeController (speed 1–5), EndpointHealth |
| `bulb` | `LIGHT` | PowerController, EndpointHealth |

---

## Backend API Contract

This Lambda expects your backend to expose three endpoints. The paths are configurable via environment variables — adapt them to match your API design.

### 1. Device List — `DEVICE_LIST_PATH`
Returns all devices registered to a user.

**Request**
```
POST {BACKEND_API_URL}{DEVICE_LIST_PATH}
Content-Type: text/plain
api-key: {API_KEY}

{"email": "user@example.com"}
```

**Expected response shape**
```json
{
  "data": [
    {
      "endpointid": "unique-device-id",
      "name": "Living Room Fan",
      "desc": "Ceiling fan",
      "type": "fan",
      "id": "switch-uuid",
      "switch_id": "physical-switch-id",
      "gatewayId": "gateway-uuid"
    }
  ]
}
```

---

### 2. Device Control — `DEVICE_CONTROL_PATH`
Sends an on/off or speed command to a device.

**Power on/off request**
```
POST {BACKEND_API_URL}{DEVICE_CONTROL_PATH}
Content-Type: text/plain
api-key: {API_KEY}

{"switch_id": ["physical-switch-id"], "value": true, "type": "switch"}
```

**Fan speed request** (`value` is `"s1"` through `"s5"`)
```json
{"switch_id": ["physical-switch-id"], "value": "s3", "type": "fanspeed"}
```

**Expected response:** HTTP `200 OK`

---

### 3. Device State — `DEVICE_STATE_PATH`
Returns the current state of a single device.

**Request**
```
POST {BACKEND_API_URL}{DEVICE_STATE_PATH}
Content-Type: text/plain
api-key: {API_KEY}

{"id": "switch-uuid"}
```

**Expected response shape**
```json
{
  "data": [
    { "state": true }
  ]
}
```
`state: true` = ON, `state: false` = OFF.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18.x or later
- An [AWS account](https://aws.amazon.com/) with permission to create Lambda functions
- An [Amazon Developer account](https://developer.amazon.com/) to create an Alexa skill
- An [Auth0 account](https://auth0.com/) (or any OAuth 2.0 provider that exposes a `/userinfo` endpoint)
- Your own smart home backend that implements the three API endpoints above

---

## Environment Variables

Set these in the Lambda console under **Configuration → Environment variables**. Copy `.env.example` as a reference — never commit real values to source control.

| Variable | Description |
|---|---|
| `AUTH0_USERINFO_URL` | Auth0 `/userinfo` URL — resolves an access token to a user email |
| `BACKEND_API_URL` | Base URL of your backend (no trailing slash) |
| `API_KEY` | API key sent on every backend request via the `api-key` header |
| `DEVICE_LIST_PATH` | Path to your device list endpoint, e.g. `/api/v1/device/list` |
| `DEVICE_CONTROL_PATH` | Path to your device control endpoint, e.g. `/api/v1/device/control` |
| `DEVICE_STATE_PATH` | Path to your device state endpoint, e.g. `/api/v1/device/state` |
| `MANUFACTURER_NAME` | Your brand name shown in the Alexa app under device details |
| `MODEL_NAME` | Your device model name shown in the Alexa app |

---

## Project Structure

```
alexa-smart-home-custom-lambda/
├── index.js          # Lambda handler — all skill logic
├── package.json      # Dependencies (axios, uuid)
├── .env.example      # Environment variable template (safe to commit)
├── .gitignore        # Excludes node_modules
└── README.md
```

---

## Deployment

### 1. Install dependencies

```bash
npm install
```

### 2. Package for Lambda

Lambda requires a `.zip` containing `index.js` and `node_modules`.

**Windows (PowerShell)**
```powershell
Compress-Archive -Path index.js, node_modules -DestinationPath function.zip
```

**Mac / Linux**
```bash
zip -r function.zip index.js node_modules
```

### 3. Create the Lambda function

1. Open the [AWS Lambda console](https://console.aws.amazon.com/lambda)
2. **Create function → Author from scratch**
3. Fill in:
   - **Function name:** `alexa-smart-home` (or anything you like)
   - **Runtime:** `Node.js 18.x`
   - **Architecture:** `x86_64`
4. Click **Create function**

### 4. Upload the package

- **Code** tab → **Upload from** → **.zip file** → select `function.zip`
- Confirm the **Handler** is set to `index.handler`

### 5. Set environment variables

- **Configuration → Environment variables → Edit**
- Add all variables from the table above with your real values
- Click **Save**

### 6. Increase the timeout

- **Configuration → General configuration → Edit**
- Set **Timeout** to `10 seconds` — the default 3 s is too short for chained API calls
- Memory: `128 MB` is sufficient

### 7. Add the Alexa Smart Home trigger

- **Configuration → Triggers → Add trigger**
- Select **Alexa Smart Home**
- Paste your **Alexa Skill ID** (from the Alexa Developer Console)
- Click **Add**

### 8. Copy the Lambda ARN

Copy the **Function ARN** shown at the top of the Lambda page. You'll paste it into the Alexa skill next.

---

## Alexa Skill Setup

1. Go to the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask)
2. **Create Skill** → choose **Smart Home** as the skill type → **Provision your own**
3. Under **Smart Home service endpoint**, paste the Lambda ARN from step 8 above
4. Under **Account Linking**, configure your OAuth 2.0 provider (Auth0 example below):

| Field | Value |
|---|---|
| Authorization URI | `https://your-tenant.region.auth0.com/authorize` |
| Access Token URI | `https://your-tenant.region.auth0.com/oauth/token` |
| Client ID | Your Auth0 application client ID |
| Client Secret | Your Auth0 application client secret |
| Scope | `openid email profile` |
| Access Token Scheme | HTTP Basic |

5. Save, then enable the skill in the Alexa app and link your account

---

## Local Testing

Lambda environment variables are injected by the runtime — there is no `.env` file at deploy time. For local invocation, create a throwaway `local.js` that sets `process.env` before calling the handler:

```js
// local.js  — do not commit
process.env.API_KEY            = 'your_api_key';
process.env.BACKEND_API_URL    = 'https://your-backend-host';
process.env.AUTH0_USERINFO_URL = 'https://your-tenant.region.auth0.com/userinfo';
process.env.DEVICE_LIST_PATH   = '/api/v1/device/list';
process.env.DEVICE_CONTROL_PATH = '/api/v1/device/control';
process.env.DEVICE_STATE_PATH  = '/api/v1/device/state';
process.env.MANUFACTURER_NAME  = 'Your Brand';
process.env.MODEL_NAME         = 'Your Model';

const { handler } = require('./index');

// Paste any Alexa directive JSON here to test locally
const testEvent = {
    directive: {
        header: {
            namespace: 'Alexa.Authorization',
            name: 'AcceptGrant',
            payloadVersion: '3'
        },
        payload: { grant: {}, grantee: {} }
    }
};

handler(testEvent).then(console.log).catch(console.error);
```

Run with:
```bash
node local.js
```

Alternatively, use the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) for a closer simulation of the Lambda runtime.

---

## Dependencies

| Package | Purpose |
|---|---|
| `axios` | HTTP client for Auth0 and backend API calls |
| `uuid` | Generates unique `messageId` values required by every Alexa response |

```bash
npm install axios uuid
```
