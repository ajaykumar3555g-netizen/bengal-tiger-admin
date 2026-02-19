const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors'); // यह बहुत ज़रूरी है!
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');const WebSocket = require('ws');
const app = express();

// Middleware
app.use(express.json());
app.use(cors()); // यह बटन्स को काम करने देगा और Error हटाएगा

// Serve static files from the `public` folder (CSS/JS/images)
app.use(express.static(path.join(__dirname, 'public')));

// 1. MongoDB Connection
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected Successfully!"))
  .catch((err) => console.log("❌ MongoDB Connection Error:", err));

// 2. Device Schema (extended for dashboard)
const deviceSchema = new mongoose.Schema({
    deviceId: { type: String, index: true },
    serialNumber: { type: String, index: true },
    model: String,
    androidVersion: String,
    sim1: String,
    sim2: String,
    battery: { type: Number, default: 0 },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    isPinned: { type: Boolean, default: false },
    registrationTimestamp: { type: Date, default: Date.now }
});
const Device = mongoose.model('Device', deviceSchema);

// 3. API - Android App से डेटा लेने के लिए (POST) - upsert and emit dashboard update
app.post('/device/register', async (req, res) => {
    try {
        const d = req.body || {};
        const filter = {};
        if (d.deviceId) filter.deviceId = d.deviceId;
        else if (d.serialNumber) filter.serialNumber = d.serialNumber;

        const update = {
            deviceId: d.deviceId,
            serialNumber: d.serialNumber,
            model: d.model,
            androidVersion: d.androidVersion,
            sim1: d.sim1 || d.sim1Number || '',
            sim2: d.sim2 || d.sim2Number || '',
            battery: typeof d.battery === 'number' ? d.battery : (d.battery ? Number(d.battery) : 0),
            isOnline: typeof d.isOnline === 'boolean' ? d.isOnline : true,
            lastSeen: d.lastSeen ? new Date(d.lastSeen) : new Date(),
        };

        const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
        const device = await Device.findOneAndUpdate(filter, { $set: update, $setOnInsert: { registrationTimestamp: new Date() } }, opts);

        // Emit dashboard update via socket.io if available
        if (global.io) global.io.emit('dashboard-update');

        res.status(200).json({ message: 'Device upserted', device });
    } catch (error) {
        console.error('device/register error', error);
        res.status(500).send({ error: 'Server error' });
    }
});

// 4. API - Dashboard पर डेटा दिखाने के लिए (GET) -- इसके बिना डैशबोर्ड खाली दिखेगा
app.get('/api/devices', async (req, res) => {
    try {
        const devices = await Device.find();
        res.json(devices);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch devices" });
    }
});

// 5. API - Login (अगर आपका डैशबोर्ड लॉगिन मांग रहा है)
let adminPassword = process.env.ADMIN_PASSWORD || '1234';

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === "admin" && password === adminPassword) {
        res.json({ success: true, message: "Login successful" });
    } else {
        res.status(401).json({ success: false, message: "Wrong credentials" });
    }
});

// API - Change admin password (in-memory)
app.post('/api/change-password', (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.json({ success: false, message: 'Missing fields' });
    if (oldPassword === adminPassword) {
        adminPassword = newPassword;
        return res.json({ success: true, message: 'Password updated' });
    }
    return res.json({ success: false, message: 'Wrong Old Password' });
});

// 6. Root Route (चेक करने के लिए कि सर्वर चल रहा है या नहीं)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create HTTP server and attach socket.io
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
global.io = io;

// Create WebSocket Server and attach to HTTP server for raw WebSocket connections
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false,
    clientTracking: true
});

// Handle WebSocket connections for Android app
wss.on('connection', (ws) => {
    console.log('📱 WebSocket connected from Android app');
    
    let deviceId = null;
    
    ws.on('message', async (message) => {
        try {
            console.log('📨 WebSocket message received:', message);
            
            // Parse incoming device data
            const data = JSON.parse(message);
            
            // Save device data to database if it contains device information
            if (data.deviceId || data.serialNumber) {
                deviceId = data.deviceId;
                
                const filter = {};
                if (data.deviceId) filter.deviceId = data.deviceId;
                else if (data.serialNumber) filter.serialNumber = data.serialNumber;

                const update = {
                    deviceId: data.deviceId,
                    serialNumber: data.serialNumber,
                    model: data.model,
                    androidVersion: data.androidVersion,
                    sim1: data.sim1 || data.sim1Number || '',
                    sim2: data.sim2 || data.sim2Number || '',
                    battery: typeof data.battery === 'number' ? data.battery : (data.battery ? Number(data.battery) : 0),
                    isOnline: true,
                    lastSeen: new Date(),
                };

                const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
                const device = await Device.findOneAndUpdate(
                    filter, 
                    { $set: update, $setOnInsert: { registrationTimestamp: new Date() } }, 
                    opts
                );

                console.log('✅ Device saved:', device.deviceId);

                // Send confirmation back to Android app
                ws.send(JSON.stringify({ 
                    status: 'registered',
                    message: 'Device registered successfully',
                    deviceData: device
                }));

                // Emit dashboard update to all web clients
                if (global.io) {
                    global.io.emit('dashboard-update', { 
                        event: 'device-connected',
                        device: device,
                        timestamp: new Date()
                    });
                    console.log('📊 Dashboard update emitted for device:', deviceId);
                }
            } else {
                // Generic acknowledgement for other messages
                ws.send(JSON.stringify({ 
                    status: 'ok',
                    message: 'Message received'
                }));
            }
            
        } catch (err) {
            console.error('❌ Error processing message:', err);
            ws.send(JSON.stringify({ 
                status: 'error',
                message: err.message
            }));
        }
    });
    
    ws.on('close', async () => {
        console.log('📱 WebSocket disconnected:', deviceId);
        
        // Mark device as offline
        if (deviceId) {
            await Device.findOneAndUpdate(
                { deviceId },
                { $set: { isOnline: false, lastSeen: new Date() } },
                { new: true }
            );

            // Emit dashboard update when device disconnects
            if (global.io) {
                global.io.emit('dashboard-update', { 
                    event: 'device-disconnected',
                    deviceId: deviceId,
                    timestamp: new Date()
                });
                console.log('📊 Dashboard update emitted for device disconnection:', deviceId);
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
    });
});

// Handle server errors
server.on('clientError', (err, socket) => {
    console.error('❌ ClientError:', err.message);
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

io.on('connection', (socket) => {
    console.log('⚡ Socket connected:', socket.id);
    socket.on('disconnect', () => console.log('⚡ Socket disconnected:', socket.id));
});

// Port Settings for Railway
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});