// Text moderation: .ban .kick .nick .purge .timeout .role. Every action checks the role hierarchy for BOTH the person
// running the command and the bot, and is written to the audit log.
import { audit } from '../core/audit.js';
import * as ui from './ui.js';
import { UserError } from './automm.js';

const RISKY = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers', 'ModerateMembers', 'MentionEveryone'];
const UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
const MAX_TIMEOUT = 28 * 864e5;

export function parseDuration(text) {
  const m = /^(\d{1,4})\s*([smhdw])$/i.exec(String(text ?? '').trim());
  if (!m) throw new UserError('Give a duration like `10m`, `2h`, `1d` or `1w`. Use `off` to remove a timeout.');
  const ms = Number(m[1]) * UNITS[m[2].toLowerCase()];
  if (ms < 1000 || ms > MAX_TIMEOUT) throw new UserError('A timeout must be between 1 second and 28 days.');
  return ms;
}
const human = (ms) => { const d = ms / 864e5; if (d >= 1 && Number.isInteger(d)) return `${d} day${d === 1 ? '' : 's'}`; const h = ms / 36e5; if (h >= 1 && Number.isInteger(h)) return `${h} hour${h === 1 ? '' : 's'}`; const m = Math.round(ms / 6e4); return `${m} minute${m === 1 ? '' : 's'}`; };

const isOwner = (i, ctx) => i.guild?.ownerId === i.user.id || (ctx.cfg.ownerUserIds ?? []).includes(i.user.id);
const top = (m) => m?.roles?.highest?.position ?? 0;
const reasonOf = (i, r) => `${r ? r.slice(0, 400) : 'No reason given'} (by ${i.user.id})`;
const log = (ctx, i, action, detail) => audit(ctx.db, { category: 'staff', actor: i.user.id, action: `mod.${action}`, detail: { staff: true, ...detail } });

async function memberOf(i, user, { required = true } = {}) {
  const m = await i.guild.members.fetch(user.id).catch(() => null);
  if (!m && required) throw new UserError('That person is not in this server.');
  return m;
}
function guardTarget(i, ctx, user, m, verb) {
  if (user.id === i.user.id) throw new UserError(`You cannot ${verb} yourself.`);
  if (user.id === i.guild.members.me?.id) throw new UserError(`I will not ${verb} myself.`);
  if (user.id === i.guild.ownerId || (ctx.cfg.ownerUserIds ?? []).includes(user.id)) throw new UserError(`You cannot ${verb} the server owner.`);
  if (!m) return;
  if (!isOwner(i, ctx) && top(m) >= top(i.member)) throw new UserError(`**${m.displayName ?? user.username}** has a role equal to or above yours.`);
  if (top(m) >= top(i.guild.members.me)) throw new UserError('That member is above my highest role. Move my role higher in Server Settings.');
}
const failHint = (e) => (/Missing Permissions|Missing Access/i.test(String(e?.message)) ? 'I do not have the permission for that. Give my role the needed permission and keep it above theirs.' : 'Discord refused that action.');

export async function ban(i, ctx, { need, say }) {
  need(i, ctx, 'mod.heavy');
  const user = i.options.getUser('member'); const reason = i.options.getString('reason');
  const m = await memberOf(i, user, { required: false }); guardTarget(i, ctx, user, m, 'ban');
  try { await i.guild.members.ban(user.id, { reason: reasonOf(i, reason) }); } catch (e) { throw new UserError(failHint(e)); }
  log(ctx, i, 'ban', { target: user.id, reason: reason?.slice(0, 200) });
  return say(ctx, i, 'Member banned', `**${user.username ?? user.id}** was banned.\n**Reason:** ${reason ?? 'No reason given'}`);
}
export async function kick(i, ctx, { need, say }) {
  need(i, ctx, 'mod.heavy');
  const user = i.options.getUser('member'); const reason = i.options.getString('reason');
  const m = await memberOf(i, user); guardTarget(i, ctx, user, m, 'kick');
  try { await m.kick(reasonOf(i, reason)); } catch (e) { throw new UserError(failHint(e)); }
  log(ctx, i, 'kick', { target: user.id, reason: reason?.slice(0, 200) });
  return say(ctx, i, 'Member kicked', `**${user.username ?? user.id}** was kicked.\n**Reason:** ${reason ?? 'No reason given'}`);
}
export async function nick(i, ctx, { need, say }) {
  need(i, ctx, 'mod.light');
  const user = i.options.getUser('member'); const name = (i.options.getString('nickname') ?? '').trim();
  if (name.length > 32) throw new UserError('A nickname can be at most 32 characters.');
  const m = await memberOf(i, user); if (user.id !== i.user.id) guardTarget(i, ctx, user, m, 'rename');
  try { await m.setNickname(name || null, `Nickname by ${i.user.id}`); } catch (e) { throw new UserError(failHint(e)); }
  log(ctx, i, 'nick', { target: user.id, reset: !name });
  return say(ctx, i, name ? 'Nickname changed' : 'Nickname reset', name ? `<@${user.id}> is now **${name}**.` : `<@${user.id}>'s nickname was reset.`);
}
export async function timeout(i, ctx, { need, say }) {
  need(i, ctx, 'mod.light');
  const user = i.options.getUser('member'); const dur = i.options.getString('duration'); const reason = i.options.getString('reason');
  const m = await memberOf(i, user); guardTarget(i, ctx, user, m, 'time out');
  const off = /^(off|0|remove|clear)$/i.test(dur);
  const ms = off ? null : parseDuration(dur);
  try { await m.timeout(ms, reasonOf(i, reason)); } catch (e) { throw new UserError(failHint(e)); }
  log(ctx, i, off ? 'untimeout' : 'timeout', { target: user.id, ms, reason: reason?.slice(0, 200) });
  return say(ctx, i, off ? 'Timeout removed' : 'Member timed out', off ? `<@${user.id}> can talk again.` : `<@${user.id}> is timed out for **${human(ms)}**.\n**Reason:** ${reason ?? 'No reason given'}`);
}
export async function purge(i, ctx, { need }) {
  need(i, ctx, 'mod.light');
  const n = i.options.getInteger('amount'); const user = i.options.getUser('member');
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new UserError('Pick an amount from 1 to 100.');
  const ch = i.channel; if (!ch?.bulkDelete) throw new UserError('I can only purge in a server text channel.');
  await i.message?.delete?.().catch(() => {});
  let gone;
  try {
    if (user) {
      const recent = await ch.messages.fetch({ limit: 100 });
      const ids = [...recent.values()].filter((m) => m.author.id === user.id && m.id !== i.message?.id).slice(0, n);
      gone = ids.length ? await ch.bulkDelete(ids, true) : { size: 0 };
    } else gone = await ch.bulkDelete(n, true);
  } catch (e) { throw new UserError(/Missing/i.test(String(e?.message)) ? 'I need **Manage Messages** in this channel.' : 'Discord refused that.'); }
  const count = gone?.size ?? 0;
  log(ctx, i, 'purge', { channel: ch.id, count, target: user?.id ?? null });
  const note = await ch.send({ embeds: [ui.okEmbed(ctx.cfg, 'Messages deleted', `**${count}** message${count === 1 ? '' : 's'} deleted${user ? ` from <@${user.id}>` : ''}.${count < n ? '\nMessages older than 14 days cannot be bulk deleted.' : ''}`)], allowedMentions: { parse: [] } }).catch(() => null);
  if (note?.delete) setTimeout(() => note.delete().catch(() => {}), 5000).unref?.();
}
/** .role @member @role: adds the role, or removes it when they already have it. */
export async function roleToggle(i, ctx, { need, say }) {
  need(i, ctx, 'mod.heavy');
  const user = i.options.getUser('member'); const role = i.options.getRole('role', true); const g = i.guild;
  if (role.id === g.roles.everyone?.id || role.managed) throw new UserError('That role cannot be given out: it is @everyone or managed by an integration.');
  if (role.position >= top(g.members.me)) throw new UserError('That role is above my highest role. Move my role higher in Server Settings.');
  const owner = isOwner(i, ctx);
  if (!owner && role.position >= top(i.member)) throw new UserError('That role is equal to or above your highest role.');
  const risky = RISKY.filter((p) => role.permissions?.has?.(p));
  if (risky.length && !owner) throw new UserError(`Only the owner can hand out a role with these permissions: ${risky.join(', ')}.`);
  const m = await memberOf(i, user); if (user.id !== i.user.id) guardTarget(i, ctx, user, m, 'change the roles of');
  const has = m.roles.cache.has(role.id);
  try { if (has) await m.roles.remove(role, `.role by ${i.user.id}`); else await m.roles.add(role, `.role by ${i.user.id}`); } catch (e) { throw new UserError(failHint(e)); }
  log(ctx, i, has ? 'role.remove' : 'role.add', { target: user.id, role: role.id });
  return say(ctx, i, has ? 'Role removed' : 'Role added', `**${role.name}** was ${has ? 'removed from' : 'added to'} <@${user.id}>.`);
}
