import crypto from 'node:crypto';
const GENESIS = '0'.repeat(64);
const h = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Append a hash-chained audit entry. Each row commits to the previous one. */
export function audit(db, { category = 'deal', actor, action, dealId = null, detail = {} }) {
  const ts = new Date().toISOString();
  const d = JSON.stringify(detail);
  const prev = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get()?.hash || GENESIS;
  const hash = h([prev, ts, category, actor, action, dealId ?? '', d].join('|'));
  db.prepare('INSERT INTO audit_log(ts,category,actor,action,deal_id,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?)')
    .run(ts, category, String(actor), action, dealId, d, prev, hash);
  return hash;
}

/** Recompute the chain; returns {ok, checked, brokenAt}. */
export function verifyAuditChain(db) {
  let prev = GENESIS, n = 0;
  for (const r of db.prepare('SELECT * FROM audit_log ORDER BY id').all()) {
    const exp = h([prev, r.ts, r.category, r.actor, r.action, r.deal_id ?? '', r.detail].join('|'));
    if (r.prev_hash !== prev || r.hash !== exp) return { ok: false, checked: n, brokenAt: r.id };
    prev = r.hash; n++;
  }
  return { ok: true, checked: n, brokenAt: null };
}

export const dealHistory = (db, dealId) =>
  db.prepare('SELECT ts,category,actor,action,detail FROM audit_log WHERE deal_id=? ORDER BY id').all(dealId);
export const staffActivity = (db, actor, limit = 15) =>
  db.prepare("SELECT ts,action,deal_id,detail FROM audit_log WHERE category='staff' AND actor=? ORDER BY id DESC LIMIT ?").all(String(actor), limit);
