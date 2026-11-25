// Gives every member one role: new joiners the moment they arrive, and everyone already here once at startup.
import { log } from '../logger.js';

const RISKY = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers', 'ModerateMembers', 'MentionEveryone'];

/** Returns the role when it is safe to hand out to everyone, else null (and logs why). */
export async function usableRole(guild, roleId) {
  const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
  if (!role) { log.warn('auto role not found', { roleId }); return null; }
  const me = guild.members.me ?? await guild.members.fetchMe?.().catch(() => null);
  if (role.managed || role.id === guild.roles.everyone?.id) { log.warn('auto role cannot be given: managed or @everyone', { roleId }); return null; }
  if (role.position >= (me?.roles?.highest?.position ?? 0)) { log.warn('auto role is above the bot role: move the bot role higher', { roleId }); return null; }
  const risky = RISKY.filter((p) => role.permissions?.has?.(p));
  if (risky.length) { log.warn('auto role has dangerous permissions, not giving it to everyone', { roleId, risky }); return null; }
  return role;
}

export async function giveAutoRole(ctx, member) {
  const id = ctx.cfg.autoRoleId; if (!id || member.user?.bot) return false;
  const role = await usableRole(member.guild, id); if (!role) return false;
  if (member.roles.cache.has(role.id)) return false;
  await member.roles.add(role, 'Auto role for every member');
  return true;
}

/** Gives the role to everyone who is missing it. Slow on purpose: one at a time stays inside Discord's rate limits. */
export async function sweepAutoRole(ctx, guild, { pause = 350 } = {}) {
  const id = ctx.cfg.autoRoleId; if (!id) return { ok: 0, failed: 0 };
  const role = await usableRole(guild, id); if (!role) return { ok: 0, failed: 0 };
  let members; try { members = await guild.members.fetch(); } catch (e) { log.warn('auto role sweep: could not load members (turn on the Server Members Intent)', { err: String(e?.message ?? e) }); return { ok: 0, failed: 0 }; }
  let ok = 0, failed = 0;
  for (const m of members.values()) {
    if (m.user.bot || m.roles.cache.has(role.id)) continue;
    try { await m.roles.add(role, 'Auto role for every member'); ok++; } catch (e) { failed++; if (failed >= 10 && !ok) break; }
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  log.info('auto role sweep done', { ok, failed });
  return { ok, failed };
}
