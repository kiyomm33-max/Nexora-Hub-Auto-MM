import http from 'node:http';
import { verify } from '../providers/signature.js';
import { RateLimiter } from '../core/ratelimit.js';
import { log } from '../logger.js';
import { audit } from '../core/audit.js';

const MAX_BODY = 64 * 1024;

export function createServer({ cfg, db, deals, mode, health = () => ({}) }) {
  const rl = new RateLimiter();
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/health') {
        db.prepare('SELECT 1').get();
        const h = health();
        return send(res, h.discordReady === false ? 503 : 200, { status: h.discordReady === false ? 'degraded' : 'ok', mode, ...h });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, `<!doctype html><meta charset=utf-8><title>Nexora Hub</title><body style="background:#0b0b0f;color:#fff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="color:#a35cff;letter-spacing:.1em">NEXORA HUB</h1><p>Automated middleman platform</p><p style="color:#a35cff">Mode: ${mode.toUpperCase()}${mode === 'demo' ? ' - no real funds' : ''}</p><p><a style="color:#888" href="/health">health</a></p></div>`, 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/provider') {
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
        if (!rl.check(`wh:${ip}`, 60, 60e3).ok) return send(res, 429, { error: 'rate_limited' });
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, { error: 'too_large' }); chunks.push(c); }
        const raw = Buffer.concat(chunks).toString('utf8');
        const v = verify(cfg.provider.webhookSecret, raw, req.headers['x-nexora-signature']);
        if (!v.ok) {
          audit(db, { category: 'security', actor: `ip:${ip}`, action: 'webhook.rejected', detail: { reason: v.reason } });
          log.warn('webhook rejected', { reason: v.reason });
          return send(res, 401, { error: 'invalid_signature' });
        }
        let ev; try { ev = JSON.parse(raw); } catch { return send(res, 400, { error: 'bad_json' }); }
        const r = deals.applyProviderEvent(ev, { simulated: mode === 'demo' });
        if (r.outcome === 'invalid') return send(res, 400, { error: 'invalid_event' });
        return send(res, 200, { received: true, outcome: r.outcome });
      }
      send(res, 404, { error: 'not_found' });
    } catch (e) {
      log.error('http handler error', e);
      send(res, 500, { error: 'internal' });
    }
  });
}
