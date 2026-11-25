// Lets staff switch the welcome message and the join ping off for a while. The end time is stored, so a restart does not bring them back early.
const KEYS = { welcome: 'pause.welcome', ping: 'pause.joinping' };
export const PAUSABLE = Object.keys(KEYS);
export const pausedUntil = (db, name) => { const v = db.prepare('SELECT value FROM kv WHERE key=?').get(KEYS[name])?.value; const t = Number(v); return t > Date.now() ? t : 0; };
export const isPaused = (db, name) => pausedUntil(db, name) > 0;
export function setPause(db, name, ms) {
  if (!KEYS[name]) throw new Error('unknown feature');
  if (ms == null) db.prepare('DELETE FROM kv WHERE key=?').run(KEYS[name]);
  else db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEYS[name], String(Date.now() + ms));
}
/** One-off: runs once per `tag`, so a deploy can start a pause without anyone typing a command. */
export function seedPause(db, tag, ms, names = PAUSABLE) {
  const k = `pause.seed.${tag}`; if (db.prepare('SELECT 1 FROM kv WHERE key=?').get(k)) return false;
  for (const n of names) setPause(db, n, ms);
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?)').run(k, new Date().toISOString());
  return true;
}
