const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db"); 

const app = express();
app.use(cors());
app.use(express.json());

const frontendPath = __dirname;
app.use(express.static(frontendPath));

app.get("/", (req, res) => res.sendFile(path.join(frontendPath, "index.html")));
app.get("/index.html", (req, res) => res.sendFile(path.join(frontendPath, "index.html")));
app.get("/driver.html", (req, res) => res.sendFile(path.join(frontendPath, "driver.html")));

const getKmDistance = (lat1, lon1, lat2, lon2) => {
    const rLat1 = parseFloat(lat1) || 0;
    const rLon1 = parseFloat(lon1) || 0;
    const rLat2 = parseFloat(lat2) || 0;
    const rLon2 = parseFloat(lon2) || 0;
    if (rLat1 === 0 || rLon1 === 0 || rLat2 === 0 || rLon2 === 0) return 0;

    const R = 6371; 
    const dLat = (rLat2 - rLat1) * Math.PI / 180; 
    const dLon = (rLon2 - rLon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rLat1 * Math.PI / 180) * Math.cos(rLat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))); 
};

const formatTime = (dateString) => dateString ? new Date(dateString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "N/A";

function processAndSort(rows, userLat, userLng) {
    return rows.map(h => {
        const distance = getKmDistance(userLat, userLng, h.latitude, h.longitude);
        return { ...h, distance_km: distance.toFixed(2) };
    }).sort((a, b) => a.distance_km - b.distance_km);
}

// ==========================================
// PATIENT ROUTES
// ==========================================

app.post("/api/save-user", (req, res) => {
    db.query("INSERT INTO users (name, phone, latitude, longitude) VALUES (?, ?, ?, ?)", [req.body.name, req.body.phone, req.body.latitude, req.body.longitude], (err, result) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        res.json({ success: true, user_id: result.insertId });
    });
});

app.get("/api/hospitals", (req, res) => {
    const { condition, ayushman_only, lat, lng } = req.query;

    // 🛡️ THE SAFETY NET: Guarantees hospitals show up even if the search fails
    const sendFallbackHospitals = () => {
        let fallbackSQL = "SELECT * FROM hospitals";
        if (ayushman_only === 'true') {
            fallbackSQL += " WHERE accepts_ayushman = 1 OR is_gov = 1";
        }
        db.query(fallbackSQL, (err, allHospitals) => {
            if (err || !allHospitals) return res.json({ hospitals: [] });
            res.json({ hospitals: processAndSort(allHospitals, lat, lng) });
        });
    };

    if (!condition) {
        return sendFallbackHospitals();
    }

    // Strips emojis so the database doesn't crash
    const cleanCondition = condition.replace(/[^a-zA-Z0-9 ]/g, "").trim();
    
    let query = `
        SELECT DISTINCT h.* FROM hospitals h 
        JOIN hospital_departments hd ON h.hospital_id = hd.hospital_id 
        WHERE hd.department LIKE ?
    `;
    let queryParams = [`%${cleanCondition}%`];

    if (ayushman_only === 'true') {
        query += " AND (h.accepts_ayushman = 1 OR h.is_gov = 1)";
    }

    db.query(query, queryParams, (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return sendFallbackHospitals();
        }
        res.json({ hospitals: processAndSort(rows, lat, lng) });
    });
});

app.post("/api/bookings", (req, res) => {
    const { user_id, hospital_id, emergency_type, ambulance_type, user_lat, user_lng, distance_km, rate_per_km } = req.body;
    db.query(`INSERT INTO bookings (user_id, hospital_id, emergency_category, ambulance_type, user_latitude, user_longitude, hospital_distance_km, price_per_km) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
    [user_id, hospital_id, emergency_type, ambulance_type, user_lat, user_lng, distance_km, rate_per_km], (err, result) => {
        if (err) return res.status(500).json({ error: "Booking Failed." });
        res.json({ booking_id: result.insertId });
    });
});

app.get("/api/user/eta", (req, res) => {
    db.query(`SELECT b.*, h.name AS hospital_name, dl.latitude AS dLat, dl.longitude AS dLng 
              FROM bookings b 
              LEFT JOIN driver_locations dl ON b.driver_id = dl.driver_id 
              JOIN hospitals h ON b.hospital_id = h.hospital_id 
              WHERE b.booking_id = ?`, [req.query.booking_id], (err, rows) => {
        
        if (err || !rows || rows.length === 0) return res.json({ status: 'SEARCHING' });
        
        const b = rows[0];

        if (b.status === 'REQUESTED') {
            return res.json({ status: 'SEARCHING', message: "Still looking for drivers..." });
        }

        const distKm = parseFloat(b.hospital_distance_km) || 0;
        const price = parseFloat(b.price_per_km) || 0;
        const totalCost = Math.ceil(distKm) * price; 

        if(b.status === 'COMPLETED') {
            return res.json({ status: 'COMPLETED', final_cost: totalCost, distance: distKm.toFixed(2), hospital: b.hospital_name });
        }

        const dist = (b.dLat && b.dLng) ? getKmDistance(b.dLat, b.dLng, b.user_latitude, b.user_longitude) : 0;
        res.json({ 
            status: b.status, 
            distance: dist.toFixed(2), 
            eta: dist > 0 ? Math.max(1, Math.round((dist / 40) * 60)) : "Calculating..." 
        });
    });
});

// ==========================================
// DRIVER ROUTES
// ==========================================

app.post("/api/driver/request-otp", (req, res) => {
    const { phone, isRegister } = req.body;
    db.query("SELECT * FROM drivers WHERE phone = ?", [phone], (err, drivers) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        if (isRegister && drivers.length > 0) return res.status(400).json({ error: "Phone already registered. Please Login." });
        if (!isRegister && drivers.length === 0) return res.status(400).json({ error: "Phone not found. Please Register." });
        
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        db.query("DELETE FROM driver_otps WHERE phone = ?", [phone], () => { 
            db.query("INSERT INTO driver_otps (phone, otp, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))", [phone, otp], (err) => {
                if (err) return res.status(500).json({ error: "Failed to create OTP" });
                res.json({ success: true, simulated_otp: otp });
            });
        });
    });
});

app.post("/api/driver/verify-otp", (req, res) => {
    const { phone, otp, isRegister, name, vehicle_num, ambulance_type } = req.body;
    db.query("SELECT * FROM driver_otps WHERE phone = ? AND otp = ? AND expires_at > NOW()", [phone, otp], (err, otps) => {
        if (err || !otps || otps.length === 0) return res.status(400).json({ error: "Invalid or expired OTP." });
        if (isRegister) {
            db.query("INSERT INTO drivers (name, phone, ambulance_number, ambulance_type, status) VALUES (?, ?, ?, ?, 'ONLINE')", [name, phone, vehicle_num, ambulance_type], (err, result) => {
                if (err) return res.status(500).json({ error: "Registration Failed" });
                res.json({ driver_id: result.insertId, name, phone, ambulance_type, ambulance_number: vehicle_num });
            });
        } else {
            db.query("SELECT * FROM drivers WHERE phone = ?", [phone], (err, drivers) => {
                if (err || drivers.length === 0) return res.status(400).json({ error: "Login failed" });
                db.query("UPDATE drivers SET status='ONLINE' WHERE driver_id=?", [drivers[0].driver_id]);
                res.json({ driver_id: drivers[0].driver_id, ...drivers[0] });
            });
        }
    });
});

app.post("/api/driver/toggle-status", (req, res) => {
    db.query("UPDATE drivers SET status=? WHERE driver_id=?", [req.body.status, req.body.driver_id], (err) => {
        res.json({ success: !err });
    });
});

app.post("/api/driver/update-profile", (req, res) => {
    db.query("UPDATE drivers SET name=?, phone=?, ambulance_number=?, ambulance_type=? WHERE driver_id=?", [req.body.name, req.body.phone, req.body.ambulance_number, req.body.ambulance_type, req.body.driver_id], (err) => {
        if (err) return res.status(500).json({ error: "Phone number might be in use." });
        res.json({ success: true });
    });
});

const activeQuery = `SELECT b.*, u.name AS user_name, u.phone AS user_phone, h.name AS hospital_name, h.latitude AS hosp_lat, h.longitude AS hosp_lng FROM bookings b JOIN users u ON b.user_id = u.user_id JOIN hospitals h ON b.hospital_id = h.hospital_id`;

app.get("/api/driver/active-mission", (req, res) => {
    db.query(`${activeQuery} WHERE b.driver_id = ? AND b.status IN ('ASSIGNED', 'IN_TRANSIT')`, [req.query.driver_id], (err, results) => {
        if (err || !results || results.length === 0) return res.json({ hasMission: false });
        res.json({ hasMission: true, mission: results[0] });
    });
});

app.get("/api/driver/radar", (req, res) => {
    db.query(`${activeQuery} WHERE b.status = 'REQUESTED' ORDER BY b.booked_at DESC`, (err, results) => {
        if (err) return res.status(500).json({ error: "Radar failed." });
        if (!results) results = [];

        const nearby = results.filter(b => getKmDistance(req.query.driverLat, req.query.driverLng, b.user_latitude, b.user_longitude) <= 8).map(b => {
            const dist = getKmDistance(req.query.driverLat, req.query.driverLng, b.user_latitude, b.user_longitude);
            return { 
                ...b, 
                priorityStar: (b.emergency_category.includes('Heart') && (req.query.driverType === 'ALS' || req.query.driverType === 'ECG')), 
                real_eta: Math.max(1, Math.round((dist / 40) * 60)), 
                formatted_time: formatTime(b.booked_at) 
            };
        });
        res.json({ bookings: nearby });
    });
});

app.post("/api/driver/accept", (req, res) => {
    db.query("SELECT * FROM bookings WHERE driver_id = ? AND status IN ('ASSIGNED', 'IN_TRANSIT')", [req.body.driver_id], (err, active) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        if (active && active.length > 0) return res.status(400).json({ error: "Finish your current trip first!" });
        
        db.query("UPDATE bookings SET driver_id = ?, status = 'ASSIGNED' WHERE booking_id = ? AND status = 'REQUESTED'", [req.body.driver_id, req.body.booking_id], (err, result) => {
            if (err) return res.status(500).json({ error: "Update Failed" });
            if (result.affectedRows === 0) return res.status(400).json({ error: "Too late! Another driver took this emergency." });
            res.json({ success: true });
        });
    });
});

app.post("/api/driver/pickup", (req, res) => {
    db.query("UPDATE bookings SET status='IN_TRANSIT', picked_up_at=CURRENT_TIMESTAMP WHERE booking_id=?", [req.body.booking_id], (err) => {
        res.json({ success: !err });
    });
});

app.post("/api/driver/complete", (req, res) => {
    db.query("UPDATE bookings SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE booking_id=?", [req.body.booking_id], (err) => {
        res.json({ success: !err });
    });
});

app.get("/api/driver/history", (req, res) => {
    db.query(`SELECT b.*, u.name AS user_name, h.name AS hospital_name FROM bookings b JOIN users u ON b.user_id = u.user_id JOIN hospitals h ON b.hospital_id = h.hospital_id WHERE b.driver_id = ? AND b.status = 'COMPLETED' ORDER BY b.completed_at DESC LIMIT 10`, [req.query.driver_id], (err, results) => {
        if (err) return res.json({ history: [] });
        if (!results) results = [];

        res.json({ history: results.map(h => {
            const distKm = parseFloat(h.hospital_distance_km) || 0;
            const price = parseFloat(h.price_per_km) || 0;
            return {
                ...h, 
                time_booked: formatTime(h.booked_at),
                time_picked: formatTime(h.picked_up_at),
                time_dropped: formatTime(h.completed_at),
                total_cost: Math.ceil(distKm) * price
            };
        })});
    });
});

app.listen(4000, () => console.log(`🚀 Flawless Server live on Port 4000`));
