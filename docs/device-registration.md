# Device registration (for mobile app)

POST /device/register

Content-Type: application/json

Sample JSON body:

{
  "deviceId": "<unique-device-id>",
  "serialNumber": "<serial-number>",
  "model": "Pixel 5",
  "androidVersion": "13",
  "sim1": "9876543210",
  "sim2": "",
  "battery": 87,
  "isOnline": true,
  "lastSeen": "2026-02-20T10:00:00.000Z"
}

Notes:
- `deviceId` or `serialNumber` is used to match existing devices.
- Mobile apps should periodically POST (heartbeat) to keep `lastSeen` and `isOnline` updated.
- Use HTTPS in production and authenticate requests if needed.
