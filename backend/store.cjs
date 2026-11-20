'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
    this.ownerFile = path.join(dir, "owner.lock");
    this.owner = JSON.stringify({ pid: process.pid, nonce: crypto.randomBytes(16).toString("hex") });
    try { fs.writeFileSync(this.ownerFile, this.owner, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code === "EEXIST") throw new Error("STATE_DIRECTORY_LOCKED: stop its owner; after a crash verify PID before removing owner.lock"); throw error; }
    this.db = new DatabaseSync(path.join(dir, 'merchant.sqlite'));
    fs.chmodSync(path.join(dir, 'merchant.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE,
        public_token TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deposits (event_id TEXT PRIMARY KEY, order_id TEXT NOT NULL,
        block_number INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS deposits_order ON deposits(order_id);
      CREATE TABLE IF NOT EXISTS anchors (number INTEGER PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  }
  secret(name) {
    const file = path.join(this.dir, name + '.secret');
    try { fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return fs.readFileSync(file, 'utf8').trim();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value));
  }
  orders() { return this.db.prepare('SELECT body FROM orders ORDER BY rowid DESC').all().map(r => JSON.parse(r.body)); }
  order(id) { const r = this.db.prepare('SELECT body FROM orders WHERE id=?').get(id); return r ? JSON.parse(r.body) : null; }
  publicOrder(token) { const r = this.db.prepare('SELECT body FROM orders WHERE public_token=?').get(token); return r ? JSON.parse(r.body) : null; }
  reference(ref) { const r = this.db.prepare('SELECT body FROM orders WHERE reference=?').get(ref); return r ? JSON.parse(r.body) : null; }
  saveOrder(o) {
    this.db.prepare(`INSERT INTO orders VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`)
      .run(o.id, o.reference, o.publicToken, JSON.stringify(o));
  }
  deposits(id) { return this.db.prepare('SELECT body FROM deposits WHERE order_id=? ORDER BY block_number,event_id').all(id).map(r => JSON.parse(r.body)); }
  deposit(d) {
    this.db.prepare('INSERT OR IGNORE INTO deposits VALUES (?,?,?,?)').run(d.eventId, d.orderId, d.blockNumber, JSON.stringify(d));
  }
  rollbackAfter(number) {
    this.db.prepare('DELETE FROM deposits WHERE block_number>?').run(number);
    this.db.prepare('DELETE FROM anchors WHERE number>?').run(number);
    this.set('cursor', number);
  }
  anchors() { return this.db.prepare('SELECT * FROM anchors ORDER BY number DESC').all(); }
  anchor(number, hash) {
    this.db.prepare('INSERT OR REPLACE INTO anchors VALUES (?,?)').run(number, hash);
    this.db.prepare('DELETE FROM anchors WHERE number < ?').run(number - 256);
  }
  jobs() { return this.db.prepare('SELECT body FROM jobs ORDER BY rowid DESC').all().map(r => JSON.parse(r.body)); }
  job(id) { const r = this.db.prepare('SELECT body FROM jobs WHERE id=?').get(id); return r ? JSON.parse(r.body) : null; }
  saveJob(j) { this.db.prepare('INSERT INTO jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body').run(j.id, j.state, JSON.stringify(j)); }
  handoff(id) { const r = this.db.prepare('SELECT body FROM handoffs WHERE id=?').get(id); return r ? JSON.parse(r.body) : null; }
  saveHandoff(h) { this.db.prepare('INSERT INTO handoffs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(h.id, JSON.stringify(h)); }
  notifications() { return this.db.prepare('SELECT body FROM notifications ORDER BY rowid').all().map(r => JSON.parse(r.body)); }
  notify(n) { this.db.prepare('INSERT INTO notifications VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body').run(n.id, n.state, JSON.stringify(n)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    if (fs.readFileSync(this.ownerFile, "utf8") === this.owner) fs.unlinkSync(this.ownerFile);
  }
}
module.exports = { Store };
