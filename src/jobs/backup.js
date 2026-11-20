import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';
import { audit } from '../core/audit.js';

/** Consistent online snapshot using VACUUM INTO, then prune old snapshots. */
export function backupNow(db, dir, keep = 28) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `nexora-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = fs.readdirSync(dir).filter((f) => f.startsWith('nexora-') && f.endsWith('.sqlite')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, old));
  audit(db, { category: 'system', actor: 'system', action: 'backup.created', detail: { file: path.basename(file) } });
  log.info('backup created', { file });
  return file;
}
export function scheduleBackups(db, cfg) {
  const dir = path.join(cfg.dataDir, 'backups');
  const run = () => { try { backupNow(db, dir, cfg.backupKeep); } catch (e) { log.error('backup failed', e); } };
  run();
  return setInterval(run, cfg.backupIntervalHours * 3600e3).unref();
}
