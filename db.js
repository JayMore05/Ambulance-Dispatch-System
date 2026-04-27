const mysql = require('mysql');
require('dotenv').config();

// Create a connection pool instead of a single connection
const pool = mysql.createPool({
    connectionLimit: 4, // IMPORTANT: Set this to 4 (one less than your max of 5 to be safe)
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true, // If all connections are busy, wait in a queue
    queueLimit: 0 // No limit to the queue
});

// Test the pool connection when the server starts
pool.getConnection((err, connection) => {
    if (err) {
        if (err.code === 'PROTOCOL_CONNECTION_LOST') {
            console.error('Database connection was closed.');
        }
        if (err.code === 'ER_CON_COUNT_ERROR') {
            console.error('Database has too many connections.');
        }
        if (err.code === 'ECONNREFUSED') {
            console.error('Database connection was refused.');
        }
    }
    
    if (connection) {
        console.log('✅ Connected to MySQL Database Pool successfully.');
        connection.release(); // IMMEDIATELY release the connection back to the pool
    }
    return;
});

module.exports = pool;
