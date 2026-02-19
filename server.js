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
const wss = new WebSocket.Server({ server });

// Handle WebSocket connections for Android app
wss.on('connection', (ws) => {
    console.log('📱 WebSocket connected from Android app');
    
    ws.on('message', (message) => {
        console.log('📨 WebSocket message received:', message);
        // Broadcast to all connected clients
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ 
                    status: 'ok',
                    message: 'Message received'
                }));
            }
        });
    });
    
    ws.on('close', () => {
        console.log('📱 WebSocket disconnected');
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
    });
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