import crypto from 'node:crypto';
// Header format: `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<rawBody>">`
export function sign(secret, rawBody, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
export function verify(secret, rawBody, header, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret || !header) return { ok: false, reason: 'missing' };
  const p = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=')));
  const t = Number(p.t);
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/.test(p.v1 || '')) return { ok: false, reason: 'malformed' };
  if (Math.abs(now / 1000 - t) > toleranceSec) return { ok: false, reason: 'stale' };
  const exp = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const got = Buffer.from(p.v1, 'hex');
  return crypto.timingSafeEqual(exp, got) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
