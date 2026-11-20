// Deal statistics and leaderboard rank, computed from completed deals only.
export const TIERS = [0, 100, 500, 2500, 10000, 50000]; // total dealt (USD) needed for Tier 1..6
const val = "CAST(COALESCE(NULLIF(receive_usd,''), amount) AS REAL)";

export function tierOf(total) {
  let t = 0; for (let k = 0; k < TIERS.length; k++) if (total >= TIERS[k]) t = k;
  return { tier: t + 1, next: t + 1 < TIERS.length ? +(TIERS[t + 1] - total).toFixed(2) : null };
}

export function userStats(db, userId) {
  const mine = `(party_a=@u OR party_b=@u)`;
  const done = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(${val}),0) total, COALESCE(MAX(${val}),0) largest FROM deals WHERE status='completed' AND ${mine}`).get({ u: userId });
  const closed = db.prepare(`SELECT COUNT(*) n FROM deals WHERE status IN ('completed','cancelled','disputed') AND ${mine}`).get({ u: userId });
  const totals = db.prepare(`SELECT u, SUM(v) t FROM (SELECT party_a u, ${val} v FROM deals WHERE status='completed' UNION ALL SELECT party_b u, ${val} v FROM deals WHERE status='completed' AND party_b IS NOT NULL) GROUP BY u`).all();
  const rank = done.n ? 1 + totals.filter((r) => r.t > done.total).length : null;
  return { completed: done.n, total: +done.total.toFixed(2), largest: +done.largest.toFixed(2), rate: closed.n ? Math.round((done.n / closed.n) * 100) : 100, rank, ...tierOf(done.total) };
}
