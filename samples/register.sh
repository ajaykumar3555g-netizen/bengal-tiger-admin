#!/bin/bash
# Sample curl to register/upsert a device to the Bengal Tiger admin server
RAILWAY_URL="https://bengal-tiger-admin-production-8071.up.railway.app"

curl -X POST "$RAILWAY_URL/device/register" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId":"device-1234",
    "serialNumber":"SN-0001",
    "model":"Pixel 5",
    "androidVersion":"13",
    "sim1":"9876543210",
    "sim2":"",
    "battery":87,
    "isOnline":true,
    "lastSeen":"2026-02-20T10:00:00.000Z"
  }'
