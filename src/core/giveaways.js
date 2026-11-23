import crypto from 'node:crypto';

const UNIT = { w: 604800e3, d: 86400e3, h: 3600e3, m: 60e3, s: 1e3 };
export class GiveawayError extends Error {}
/** "1d", "2h30m", "45m" -> milliseconds (1 minute to 30 days). */
export function parseDuration(s) {
  const t = String(s ?? '').toLowerCase().replace(/\s+/g, '');
  if (!/^(\d{1,4}[wdhms])+$/.test(t)) throw new GiveawayError('Duration looks like `30m`, `12h`, `1d` or `2d12h`.');
  const ms = [...t.matchAll(/(\d+)([wdhms])/g)].reduce((a, m) => a + Number(m[1]) * UNIT[m[2]], 0);
  if (ms < 60e3) throw new GiveawayError('The duration must be at least 1 minute.');
  if (ms > 30 * 86400e3) throw new GiveawayError('The duration can be at most 30 days.');
  return ms;
}
export function create(db, { channelId, hostId, prize, req, endsAt, at = Date.now() }) {
  const id = Number(db.prepare('INSERT INTO giveaways(channel_id, host_id, prize, req_kind, req_n, ends_at, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(channelId, hostId, prize, req?.kind ?? null, req?.n ?? null, endsAt, new Date(at).toISOString()).lastInsertRowid);
  return get(db, id);
}
export const get = (db, id) => db.prepare('SELECT * FROM giveaways WHERE id=?').get(id);
export const setMessage = (db, id, mid) => db.prepare('UPDATE giveaways SET message_id=? WHERE id=?').run(mid, id);
export const remove = (db, id) => { db.prepare('DELETE FROM giveaways WHERE id=?').run(id); };
export const entryCount = (db, id) => Number(db.prepare('SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id=?').get(id).c);
export const entrants = (db, id) => db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id=? ORDER BY rowid').all(id).map((r) => r.user_id);
export const hasEntered = (db, id, uid) => !!db.prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id=? AND user_id=?').get(id, uid);
export const enter = (db, id, uid) => db.prepare('INSERT OR IGNORE INTO giveaway_entries(giveaway_id, user_id) VALUES(?,?)').run(id, uid).changes === 1;
export const leave = (db, id, uid) => db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id=? AND user_id=?').run(id, uid).changes === 1;
export const due = (db, at = Date.now()) => db.prepare("SELECT * FROM giveaways WHERE state='open' AND ends_at<=?").all(at);
export function randomEntrant(db, id, { exclude = [] } = {}) {
  const all = db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id=?').all(id).map((r) => r.user_id).filter((u) => !exclude.includes(u));
  return all.length ? all[crypto.randomInt(all.length)] : null;
}
/** Ends an open giveaway once. The winner is always a random entrant (crypto.randomInt); staff cannot choose. */
export function end(db, id) {
  const g = get(db, id); if (!g) throw new GiveawayError('No giveaway with that ID.');
  const w = randomEntrant(db, id);
  const r = db.prepare("UPDATE giveaways SET state='ended', winner_id=? WHERE id=? AND state='open'").run(w, id);
  if (!r.changes) throw new GiveawayError('That giveaway has already ended.');
  return get(db, id);
}
export function reroll(db, id) {
  const g = get(db, id); if (!g) throw new GiveawayError('No giveaway with that ID.');
  if (g.state !== 'ended') throw new GiveawayError('That giveaway has not ended yet.');
  const w = randomEntrant(db, id, { exclude: [g.winner_id].filter(Boolean) });
  if (!w) throw new GiveawayError('There is nobody else who entered.');
  db.prepare('UPDATE giveaways SET winner_id=? WHERE id=?').run(w, id);
  return get(db, id);
}

/** Invite uses per inviter when the giveaway starts. Only uses above this baseline count as new invites. */
export function setBaseline(db, id, usesByUser) {
  const ins = db.prepare('INSERT OR REPLACE INTO giveaway_invites(giveaway_id, user_id, uses) VALUES(?,?,?)');
  for (const [u, n] of Object.entries(usesByUser)) ins.run(id, u, n);
}
export const newInvites = (db, id, uid, currentUses) =>
  Math.max(0, currentUses - Number(db.prepare('SELECT uses FROM giveaway_invites WHERE giveaway_id=? AND user_id=?').get(id, uid)?.uses ?? 0));
