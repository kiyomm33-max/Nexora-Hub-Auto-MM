// Trust tier roles: each member holds the role of their trust tier (from verified live deals, as sender or receiver).
// The highest tier wins; the other tier roles are removed, so members never stack Moon + Earth + Venus.
import { trustOf, TRUST_TIERS, trustUserIds } from '../core/trust.js';
import { log } from '../logger.js';

const warned = new Set();
const warnOnce = (k, m, c) => { if (!warned.has(k)) { warned.add(k); log.warn(m, c); } };

/** Brings one member's tier roles in line with their trust. Returns what changed. */
export async function syncTrustRoles(ctx, userId) {
  const map = ctx.cfg.trustRoles ?? {}; const ids = Object.values(map).filter(Boolean);
  if (!ids.length || !ctx.client?.guilds) return { added: [], removed: [] };
  const guild = await ctx.client.guilds.fetch(ctx.cfg.guildId).catch(() => null); if (!guild) return { added: [], removed: [] };
  const member = await guild.members.fetch(userId).catch(() => null); if (!member || member.user?.bot) return { added: [], removed: [] };
  const t = trustOf(ctx.db, userId);
  const want = t.volume >= 1 ? map[t.tier.name] : null; // below $1 there is no tier role
  const me = guild.members.me ?? await guild.members.fetchMe?.().catch(() => null);
  const out = { added: [], removed: [] };
  for (const id of ids) {
    const has = member.roles.cache.has(id);
    if (id === want && !has) {
      const role = guild.roles.cache.get(id) ?? await guild.roles.fetch(id).catch(() => null);
      if (!role) { warnOnce(`nf${id}`, 'trust role not found', { id }); continue; }
      if (role.position >= (me?.roles?.highest?.position ?? 0)) { warnOnce(`hi${id}`, 'trust role is above the bot role: move the bot role higher', { id }); continue; }
      try { await member.roles.add(role, `Trust tier ${t.tier.name}`); out.added.push(id); } catch (e) { log.warn('trust role add failed', { id, err: String(e?.message ?? e) }); }
    } else if (id !== want && has) {
      try { await member.roles.remove(id, 'Trust tier changed'); out.removed.push(id); } catch (e) { log.warn('trust role remove failed', { id, err: String(e?.message ?? e) }); }
    }
  }
  return out;
}

/** Everyone with a verified deal, one at a time to stay inside Discord's rate limits. */
export async function sweepTrustRoles(ctx, { pause = 300 } = {}) {
  let changed = 0; const users = trustUserIds(ctx.db);
  for (const uid of users) {
    const r = await syncTrustRoles(ctx, uid).catch((e) => { log.warn('trust role sync failed', { uid, err: String(e?.message ?? e) }); return { added: [], removed: [] }; });
    if (r.added.length || r.removed.length) { changed++; if (pause) await new Promise((res) => setTimeout(res, pause)); }
  }
  return { users: users.length, changed };
}
