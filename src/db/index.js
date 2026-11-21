import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS deals(
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('waiting_parties','awaiting_provider','verification_pending','disputed','completed','cancelled')),
  mode TEXT NOT NULL,
  party_a TEXT NOT NULL, party_b TEXT,
  roblox_a TEXT NOT NULL DEFAULT '', roblox_b TEXT NOT NULL DEFAULT '',
  item TEXT NOT NULL DEFAULT '', amount TEXT NOT NULL DEFAULT '0', currency TEXT NOT NULL DEFAULT 'USD',
  asset TEXT NOT NULL, network TEXT NOT NULL,
  deal_type TEXT, sender_id TEXT, receiver_id TEXT, desc_by TEXT,
  fee_usd TEXT NOT NULL DEFAULT '0', fee_payer TEXT, send_usd TEXT, receive_usd TEXT, pay_address TEXT,
  pay_amount TEXT, rate_usd TEXT, tx_hash TEXT, received_crypto TEXT, required_conf INTEGER NOT NULL DEFAULT 1,
  released_at TEXT, payout_address TEXT, payout_requested_at TEXT,
  release_at TEXT, release_by TEXT, setup TEXT NOT NULL DEFAULT '{}',
  confirmed_a INTEGER NOT NULL DEFAULT 0, confirmed_b INTEGER NOT NULL DEFAULT 0,
  channel_id TEXT, dispute_channel_id TEXT, status_message_id TEXT, completed_message_id TEXT,
  middleman_id TEXT,
  provider TEXT, provider_ref TEXT UNIQUE,
  escrow_status TEXT NOT NULL DEFAULT 'none' CHECK(escrow_status IN ('none','pending','provider_confirmed')),
  observed_status TEXT NOT NULL DEFAULT 'none' CHECK(observed_status IN ('none','seen','confirmed_on_chain')),
  confirmations INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  confirmed_at TEXT, completed_at TEXT, cancelled_at TEXT, disputed_at TEXT
);
CREATE TABLE IF NOT EXISTS webhook_events(
  event_id TEXT PRIMARY KEY, deal_id TEXT, type TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vouches(
  id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT NOT NULL REFERENCES deals(id),
  author TEXT NOT NULL, target TEXT NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(deal_id, author)
);
CREATE TABLE IF NOT EXISTS evidence(
  id INTEGER PRIMARY KEY AUTOINCREMENT, deal_id TEXT NOT NULL REFERENCES deals(id),
  author TEXT NOT NULL, note TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('support','dispute')), opener TEXT NOT NULL,
  deal_id TEXT, channel_id TEXT, subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at TEXT NOT NULL, closed_at TEXT, closed_by TEXT, transcript_sha256 TEXT
);
CREATE TABLE IF NOT EXISTS close_req(
  deal_id TEXT PRIMARY KEY, requested_by TEXT NOT NULL, message_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cancel_req(
  deal_id TEXT PRIMARY KEY, requested_by TEXT NOT NULL, agreed TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK(state IN ('asking','address','refunding')), address TEXT, message_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcripts(
  ticket_id TEXT PRIMARY KEY, body TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, category TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL, deal_id TEXT, detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_deal ON audit_log(deal_id);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_log(actor, category);
-- Append-only: history cannot be edited or deleted, even by code with DB access via the bot.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS webhook_no_update BEFORE UPDATE ON webhook_events BEGIN SELECT RAISE(ABORT,'webhook_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS webhook_no_delete BEFORE DELETE ON webhook_events BEGIN SELECT RAISE(ABORT,'webhook_events is append-only'); END;
-- A completed deal can never change status again.
CREATE TRIGGER IF NOT EXISTS deal_final BEFORE UPDATE OF status ON deals WHEN OLD.status IN ('completed','cancelled') AND NEW.status<>OLD.status
  BEGIN SELECT RAISE(ABORT,'deal is in a final state'); END;
CREATE TRIGGER IF NOT EXISTS deal_no_delete BEFORE DELETE ON deals BEGIN SELECT RAISE(ABORT,'deals cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS vouch_no_update BEFORE UPDATE ON vouches BEGIN SELECT RAISE(ABORT,'vouches are immutable'); END;
CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT,'evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT,'evidence is immutable'); END;
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // Idempotent column migration for databases created by earlier versions.
  const have = new Set(db.prepare('PRAGMA table_info(deals)').all().map((c) => c.name));
  const want = { deal_type: 'TEXT', sender_id: 'TEXT', receiver_id: 'TEXT', desc_by: 'TEXT', fee_usd: "TEXT NOT NULL DEFAULT '0'", fee_payer: 'TEXT', send_usd: 'TEXT', receive_usd: 'TEXT', pay_address: 'TEXT', pay_amount: 'TEXT', rate_usd: 'TEXT', tx_hash: 'TEXT', received_crypto: 'TEXT', short_state: 'TEXT', short_crypto: 'TEXT', short_votes: 'TEXT', required_conf: 'INTEGER NOT NULL DEFAULT 1', released_at: 'TEXT', payout_address: 'TEXT', payout_requested_at: 'TEXT', release_at: 'TEXT', release_by: 'TEXT', setup: "TEXT NOT NULL DEFAULT '{}'", completed_message_id: 'TEXT' };
  for (const [c, t] of Object.entries(want)) if (!have.has(c)) db.exec(`ALTER TABLE deals ADD COLUMN ${c} ${t}`);
  db.tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return db;
}
