'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireStateOwnership } = require('./state-ownership.cjs');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.releaseOwnership = acquireStateOwnership(dir);
    try {
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
      CREATE INDEX IF NOT EXISTS notifications_state ON notifications(state);
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS epay_orders (reference TEXT PRIMARY KEY, state TEXT NOT NULL,
        next_attempt INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS epay_due ON epay_orders(state, next_attempt);
      CREATE INDEX IF NOT EXISTS epay_operator_state ON epay_orders(state);
      CREATE TABLE IF NOT EXISTS epay_operator_reviews (
        id INTEGER PRIMARY KEY, reference TEXT NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS epay_operator_reviews_reference ON epay_operator_reviews(reference, id);`);
    } catch (error) {
      try { this.db?.close(); } finally { this.releaseOwnership(); }
      throw error;
    }
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
  epayReference(reference) {
    const row = this.db.prepare('SELECT body FROM epay_orders WHERE reference=?').get(reference);
    return row ? JSON.parse(row.body) : null;
  }
  saveEpay(q) {
    this.db.prepare(`INSERT INTO epay_orders VALUES (?,?,?,?) ON CONFLICT(reference) DO UPDATE
      SET state=excluded.state,next_attempt=excluded.next_attempt,body=excluded.body`)
      .run(q.reference, q.state, q.nextAttempt, JSON.stringify(q));
  }
  dueEpay(now, maxAttempts) {
    return this.db.prepare(`SELECT body FROM epay_orders WHERE state='PENDING'
      AND (next_attempt<=? OR json_extract(body, '$.attempts')>=?) ORDER BY next_attempt,rowid LIMIT 25`)
      .all(now, maxAttempts).map(r => JSON.parse(r.body));
  }
  epayReconcile() {
    return this.db.prepare("SELECT body FROM epay_orders WHERE state='RECONCILE' ORDER BY rowid DESC LIMIT 100")
      .all().map(r => JSON.parse(r.body));
  }
  epayOperationRows(state, prefix, before, limit) {
    return this.db.prepare(`SELECT q.rowid AS cursor, q.body, (
      SELECT r.body FROM epay_operator_reviews r WHERE r.reference=q.reference ORDER BY r.id DESC LIMIT 1
    ) AS review FROM epay_orders q WHERE q.state=? AND q.rowid<? AND q.reference>=? AND q.reference<?
    ORDER BY q.rowid DESC LIMIT ?`).all(state, before, prefix, prefix + '\uffff', limit)
      .map(r => ({ cursor: r.cursor, order: JSON.parse(r.body), review: r.review ? JSON.parse(r.review) : null }));
  }
  epayOperatorReviews(reference, before, limit) {
    return this.db.prepare('SELECT id,body FROM epay_operator_reviews WHERE reference=? AND id<? ORDER BY id DESC LIMIT ?')
      .all(reference, before, limit).map(row => ({ cursor: row.id, review: JSON.parse(row.body) }));
  }
  saveEpayOperatorReview(reference, review) {
    this.db.prepare('INSERT INTO epay_operator_reviews(reference,revision,body) VALUES (?,?,?)')
      .run(reference, review.revision, JSON.stringify(review));
  }
  notifications() { return this.db.prepare('SELECT body FROM notifications ORDER BY rowid').all().map(r => JSON.parse(r.body)); }
  notify(n) { this.db.prepare('INSERT INTO notifications VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body').run(n.id, n.state, JSON.stringify(n)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.releaseOwnership();
  }
}
module.exports = { Store };
