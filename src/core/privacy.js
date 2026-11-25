// Members can hide their name on completed-deal posts. Hidden members show as "Anonymous".
export const ANON = 'Anonymous';
export const isHidden = (db, userId) => !!db.prepare('SELECT hidden FROM user_privacy WHERE user_id=?').get(userId)?.hidden;
export function setHidden(db, userId, hidden) {
  db.prepare('INSERT INTO user_privacy(user_id, hidden, updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET hidden=excluded.hidden, updated_at=excluded.updated_at').run(userId, hidden ? 1 : 0, new Date().toISOString());
  return !!hidden;
}

/** Per-deal choice made on the Deal complete card: true = keep anonymous, false = show on profile, null = not chosen. */
export function dealChoice(db, dealId, userId) { const r = db.prepare('SELECT hidden FROM deal_privacy WHERE deal_id=? AND user_id=?').get(dealId, userId); return r ? !!r.hidden : null; }
export function setDealChoice(db, dealId, userId, hidden) {
  db.prepare('INSERT INTO deal_privacy(deal_id,user_id,hidden,at) VALUES(?,?,?,?) ON CONFLICT(deal_id,user_id) DO UPDATE SET hidden=excluded.hidden, at=excluded.at').run(dealId, userId, hidden ? 1 : 0, new Date().toISOString());
}
/** Whether this member's name and volume stay out of public places for this deal: their choice, else their saved setting. */
export const hiddenFor = (db, dealId, userId) => dealChoice(db, dealId, userId) ?? isHidden(db, userId);
