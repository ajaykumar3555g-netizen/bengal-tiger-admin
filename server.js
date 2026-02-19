const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors'); // यह बहुत ज़रूरी है!
const path = require('path');

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

// 2. Device Schema (आपका वाला कोड)
const deviceSchema = new mongoose.Schema({
    serialNumber: { type: String, required: true, unique: true },
    model: String,
    androidVersion: String,
    sim1Number: String,
    sim2Number: String,
    registrationTimestamp: { type: Date, default: Date.now }
});
const Device = mongoose.model('Device', deviceSchema);

// 3. API - Android App से डेटा लेने के लिए (POST)
app.post('/device/register', async (req, res) => {
    try {
        const deviceInfoFromApp = req.body;
        const existingDevice = await Device.findOne({ serialNumber: deviceInfoFromApp.serialNumber });

        if (existingDevice) {
            await Device.updateOne({ serialNumber: deviceInfoFromApp.serialNumber }, deviceInfoFromApp);
            res.status(200).send({ message: 'Device info updated.' });
        } else {
            const newDevice = new Device(deviceInfoFromApp);
            await newDevice.save();
            res.status(201).send({ message: 'Device registered successfully.' });
        }
    } catch (error) {
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

// Port Settings for Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});