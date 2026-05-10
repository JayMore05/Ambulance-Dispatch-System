const mysql = require('mysql');
require('dotenv').config();

// Create a connection pool with SSL support for Clever Cloud
const pool = mysql.createPool({
    connectionLimit: 3, // Reduced to 3 for Clever Cloud free tier (max 5)
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: {
        rejectUnauthorized: false // Required for Clever Cloud
    },
    waitForConnections: true,
    queueLimit: 0,
    acquireTimeout: 10000, // 10 seconds
    timeout: 60000 // 60 seconds
});

// Test connection on startup
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database connection failed:', err.code);
        if (err.code === 'PROTOCOL_CONNECTION_LOST') {
            console.error('Database connection was closed.');
        }
        if (err.code === 'ER_CON_COUNT_ERROR') {
            console.error('Database has too many connections.');
        }
        if (err.code === 'ECONNREFUSED') {
            console.error('Database connection was refused.');
        }
        if (err.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error('Access denied - check your credentials.');
        }
        return;
    }
    
    if (connection) {
        console.log('✅ Connected to Clever Cloud MySQL successfully.');
        connection.release();
    }
});

// Handle pool errors
pool.on('error', (err) => {
    console.error('❌ MySQL Pool Error:', err.message);
});

module.exports = pool;
