const mysql = require('mysql2');
require('dotenv').config();

// 🛡️ Create a "Pool" instead of a single connection. 
// This automatically keeps the connection alive and reconnects if Clever Cloud drops it!
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,     // ✅ THIS PREVENTS THE "CLOSED STATE" ERROR
    keepAliveInitialDelay: 0
});

// Test the connection when the server starts
db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database Connection Failed:', err.message);
    } else {
        console.log('✅ Successfully connected to Clever Cloud MySQL (Pool Active)!');
        connection.release(); // Release it back to the pool so others can use it
    }
});

// Export the pool so server.js can use it seamlessly
module.exports = db;
