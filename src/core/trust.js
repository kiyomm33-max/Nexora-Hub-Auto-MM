// Trust tiers from verified trading volume. Everything is computed from the deals table: only live deals that finished
// (status completed requires the provider to have confirmed the funds) count, and each deal counts once per member.
export const TRUST_TIERS = [ // highest first
  { name: 'Sun', emoji: '☀️', min: 5000 }, { name: 'Jupiter', emoji: '🪐', min: 2000 }, { name: 'Saturn', emoji: '💍', min: 1000 },
  { name: 'Mars', emoji: '🔴', min: 500 }, { name: 'Venus', emoji: '🟡', min: 200 }, { name: 'Earth', emoji: '🌍', min: 50 },
  { name: 'Moon', emoji: '🌙', min: 1 }, { name: 'Pluto', emoji: '🌑', min: 0 },
];
const VERIFIED = "status='completed' AND mode='live' AND escrow_status='provider_confirmed'";

export function tierFor(volume) {
  const i = TRUST_TIERS.findIndex((t) => volume >= t.min); const tier = TRUST_TIERS[i];
  const next = i > 0 ? TRUST_TIERS[i - 1] : null;
  const progress = next ? Math.min(1, Math.max(0, (volume - tier.min) / (next.min - tier.min))) : 1;
  return { tier, next, progress, remaining: next ? +(next.min - volume).toFixed(2) : 0, max: !next };
}
export function trustOf(db, userId) {
  const r = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CAST(amount AS REAL)),0) v FROM deals WHERE ${VERIFIED} AND (party_a=@u OR party_b=@u) AND NOT EXISTS (SELECT 1 FROM deal_privacy p WHERE p.deal_id=deals.id AND p.user_id=@u AND p.hidden=1)`).get({ u: String(userId) });
  const volume = +Number(r.v).toFixed(2);
  return { trades: Number(r.n), volume, ...tierFor(volume) };
}
