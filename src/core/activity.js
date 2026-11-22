// Message counts and "server tag / status" tracking. Pure database logic; the Discord side lives in discord/activity.js.
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const iso = (d) => new Date(d).toISOString();

export const PERIODS = { today: 1, week: 7, month: 30, all: null };
export const PERIOD_LABEL = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', all: 'All time' };

export function countMessage(db, userId, at = Date.now()) {
  db.prepare('INSERT INTO msg_counts(user_id, day, n) VALUES(?,?,1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1').run(userId, dayOf(at));
}
const since = (period, at) => (PERIODS[period] ? dayOf(at - (PERIODS[period] - 1) * 86400e3) : '0000-01-01');

export function leaderboard(db, period = 'all', { limit = 10, at = Date.now() } = {}) {
  const from = since(period, at);
  const rows = db.prepare('SELECT user_id, SUM(n) AS n FROM msg_counts WHERE day >= ? GROUP BY user_id ORDER BY n DESC, user_id LIMIT ?').all(from, limit);
  const total = db.prepare('SELECT COALESCE(SUM(n),0) AS n, COUNT(DISTINCT user_id) AS people FROM msg_counts WHERE day >= ?').get(from);
  return { rows: rows.map((r) => ({ user_id: r.user_id, n: Number(r.n) })), total: Number(total.n), people: Number(total.people) };
}
export function userMessages(db, userId, at = Date.now()) {
  const sum = (p) => Number(db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM msg_counts WHERE user_id=? AND day >= ?').get(userId, since(p, at)).n);
  const all = sum('all');
  const rank = all ? Number(db.prepare('SELECT COUNT(*) AS c FROM (SELECT user_id, SUM(n) AS t FROM msg_counts GROUP BY user_id) WHERE t > ?').get(all).c) + 1 : null;
  const first = db.prepare('SELECT MIN(day) AS d FROM msg_counts WHERE user_id=?').get(userId).d;
  return { today: sum('today'), week: sum('week'), month: sum('month'), all, rank, since: first };
}
export const trackingSince = (db) => db.prepare('SELECT MIN(day) AS d FROM msg_counts').get().d;

/** Open or close a tag/status session for one member. Idempotent: returns 'started', 'ended' or null (nothing changed). */
export function setPerk(db, userId, kind, active, { at = Date.now(), reason = 'removed' } = {}) {
  const open = db.prepare('SELECT id FROM perk_sessions WHERE user_id=? AND kind=? AND ended_at IS NULL').get(userId, kind);
  if (active && !open) { db.prepare('INSERT INTO perk_sessions(user_id, kind, started_at) VALUES(?,?,?)').run(userId, kind, iso(at)); return 'started'; }
  if (!active && open) { db.prepare('UPDATE perk_sessions SET ended_at=?, end_reason=? WHERE id=?').run(iso(at), reason, open.id); return 'ended'; }
  return null;
}
export const openPerks = (db, kind) => db.prepare('SELECT user_id FROM perk_sessions WHERE kind=? AND ended_at IS NULL').all(kind).map((r) => r.user_id);

export function perkSummary(db, userId, kind, at = Date.now()) {
  const rows = db.prepare('SELECT started_at, ended_at FROM perk_sessions WHERE user_id=? AND kind=? ORDER BY id').all(userId, kind);
  let ms = 0; let active = null; let longest = 0;
  for (const r of rows) {
    const end = r.ended_at ? Date.parse(r.ended_at) : at; const len = Math.max(0, end - Date.parse(r.started_at));
    ms += len; longest = Math.max(longest, len); if (!r.ended_at) active = r.started_at;
  }
  return { times: rows.length, totalMs: ms, longestMs: longest, active, first: rows[0]?.started_at ?? null, last: rows.length ? (rows.at(-1).ended_at ?? null) : null };
}
/** Everyone who ever used it, longest total time first. */
export function perkBoard(db, kind, { limit = 15, at = Date.now() } = {}) {
  const users = db.prepare('SELECT DISTINCT user_id FROM perk_sessions WHERE kind=?').all(kind).map((r) => r.user_id);
  const rows = users.map((u) => ({ user_id: u, ...perkSummary(db, u, kind, at) })).sort((a, b) => b.totalMs - a.totalMs || b.times - a.times);
  return { rows: rows.slice(0, limit), everyone: rows.length, activeNow: rows.filter((r) => r.active).length };
}

export function duration(ms) {
  const s = Math.floor(ms / 1000); if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

/** 1-based rank of a user for a period, or null when they have no messages in it. */
export function userRank(db, userId, period = 'all', at = Date.now()) {
  const from = since(period, at);
  const mine = Number(db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM msg_counts WHERE user_id=? AND day >= ?').get(userId, from).n);
  if (!mine) return null;
  return Number(db.prepare('SELECT COUNT(*) AS c FROM (SELECT SUM(n) AS t FROM msg_counts WHERE day >= ? GROUP BY user_id) WHERE t > ?').get(from, mine).c) + 1;
}
