import { DemoProvider } from './demo.js';
import { ADAPTERS } from './live.js';
import { log } from '../logger.js';

/** Returns { provider, mode }. Live mode is only possible with a registered, configured adapter. */
export function selectProvider(cfg) {
  if (cfg.mode === 'live') {
    const make = ADAPTERS[cfg.provider.name];
    if (make) return { provider: make(cfg.provider), mode: 'live' };
    log.warn('Live mode requested but no adapter is registered for provider; falling back to DEMO', { provider: cfg.provider.name });
  }
  return { provider: new DemoProvider(), mode: 'demo' };
}
