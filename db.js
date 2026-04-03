const mysql = require('mysql2');

const db = mysql.createConnection({
  host: "bzo5dzrhhqvnji3hxctx-mysql.services.clever-cloud.com",     // e.g., bxxxx-mysql.services.clever-cloud.com
  user: "uxg49lombgoyv4bt",     // The long username they gave you
  password: "N5fjILgQ3Qy8P9mD1KIx", // The secret password
  database: "bzo5dzrhhqvnji3hxctx",   // The database name
  port: 3306,
  ssl: { rejectUnauthorized: false }  // 🔒 Required for most cloud connections
});

db.connect((err) => {
  if (err) {
    console.error("❌ Cloud Connection Failed:", err.message);
  } else {
    console.log("✅ Connected to Clever Cloud (Paris)!");
  }
});

module.exports = db;