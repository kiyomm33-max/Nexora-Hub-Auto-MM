import { DemoProvider } from './demo.js';
import { LtcWallet } from './ltc.js';
import { log } from '../logger.js';

/** Returns { provider, mode }. Live mode = self-custody LTC wallet; any failure to set it up falls back to demo. */
export function selectProvider(cfg, db) {
  if (cfg.mode === 'live') {
    try { return { provider: new LtcWallet(cfg, db), mode: 'live' }; }
    catch (e) { log.error('Live mode requested but the LTC wallet could not start; falling back to DEMO', { err: String(e.message ?? e) }); }
  }
  return { provider: new DemoProvider(), mode: 'demo' };
}
