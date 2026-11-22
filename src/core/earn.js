// Status rewards: time online with the status adds up; payouts are requests that staff pay by hand.
// The bot never sends money for these. All amounts are integer cents.
export const DAY_S = 86400; export const WEEK_S = 7 * 86400;
export const METHODS = { paypal: 'PayPal', ltc: 'Litecoin', sol: 'Solana', eth: 'Ethereum' };
const iso = (t) => new Date(t).toISOString();
const secs = (a, b) => Math.max(0, Math.floor((b - a) / 1000));

export const enroll = (db, uid, at = Date.now()) => db.prepare('INSERT OR IGNORE INTO status_earn(user_id, enrolled_at, seconds) VALUES(?,?,0)').run(uid, iso(at)).changes === 1;
export const enrolled = (db) => db.prepare('SELECT user_id FROM status_earn').all().map((r) => r.user_id);

/** The member qualifies right now (or not). Opens or closes the running interval. Returns 'started', 'stopped' or null. */
export function setQualifying(db, uid, q, at = Date.now()) {
  const row = db.prepare('SELECT seconds, since FROM status_earn WHERE user_id=?').get(uid);
  if (!row) return null;
  if (q && !row.since) { db.prepare('UPDATE status_earn SET since=? WHERE user_id=?').run(iso(at), uid); return 'started'; }
  if (!q && row.since) { db.prepare('UPDATE status_earn SET seconds=seconds+?, since=NULL WHERE user_id=?').run(secs(Date.parse(row.since), at), uid); return 'stopped'; }
  return null;
}
export const heartbeat = (db, at = Date.now()) => db.prepare("INSERT INTO kv(key, value) VALUES('status_heartbeat', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(at));
/** After a restart: intervals that were open end at the last heartbeat, so downtime never counts. */
export function closeStale(db) {
  const hb = Number(db.prepare("SELECT value FROM kv WHERE key='status_heartbeat'").get()?.value ?? 0);
  let n = 0;
  for (const r of db.prepare('SELECT user_id, since FROM status_earn WHERE since IS NOT NULL').all()) { setQualifying(db, r.user_id, false, Math.max(hb, Date.parse(r.since))); n++; }
  return n;
}

export const earnedCents = (seconds, pay) => Math.floor(seconds / DAY_S) * pay.dailyCents + Math.floor(seconds / WEEK_S) * pay.weekBonusCents;

export function summary(db, uid, pay, at = Date.now()) {
  const row = db.prepare('SELECT * FROM status_earn WHERE user_id=?').get(uid);
  if (!row) return { enrolled: false };
  const seconds = row.seconds + (row.since ? secs(Date.parse(row.since), at) : 0);
  const sum = (state) => Number(db.prepare('SELECT COALESCE(SUM(cents),0) AS c FROM status_payouts WHERE user_id=? AND state=?').get(uid, state).c);
  const earned = earnedCents(seconds, pay); const paid = sum('paid'); const pending = sum('pending');
  return { enrolled: true, counting: !!row.since, since: row.enrolled_at, seconds, days: Math.floor(seconds / DAY_S), weeks: Math.floor(seconds / WEEK_S),
    earned, paid, pending, available: Math.max(0, earned - paid - pending), nextDayIn: DAY_S - (seconds % DAY_S), nextWeekIn: WEEK_S - (seconds % WEEK_S) };
}

export class PayoutError extends Error {}
/** Reserve the whole available balance as a payout request. Transactional, so two clicks cannot reserve it twice. */
export function requestPayout(db, uid, { method, details, pay, at = Date.now() }) {
  if (!METHODS[method]) throw new PayoutError('Pick a payment method.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const s = summary(db, uid, pay, at);
    if (!s.enrolled) throw new PayoutError('Press Start Earning first.');
    if (s.available < pay.minPayoutCents) throw new PayoutError(`You need at least ${usd(pay.minPayoutCents)} to request a payout. You have ${usd(s.available)} available.`);
    const id = Number(db.prepare('INSERT INTO status_payouts(user_id, cents, method, details, created_at) VALUES(?,?,?,?,?)').run(uid, s.available, method, details, iso(at)).lastInsertRowid);
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM status_payouts WHERE id=?').get(id);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const getPayout = (db, id) => db.prepare('SELECT * FROM status_payouts WHERE id=?').get(id);
export function setPayoutMessage(db, id, channelId, messageId) { db.prepare('UPDATE status_payouts SET channel_id=?, message_id=? WHERE id=?').run(channelId, messageId, id); }
/** Staff outcome. Only a pending request can be handled, once. Rejecting returns the money to the member's balance. */
export function handlePayout(db, id, state, staffId, { ref = null, at = Date.now() } = {}) {
  if (!['paid', 'rejected'].includes(state)) throw new PayoutError('Invalid state.');
  const r = db.prepare("UPDATE status_payouts SET state=?, handled_by=?, handled_at=?, ref=? WHERE id=? AND state='pending'").run(state, staffId, iso(at), ref, id);
  if (!r.changes) throw new PayoutError('That request was already handled.');
  return getPayout(db, id);
}
export const pendingPayouts = (db) => db.prepare("SELECT * FROM status_payouts WHERE state='pending' ORDER BY id").all();

export const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
