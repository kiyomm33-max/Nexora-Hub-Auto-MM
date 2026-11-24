// Who invited whom. One row per invited member, so leaving and rejoining never counts twice.
export function recordJoin(db, inviteeId, inviterId, code, at = Date.now()) {
  if (inviteeId === inviterId) return false; // nobody gets credit for their own invite link
  const cur = db.prepare('SELECT inviter_id FROM invite_joins WHERE invitee_id=?').get(inviteeId);
  if (cur) { db.prepare('UPDATE invite_joins SET left_at=NULL WHERE invitee_id=?').run(inviteeId); return false; }
  db.prepare('INSERT INTO invite_joins(invitee_id, inviter_id, code, joined_at) VALUES(?,?,?,?)').run(inviteeId, inviterId, code ?? null, new Date(at).toISOString());
  return true;
}
export const recordLeave = (db, inviteeId, at = Date.now()) => db.prepare('UPDATE invite_joins SET left_at=? WHERE invitee_id=? AND left_at IS NULL').run(new Date(at).toISOString(), inviteeId).changes === 1;
export function stats(db, inviterId) {
  const r = db.prepare('SELECT COUNT(*) AS joined, COALESCE(SUM(left_at IS NOT NULL),0) AS left FROM invite_joins WHERE inviter_id=?').get(inviterId);
  const joined = Number(r.joined); const left = Number(r.left);
  return { joined, left, here: joined - left };
}
/** The invite that was used: the code whose use count went up, or a code that vanished (a last-use invite is deleted on use). */
export function usedInvite(before, after) {
  for (const [code, a] of Object.entries(after)) if (a.uses > (before[code]?.uses ?? 0)) return { code, inviter: a.inviter };
  const gone = Object.entries(before).filter(([code]) => !after[code]);
  return gone.length === 1 ? { code: gone[0][0], inviter: gone[0][1].inviter } : null;
}

/** Top inviters, ranked by people who are still in the server. Also returns the asker's own rank. */
export function leaderboard(db, { limit = 10, me } = {}) {
  const all = db.prepare('SELECT inviter_id id, COUNT(*) joined, COALESCE(SUM(left_at IS NOT NULL),0) AS gone FROM invite_joins GROUP BY inviter_id').all()
    .map((r) => ({ id: r.id, joined: Number(r.joined), left: Number(r.gone), here: Number(r.joined) - Number(r.gone) }))
    .sort((a, b) => b.here - a.here || b.joined - a.joined || (a.id < b.id ? -1 : 1));
  const k = me ? all.findIndex((r) => r.id === me) : -1;
  return { rows: all.slice(0, limit), people: all.length, total: all.reduce((n, r) => n + r.here, 0), me: k >= 0 ? { ...all[k], rank: k + 1 } : null };
}
