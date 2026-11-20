// Structured JSON logging with secret redaction.
const SECRET_KEYS = /token|secret|key|password|authorization|signature/i;
function redact(v, depth = 0) {
  if (depth > 4 || v == null) return v;
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[REDACTED]' : redact(x, depth + 1)]));
  }
  return v;
}
function emit(level, msg, ctx) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(ctx ? { ctx: redact(ctx) } : {}) });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}
export const log = {
  info: (m, c) => emit('info', m, c),
  warn: (m, c) => emit('warn', m, c),
  error: (m, c) => emit('error', m, c),
};
export { redact };
