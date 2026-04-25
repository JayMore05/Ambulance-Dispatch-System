require('dotenv').config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const webpush = require("web-push");
const db = require("./db"); 

const app = express();

// ==========================================================
// 🛡️ SECURITY & PERFORMANCE MIDDLEWARE
// ==========================================================
// Helmet secures HTTP headers (CSP disabled so Leaflet Maps load from CDNs)
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression()); // Gzip compresses API responses to save bandwidth
app.use(morgan('combined')); // Logs all requests
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Rate Limiting to prevent DDoS and Spam
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: "Too many requests" }});
const otpLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, message: { error: "Too many OTP requests" }});
app.use("/api/", apiLimiter);

// ==========================================================
// 🔐 JWT AUTH & WEB PUSH SETUP
// ==========================================================
const JWT_SECRET = process.env.JWT_SECRET || "fastrescue_super_secret_key";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails('mailto:admin@fastrescue.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

const adminAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Extracts Bearer <token>
    
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: "Invalid token" });
        next();
    });
};

async function pushNotify(subscriptionJson, title, body) {
    if (!subscriptionJson || !process.env.VAPID_PUBLIC_KEY) return;
    try {
        const sub = JSON.parse(subscriptionJson);
        await webpush.sendNotification(sub, JSON.stringify({ title, body }));
    } catch (e) { console.error("Push Error:", e.message); }
}

// ==========================================================
// 🛠️ UTILITY FUNCTIONS (Geospatial Math)
// ==========================================================
const getKmDistance = (lat1, lon1, lat2, lon2) => {
    const rLat1 = parseFloat(lat1) || 0, rLon1 = parseFloat(lon1) || 0, rLat2 = parseFloat(lat2) || 0, rLon2 = parseFloat(lon2) || 0;
    if (rLat1 === 0 || rLon1 === 0 || rLat2 === 0 || rLon2 === 0) return 999;
    
    const R = 6371; 
    const dLat = (rLat2 - rLat1) * Math.PI / 180;
    const dLon = (rLon2 - rLon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1 * Math.PI / 180) * Math.cos(rLat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))); 
};

function processAndSort(rows, userLat, userLng) {
    return rows.map(h => {
        const distance = getKmDistance(userLat, userLng, h.latitude, h.longitude);
        return { ...h, distance_km: parseFloat(distance.toFixed(2)) };
    }).filter(h => h.distance_km < 500).sort((a, b) => a.distance_km - b.distance_km);
}

const formatTime = (dateString) => {
    if (!dateString) return "N/A";
    return new Date(dateString).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
};

// ==========================================================
// 🏥 PATIENT SIDE APIS
// ==========================================================
app.get("/api/hospitals", (req, res) => {
    const { condition, ayushman_only, lat, lng } = req.query;
    const cleanCondition = condition ? condition.replace(/[^\x00-\x7F]/g, "").trim() : "";
    let query = `SELECT DISTINCT h.* FROM hospitals h INNER JOIN hospital_departments hd ON h.hospital_id = hd.hospital_id WHERE hd.department = ?`;
    
    if (ayushman_only === 'true') query += " AND (h.accepts_ayushman = 1 OR h.is_gov = 1)";

    db.query(query, [cleanCondition], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        if (rows.length === 0) {
            const fallbackSQL = `SELECT h.* FROM hospitals h INNER JOIN hospital_departments hd ON h.hospital_id = hd.hospital_id WHERE hd.department = 'General Sickness' ${ayushman_only === 'true' ? ' AND (h.accepts_ayushman = 1 OR h.is_gov = 1)' : ''}`;
            db.query(fallbackSQL, (err2, fallbackRows) => res.json({ hospitals: processAndSort(fallbackRows || [], lat, lng) }));
            return;
        }
        res.json({ hospitals: processAndSort(rows, lat, lng) });
    });
});

app.get("/api/hospitals/search", (req, res) => {
    const { term, lat, lng } = req.query;
    if (!term) return res.json({ hospitals: [] });
    const searchTerm = `%${term}%`;
    db.query(`SELECT * FROM hospitals WHERE name LIKE ? OR address LIKE ? LIMIT 15`, [searchTerm, searchTerm], (err, rows) => {
        if (err) return res.status(500).json({ error: "Search failed" });
        res.json({ hospitals: processAndSort(rows || [], lat, lng) });
    });
});

app.post("/api/save-user", (req, res) => {
    db.query("INSERT INTO users (name, phone, latitude, longitude) VALUES (?, ?, ?, ?)", [req.body.name, req.body.phone, req.body.latitude, req.body.longitude], (err, result) => {
        if (err) return res.status(500).json({ error: "User save failed: " + err.message });
        res.json({ success: true, user_id: result.insertId });
    });
});

app.post("/api/bookings", (req, res) => {
    const { user_id, hospital_id, custom_destination, emergency_type, ambulance_type, user_lat, user_lng, distance_km, rate_per_km } = req.body;
    db.query(`INSERT INTO bookings (user_id, hospital_id, custom_destination, emergency_category, ambulance_type, user_latitude, user_longitude, hospital_distance_km, price_per_km) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
    [user_id, hospital_id || null, custom_destination || null, emergency_type, ambulance_type, user_lat, user_lng, distance_km, rate_per_km], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ booking_id: result.insertId });
    });
});

app.post("/api/bookings/cancel", (req, res) => {
    db.query("UPDATE bookings SET status = 'CANCELLED' WHERE booking_id = ?", [req.body.booking_id], (err) => res.json({ success: !err }));
});

app.post("/api/bookings/update-destination", (req, res) => {
    const { booking_id, new_destination, new_distance } = req.body;
    let query = "UPDATE bookings SET hospital_id = NULL, custom_destination = ?";
    let params = [new_destination];
    if (new_distance) { query += ", hospital_distance_km = ?"; params.push(new_distance); }
    query += " WHERE booking_id = ?"; params.push(booking_id);
    db.query(query, params, (err) => res.json({ success: !err }));
});

app.get("/api/user/eta", (req, res) => {
    db.query(`SELECT b.*, COALESCE(b.custom_destination, h.name) AS hospital_name, d.latitude AS driver_lat, d.longitude AS driver_lng FROM bookings b LEFT JOIN hospitals h ON b.hospital_id = h.hospital_id LEFT JOIN drivers d ON b.driver_id = d.driver_id WHERE b.booking_id = ?`, [req.query.booking_id], (err, rows) => {
        if (err || !rows || rows.length === 0) return res.json({ status: 'SEARCHING' });
        
        const b = rows[0];
        if(b.status === 'COMPLETED') return res.json({ status: 'COMPLETED', final_cost: b.final_cost, distance: parseFloat(b.hospital_distance_km).toFixed(2), hospital: b.hospital_name });
        
        const distKm = parseFloat(b.hospital_distance_km) || 0;
        res.json({ status: b.status, distance: distKm.toFixed(2), eta: distKm > 0 ? Math.max(1, Math.round((distKm / 40) * 60)) : "Calculating...", hospital_name: b.hospital_name, driver_lat: b.driver_lat, driver_lng: b.driver_lng });
    });
});

app.get("/api/user/history", (req, res) => {
    db.query(`SELECT b.*, COALESCE(b.custom_destination, h.name) AS hospital_name FROM bookings b JOIN users u ON b.user_id = u.user_id LEFT JOIN hospitals h ON b.hospital_id = h.hospital_id WHERE u.phone = ? ORDER BY b.booked_at DESC LIMIT 10`, [req.query.phone], (err, results) => {
        if (err) return res.status(500).json({ error: "Failed" });
        res.json({ history: results || [] });
    });
});

// ==========================================================
// 🚑 DRIVER SIDE APIS
// ==========================================================
app.post("/api/driver/request-otp", otpLimiter, (req, res) => {
    const { phone, isRegister } = req.body;
    db.query("SELECT * FROM drivers WHERE phone = ?", [phone], (err, drivers) => {
        if (isRegister && drivers.length > 0) return res.status(400).json({ error: "Phone already registered." });
        if (!isRegister && drivers.length === 0) return res.status(400).json({ error: "Driver not found." });
        
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        db.query("DELETE FROM driver_otps WHERE phone = ?", [phone], () => { 
            db.query("INSERT INTO driver_otps (phone, otp, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))", [phone, otp], (err) => res.json({ success: true, simulated_otp: otp }));
        });
    });
});

app.post("/api/driver/verify-otp", (req, res) => {
    const { phone, otp, isRegister, name, vehicle_num, ambulance_type, aadhar_url, pcc_status, rc_url, insurance_url, puc_url } = req.body;
    db.query("SELECT * FROM driver_otps WHERE phone = ? AND otp = ? AND expires_at > NOW()", [phone, otp], (err, otps) => {
        if (err || !otps || otps.length === 0) return res.status(400).json({ error: "Invalid OTP." });
        
        if (isRegister) {
            db.query("INSERT INTO drivers (name, phone, ambulance_number, ambulance_type, aadhar_url, pcc_status, rc_url, insurance_url, puc_url, verification_status, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'OFFLINE')", 
            [name, phone, vehicle_num, ambulance_type, aadhar_url, pcc_status, rc_url, insurance_url, puc_url], (err, result) => {
                if(err) return res.status(500).json({error: "Registration failed."});
                res.json({ driver_id: result.insertId, verification_status: 'PENDING' });
            });
        } else {
            db.query("SELECT * FROM drivers WHERE phone = ?", [phone], (err, drivers) => {
                const drv = drivers[0];
                if (drv.verification_status !== 'APPROVED') return res.json({ driver_id: drv.driver_id, verification_status: drv.verification_status, rejection_reason: drv.rejection_reason });
                
                db.query("UPDATE drivers SET status='ONLINE' WHERE driver_id=?", [drv.driver_id]);
                res.json({ driver_id: drv.driver_id, verification_status: 'APPROVED', ...drv });
            });
        }
    });
});

app.get("/api/driver/check-status", (req, res) => {
    db.query("SELECT verification_status, rejection_reason FROM drivers WHERE driver_id = ?", [req.query.driver_id], (err, rows) => {
        if (err || rows.length === 0) return res.status(400).json({ error: "Not found" });
        res.json(rows[0]);
    });
});

app.post("/api/driver/update-profile", (req, res) => {
    const { driver_id, name, phone, ambulance_number, ambulance_type } = req.body;
    db.query("UPDATE drivers SET name=?, phone=?, ambulance_number=?, ambulance_type=? WHERE driver_id=?", [name, phone, ambulance_number, ambulance_type, driver_id], (err) => res.json({ success: !err }));
});

app.post("/api/driver/request-delete", (req, res) => {
    const { driver_id } = req.body;
    db.query(`SELECT * FROM bookings WHERE driver_id = ? AND status IN ('ASSIGNED', 'IN_TRANSIT')`, [driver_id], (err, rows) => {
        if (rows && rows.length > 0) return res.status(400).json({ error: "Cannot delete account: You have an active emergency!" });
        db.query("UPDATE drivers SET verification_status = 'DELETION_REQUESTED' WHERE driver_id = ?", [driver_id], (err) => res.json({ success: !err }));
    });
});

app.post("/api/driver/location", (req, res) => {
    const { driver_id, latitude, longitude } = req.body;
    db.query("UPDATE drivers SET latitude=?, longitude=? WHERE driver_id=?", [latitude, longitude, driver_id], (err) => res.json({ success: !err }));
});

const activeQuery = `SELECT b.*, u.name AS user_name, u.phone AS user_phone, COALESCE(b.custom_destination, h.name) AS hospital_name, h.latitude AS hosp_lat, h.longitude AS hosp_lng FROM bookings b JOIN users u ON b.user_id = u.user_id LEFT JOIN hospitals h ON b.hospital_id = h.hospital_id`;

app.get("/api/driver/active-mission", (req, res) => {
    db.query(`${activeQuery} WHERE b.driver_id = ? AND b.status IN ('ASSIGNED', 'IN_TRANSIT')`, [req.query.driver_id], (err, results) => {
        if (err || !results || results.length === 0) return res.json({ hasMission: false });
        res.json({ hasMission: true, mission: results[0] });
    });
});

app.get("/api/driver/radar", (req, res) => {
    db.query(`${activeQuery} WHERE b.status = 'REQUESTED' ORDER BY b.booked_at DESC`, (err, results) => {
        if (err) return res.status(500).json({ error: "Radar failed." });
        
        const driverType = req.query.driverType; 
        const nearby = (results || []).filter(b => {
            const dist = getKmDistance(req.query.driverLat, req.query.driverLng, b.user_latitude, b.user_longitude);
            return dist <= 15 && (b.ambulance_type === 'ANY' || b.ambulance_type === driverType);
        }).map(b => {
            const dist = getKmDistance(req.query.driverLat, req.query.driverLng, b.user_latitude, b.user_longitude);
            return { ...b, priorityStar: (b.emergency_category.includes('Heart') && (driverType === 'ALS' || driverType === 'ECG')), real_eta: Math.max(1, Math.round((dist / 40) * 60)), formatted_time: formatTime(b.booked_at) };
        });
        
        res.json({ bookings: nearby });
    });
});

// 🛡️ CONCURRENCY LOCK: Ensures two drivers can't claim the same trip
app.post("/api/driver/accept", (req, res) => {
    const { driver_id, booking_id } = req.body;
    const query = `UPDATE bookings SET driver_id = ?, status = 'ASSIGNED' WHERE booking_id = ? AND status = 'REQUESTED'`;
    
    db.query(query, [driver_id, booking_id], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: "Database error" });
        if (result.affectedRows === 0) {
            return res.json({ success: false, message: "Too late! Another driver accepted this emergency." });
        }
        res.json({ success: true, message: "Booking assigned to you!" });
    });
});

app.post("/api/driver/pickup", (req, res) => {
    db.query("UPDATE bookings SET status='IN_TRANSIT', picked_up_at=CURRENT_TIMESTAMP WHERE booking_id=?", [req.body.booking_id], (err) => res.json({ success: !err }));
});

app.post("/api/driver/complete", (req, res) => {
    const { booking_id, actual_distance } = req.body;
    db.query("SELECT price_per_km, hospital_distance_km FROM bookings WHERE booking_id = ?", [booking_id], (err, rows) => {
        if (err || rows.length === 0) return res.status(500).json({ error: "Booking not found" });
        
        const rate = parseFloat(rows[0].price_per_km) || 40;
        const distToUse = parseFloat(actual_distance) > 0.1 ? parseFloat(actual_distance) : parseFloat(rows[0].hospital_distance_km);
        const finalCost = Math.ceil(distToUse) * rate;
        
        db.query("UPDATE bookings SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP, hospital_distance_km=?, final_cost=? WHERE booking_id=?", 
        [distToUse, finalCost, booking_id], (err) => res.json({ success: !err, final_cost: finalCost }));
    });
});

app.get("/api/user/history", (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: "Phone required" });

    const query = `
        SELECT b.*, d.name as driver_name, d.ambulance_type, d.ambulance_number 
        FROM bookings b 
        LEFT JOIN drivers d ON b.driver_id = d.driver_id 
        WHERE b.patient_phone = ? 
        ORDER BY b.created_at DESC
    `;

    db.query(query, [phone], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, history: rows });
    });
});

// ==========================================================
// 🔔 WEB PUSH APIS
// ==========================================================
app.get("/api/push/vapid-key", (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe-patient", (req, res) => {
    db.query("UPDATE bookings SET push_subscription = ? WHERE booking_id = ?", [JSON.stringify(req.body.subscription), req.body.booking_id], (err) => res.json({ success: !err }));
});

app.post("/api/push/subscribe-driver", (req, res) => {
    db.query("UPDATE drivers SET push_subscription = ? WHERE driver_id = ?", [JSON.stringify(req.body.subscription), req.body.driver_id], (err) => res.json({ success: !err }));
});

// ==========================================================
// 🛡️ ADMIN APIS
// ==========================================================
app.post("/api/admin/login", (req, res) => {
    if (req.body.password === ADMIN_PASS) {
        res.json({ success: true, token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' }) });
    } else res.status(401).json({ success: false, error: "Invalid password" });
});

app.get("/api/admin/drivers", (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const query = `SELECT * FROM drivers ORDER BY verification_status DESC, driver_id DESC LIMIT ? OFFSET ?`;
    
    db.query(query, [limit, offset], (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json({ drivers: rows || [], page, limit });
    });
});

app.get("/api/admin/live-bookings", adminAuth, (req, res) => {
    db.query(`SELECT b.booking_id, b.status, b.emergency_category, b.ambulance_type, u.name AS patient_name, u.phone AS patient_phone, d.name AS driver_name, d.ambulance_number, COALESCE(b.custom_destination, h.name) AS destination FROM bookings b JOIN users u ON b.user_id = u.user_id LEFT JOIN drivers d ON b.driver_id = d.driver_id LEFT JOIN hospitals h ON b.hospital_id = h.hospital_id WHERE b.status IN ('REQUESTED', 'ASSIGNED', 'IN_TRANSIT') ORDER BY b.booked_at DESC`, (err, rows) => {
        res.json({ bookings: rows || [] });
    });
});

app.post("/api/admin/verify", adminAuth, (req, res) => {
    const { driver_id, status, reason } = req.body;
    db.query("UPDATE drivers SET verification_status = ?, rejection_reason = ? WHERE driver_id = ?", [status, reason || null, driver_id], (err) => {
        if (!err) {
            db.query("SELECT push_subscription, name FROM drivers WHERE driver_id=?", [driver_id], (e2, rows) => {
                if (!e2 && rows && rows[0]) {
                    const msg = status === 'APPROVED' ? `Welcome to FastRescue, ${rows[0].name}! You can now go online.` : `Your account was not approved. Please re-submit your documents.`;
                    pushNotify(rows[0].push_subscription, status === 'APPROVED' ? "✅ KYC Approved!" : "❌ KYC Rejected", msg);
                }
            });
        }
        res.json({ success: !err });
    });
});

app.post("/api/admin/approve-delete", adminAuth, (req, res) => {
    const { driver_id } = req.body;
    db.query("UPDATE drivers SET verification_status = 'DELETED', status = 'OFFLINE', phone = CONCAT(phone, '_DEL_', driver_id) WHERE driver_id = ?", [driver_id], (err) => res.json({ success: !err }));
});

// UptimeRobot Ping Route (Keeps Render Server Awake)
app.get("/ping", (req, res) => res.send("pong"));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Production Server live on Port ${PORT}`));
