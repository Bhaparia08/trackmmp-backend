const path = require('path');
const fs = require('fs');
require('dotenv').config();

const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './data/tracking.db';
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migrations: add new columns to existing tables without dropping data
const migrations = [
  // users table new columns
  `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`,
  `ALTER TABLE users ADD COLUMN company_name TEXT`,
  `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE users ADD COLUMN created_by INTEGER REFERENCES users(id)`,
  // campaigns table
  `ALTER TABLE campaigns ADD COLUMN advertiser_id INTEGER REFERENCES users(id)`,
  // publishers table
  `ALTER TABLE publishers ADD COLUMN publisher_user_id INTEGER REFERENCES users(id)`,
];

for (const sql of migrations) {
  try { db.exec(sql); } catch (e) {
    // Column already exists — safe to ignore
    if (!e.message.includes('duplicate column')) throw e;
  }
}

module.exports = db;
