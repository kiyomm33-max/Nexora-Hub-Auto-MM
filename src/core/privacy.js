// Members can hide their name on completed-deal posts. Hidden members show as "Anonymous".
export const ANON = 'Anonymous';
export const isHidden = (db, userId) => !!db.prepare('SELECT hidden FROM user_privacy WHERE user_id=?').get(userId)?.hidden;
export function setHidden(db, userId, hidden) {
  db.prepare('INSERT INTO user_privacy(user_id, hidden, updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET hidden=excluded.hidden, updated_at=excluded.updated_at').run(userId, hidden ? 1 : 0, new Date().toISOString());
  return !!hidden;
}
