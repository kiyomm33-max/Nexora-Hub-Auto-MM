export class PollError extends Error {}
export function create(db, { channelId, hostId, question, options, endsAt, at = Date.now() }) {
  const clean = options.map((o) => String(o).trim()).filter(Boolean);
  if (clean.length < 2 || clean.length > 5) throw new PollError('A poll needs 2 to 5 options.');
  if (new Set(clean.map((o) => o.toLowerCase())).size !== clean.length) throw new PollError('Every option must be different.');
  const q = String(question).trim(); if (!q) throw new PollError('Add a question.');
  const id = Number(db.prepare('INSERT INTO polls(channel_id, host_id, question, options, ends_at, created_at) VALUES(?,?,?,?,?,?)')
    .run(channelId, hostId, q, JSON.stringify(clean), endsAt, new Date(at).toISOString()).lastInsertRowid);
  return get(db, id);
}
export const get = (db, id) => db.prepare('SELECT * FROM polls WHERE id=?').get(id);
export const setMessage = (db, id, mid) => db.prepare('UPDATE polls SET message_id=? WHERE id=?').run(mid, id);
export const remove = (db, id) => { db.prepare('DELETE FROM polls WHERE id=?').run(id); };
export const due = (db, at = Date.now()) => db.prepare("SELECT * FROM polls WHERE state='open' AND ends_at<=?").all(at);
export function tally(db, id) {
  const n = JSON.parse(get(db, id).options).length; const out = Array(n).fill(0);
  for (const r of db.prepare('SELECT choice, COUNT(*) AS c FROM poll_votes WHERE poll_id=? GROUP BY choice').all(id)) if (r.choice < n) out[r.choice] = Number(r.c);
  return out;
}
/** One vote per member. Same choice again removes it, another choice moves it. Returns 'added', 'changed' or 'removed'. */
export function vote(db, id, uid, choice) {
  const p = get(db, id); if (!p || p.state !== 'open') throw new PollError('This poll has ended.');
  if (!Number.isInteger(choice) || choice < 0 || choice >= JSON.parse(p.options).length) throw new PollError('Unknown option.');
  const cur = db.prepare('SELECT choice FROM poll_votes WHERE poll_id=? AND user_id=?').get(id, uid);
  if (cur?.choice === choice) { db.prepare('DELETE FROM poll_votes WHERE poll_id=? AND user_id=?').run(id, uid); return 'removed'; }
  db.prepare('INSERT INTO poll_votes(poll_id, user_id, choice) VALUES(?,?,?) ON CONFLICT(poll_id, user_id) DO UPDATE SET choice=excluded.choice').run(id, uid, choice);
  return cur ? 'changed' : 'added';
}
export function end(db, id) {
  if (!get(db, id)) throw new PollError('No poll with that ID.');
  if (!db.prepare("UPDATE polls SET state='ended' WHERE id=? AND state='open'").run(id).changes) throw new PollError('That poll has already ended.');
  return get(db, id);
}
