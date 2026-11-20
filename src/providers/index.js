import { DemoProvider } from './demo.js';
import { MultiProvider } from './multi.js';
import { log } from '../logger.js';

/** Returns { provider, mode }. Live mode = self-custody wallets (LTC, EVM, SOL); any failure to set it up falls back to demo. */
export function selectProvider(cfg, db) {
  if (cfg.mode === 'live') {
    try { return { provider: new MultiProvider(cfg, db), mode: 'live' }; }
    catch (e) { log.error('Live mode requested but the wallets could not start; falling back to DEMO', { err: String(e.message ?? e) }); }
  }
  return { provider: new DemoProvider(), mode: 'demo' };
}
