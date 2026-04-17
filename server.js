const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db"); 

const app = express();
app.use(cors());
app.use(express.json());

const frontendPath = __dirname;
app.use(express.static(frontendPath));

// ---------------------------------------------------------
// 🛠️ UTILITY FUNCTIONS
// ---------------------------------------------------------

// 📏 Haversine Formula for Real-World GPS Distance
const getKmDistance = (lat1, lon1, lat2, lon2) => {
    const rLat1 = parseFloat(lat1) || 0;
    const rLon1 = parseFloat(lon1) || 0;
    const rLat2 = parseFloat(lat2) || 0;
    const rLon2 = parseFloat(lon2) || 0;
    if (rLat1 === 0 || rLon1 === 0 || rLat2 === 0 || rLon2 === 0) return 999;

    const R = 6371; 
    const dLat = (rLat2 - rLat1) * Math.PI / 180; 
    const dLon = (rLon2 - rLon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
              Math.cos(rLat1 * Math.PI / 180) * Math.cos(rLat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))); 
};

// 🎯 Strictly sorts by distance and filters nearby hospitals
function processAndSort(rows, userLat, userLng) {
    return rows.map(h => {
        const distance = getKmDistance(userLat, userLng, h.latitude, h.longitude);
        return { ...h, distance_km: parseFloat(distance.toFixed(2)) };
    })
    .filter(h => h.distance_km < 500) 
    .sort((a, b) => a.distance_km - b.distance_km);
}

// 🕒 Indian Standard Time (IST) Formatter
const formatTime = (dateString) => {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
};

// ---------------------------------------------------------
// 🏥 PATIENT SIDE APIS
// ---------------------------------------------------------

app.get("/api/hospitals", (req, res) => {
    const { condition, ayushman_only, lat, lng } = req.query;
    const cleanCondition = condition ? condition.replace(/[^\x00-\x7F]/g, "").trim() : "";
    
    let query = `SELECT DISTINCT h.* FROM hospitals h INNER JOIN hospital_departments hd ON h.hospital_id = hd.hospital_id WHERE hd.department = ?`;
    let queryParams = [cleanCondition];

    if (ayushman_only === 'true') {
        query += " AND (h.accepts_ayushman = 1 OR h.is_gov = 1)";
    }

    db.query(query, queryParams, (err, rows) => {
        if (err) return res.status(500).json({ error: "Database error" });

        if (rows.length === 0) {
            const fallbackSQL = `SELECT h.* FROM hospitals h INNER JOIN hospital_departments hd ON h.hospital_id = hd.hospital_id WHERE hd.department = 'General Sickness' ${ayushman_only === 'true' ? ' AND (h.accepts_ayushman = 1 OR h.is_gov = 1)' : ''}`;
            db.query(fallbackSQL, (err2, fallbackRows) => {
                res.json({ hospitals: processAndSort(fallbackRows || [], lat, lng) });
            });
            return;
        }
        res.json({ hospitals: processAndSort(rows, lat, lng) });
    });
});

// 🔥 NEW: Deep Database Search API
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
    db.query("INSERT INTO users (name, phone, latitude, longitude) VALUES (?, ?, ?, ?)", 
    [req.body.name, req.body.phone, req.body.latitude, req.body.longitude], (err, result) => {
        if (err) return res.status(500).json({ error: "User save failed" });
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
    db.query("UPDATE bookings SET hospital_id = NULL, custom_destination = ? WHERE booking_id = ?", [req.body.new_destination, req.body.booking_id], (err) => res.json({ success: !err }));
});

app.get("/api/user/eta", (req, res) => {
    db.query(`SELECT b.*, COALESCE(b.custom_destination, h.name) AS hospital_name FROM bookings b LEFT JOIN hospitals h ON b.hospital_id = h.hospital_id WHERE b.booking_id = ?`, [req.query.booking_id], (err, rows) => {
        if (err || !rows || rows.length === 0) return res.json({ status: 'SEARCHING' });
        
        const b = rows[0];
        
        // 🔥 PRICE SYNC: If completed, return the exact final_cost from the DB
        if(b.status === 'COMPLETED') {
            return res.json({ status: 'COMPLETED', final_cost: b.final_cost, distance: parseFloat(b.hospital_distance_km).toFixed(2), hospital: b.hospital_name });
        }

        const distKm = parseFloat(b.hospital_distance_km) || 0;
        res.json({ status: b.status, distance: distKm.toFixed(2), eta: distKm > 0 ? Math.max(1, Math.round((distKm / 40) * 60)) : "Calculating...", hospital_name: b.hospital_name });
    });
});

// ---------------------------------------------------------
// 🚑 DRIVER SIDE APIS
// ---------------------------------------------------------

app.post("/api/driver/request-otp", (req, res) => {
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

// 🔥 NEW: Verification Status checks added here and KYC saves
app.post("/api/driver/verify-otp", (req, res) => {
    const { phone, otp, isRegister, name, vehicle_num, ambulance_type, aadhar_url, pcc_status, rc_url, insurance_url, puc_url } = req.body;
    
    db.query("SELECT * FROM driver_otps WHERE phone = ? AND otp = ? AND expires_at > NOW()", [phone, otp], (err, otps) => {
        if (err || !otps || otps.length === 0) return res.status(400).json({ error: "Invalid OTP." });
        
        if (isRegister) {
            // New driver -> set to PENDING, save all KYC URLs
            db.query("INSERT INTO drivers (name, phone, ambulance_number, ambulance_type, aadhar_url, pcc_status, rc_url, insurance_url, puc_url, verification_status, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'OFFLINE')", 
            [name, phone, vehicle_num, ambulance_type, aadhar_url, pcc_status, rc_url, insurance_url, puc_url], (err, result) => {
                if(err) return res.status(500).json({error: "Registration failed."});
                res.json({ driver_id: result.insertId, verification_status: 'PENDING' });
            });
        } else {
            db.query("SELECT * FROM drivers WHERE phone = ?", [phone], (err, drivers) => {
                const drv = drivers[0];
                if (drv.verification_status !== 'APPROVED') return res.json({ driver_id: drv.driver_id, verification_status: drv.verification_status });
                
                db.query("UPDATE drivers SET status='ONLINE' WHERE driver_id=?", [drv.driver_id]);
                res.json({ driver_id: drv.driver_id, verification_status: 'APPROVED', ...drv });
            });
        }
    });
});

app.post("/api/driver/update-profile", (req, res) => {
    const { driver_id, name, phone, ambulance_number, ambulance_type } = req.body;
    db.query("UPDATE drivers SET name=?, phone=?, ambulance_number=?, ambulance_type=? WHERE driver_id=?", 
    [name, phone, ambulance_number, ambulance_type, driver_id], (err) => {
        if (err) return res.status(500).json({ error: "Update failed" });
        res.json({ success: true });
    });
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
            // 🔥 STRICT FILTER: Must be within 15km AND (Patient chose 'ANY' OR exact type matches)
            const typeMatches = (b.ambulance_type === 'ANY' || b.ambulance_type === driverType);
            return dist <= 15 && typeMatches;
        }).map(b => {
            const dist = getKmDistance(req.query.driverLat, req.query.driverLng, b.user_latitude, b.user_longitude);
            return { 
                ...b, 
                priorityStar: (b.emergency_category.includes('Heart') && (driverType === 'ALS' || driverType === 'ECG')), 
                real_eta: Math.max(1, Math.round((dist / 40) * 60)), 
                formatted_time: formatTime(b.booked_at) 
            };
        });
        
        res.json({ bookings: nearby });
    });
});

app.post("/api/driver/accept", (req, res) => {
    db.query("UPDATE bookings SET driver_id = ?, status = 'ASSIGNED' WHERE booking_id = ? AND status = 'REQUESTED'", 
    [req.body.driver_id, req.body.booking_id], (err, result) => {
        if (err || result.affectedRows === 0) return res.status(400).json({ error: "Emergency already taken." });
        res.json({ success: true });
    });
});

app.post("/api/driver/pickup", (req, res) => {
    db.query("UPDATE bookings SET status='IN_TRANSIT', picked_up_at=CURRENT_TIMESTAMP WHERE booking_id=?", [req.body.booking_id], (err) => {
        res.json({ success: !err });
    });
});

// 🔥 NEW: Server calculates exact math to fix mismatch
app.post("/api/driver/complete", (req, res) => {
    const { booking_id, actual_distance } = req.body;
    
    // Fetch the rate the patient originally agreed to
    db.query("SELECT price_per_km FROM bookings WHERE booking_id = ?", [booking_id], (err, rows) => {
        if (err || rows.length === 0) return res.status(500).json({ error: "Booking not found" });
        
        const rate = parseFloat(rows[0].price_per_km) || 40;
        const finalCost = Math.ceil(parseFloat(actual_distance)) * rate;

        // Save the exact final cost into the database
        db.query("UPDATE bookings SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP, hospital_distance_km=?, final_cost=? WHERE booking_id=?", 
        [actual_distance, finalCost, booking_id], (err) => res.json({ success: !err, final_cost: finalCost }));
    });
});

app.get("/api/driver/history", (req, res) => {
    db.query(`SELECT b.*, u.name AS user_name, COALESCE(b.custom_destination, h.name) AS hospital_name FROM bookings b JOIN users u ON b.user_id = u.user_id LEFT JOIN hospitals h ON b.hospital_id = h.hospital_id WHERE b.driver_id = ? AND b.status = 'COMPLETED' ORDER BY b.completed_at DESC LIMIT 10`, [req.query.driver_id], (err, results) => {
        if (err) return res.json({ history: [] });
        res.json({ history: (results || []).map(h => ({ 
            ...h, 
            time_booked: formatTime(h.booked_at), 
            time_picked: formatTime(h.picked_up_at), 
            time_dropped: formatTime(h.completed_at), 
            total_cost: h.final_cost // Using the exact final cost from DB
        }))});
    });
});

app.post("/api/driver/toggle-status", (req, res) => res.json({ success: true }));

// ---------------------------------------------------------
// 🛡️ ADMIN APIS
// ---------------------------------------------------------
app.get("/api/admin/drivers", (req, res) => {
    db.query("SELECT * FROM drivers ORDER BY verification_status DESC, driver_id DESC", (err, rows) => {
        res.json({ drivers: rows || [] });
    });
});

app.post("/api/admin/verify", (req, res) => {
    db.query("UPDATE drivers SET verification_status = ? WHERE driver_id = ?", [req.body.status, req.body.driver_id], (err) => {
        res.json({ success: !err });
    });
});

app.listen(4000, () => console.log(`🚀 Production Server live on Port 4000`));
