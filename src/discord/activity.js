// Discord side of activity tracking: counts messages and watches the server tag and the custom status.
import { Events } from 'discord.js';
import { countMessage, setPerk, openPerks } from '../core/activity.js';
import { log } from '../logger.js';

/** Count one chat message. Bots, webhooks and system messages do not count. */
export function onMessage(msg) {
  if (!msg.guild || msg.author?.bot || msg.webhookId || msg.system) return false;
  return { userId: msg.author.id };
}
export function countFromMessage(msg, ctx) {
  const m = onMessage(msg); if (!m) return;
  try { countMessage(ctx.db, m.userId); } catch (e) { log.error('message count failed', e); }
}

/** What a member shows right now. null means "cannot tell" (for example an offline member's status is hidden). */
export function memberState(member, cfg) {
  const u = member.user ?? member;
  const pg = u.primaryGuild;
  const tag = pg ? !!(pg.identityEnabled && cfg.guildId && pg.identityGuildId === cfg.guildId) : false;
  const phrase = String(cfg.statusPhrase ?? '').toLowerCase();
  let status = null;
  const p = member.presence;
  if (phrase && p && p.status && p.status !== 'offline' && p.status !== 'invisible') {
    status = (p.activities ?? []).some((a) => a.type === 4 && String(a.state ?? '').toLowerCase().includes(phrase));
  }
  return { tag, status };
}

export function syncMember(ctx, member, { at = Date.now() } = {}) {
  if ((member.user ?? member).bot) return [];
  const id = (member.user ?? member).id; const out = [];
  const st = memberState(member, ctx.cfg);
  const a = setPerk(ctx.db, id, 'tag', st.tag, { at, reason: 'removed' }); if (a) out.push(['tag', a, id]);
  if (st.status !== null) { const b = setPerk(ctx.db, id, 'status', st.status, { at, reason: 'removed' }); if (b) out.push(['status', b, id]); }
  return out;
}

/** Full pass over the member list (needs the Server Members intent). Also closes sessions of people who left. */
export async function syncAll(ctx) {
  const guild = await ctx.client.guilds.fetch(ctx.cfg.guildId);
  const members = await guild.members.fetch();
  const here = new Set(); let changed = 0;
  for (const m of members.values()) { here.add(m.id); changed += syncMember(ctx, m).length; }
  for (const kind of ['tag', 'status']) for (const id of openPerks(ctx.db, kind)) if (!here.has(id)) { setPerk(ctx.db, id, kind, false, { reason: 'left' }); changed++; }
  return { members: members.size, changed };
}

export function startActivity(client, ctx, { presences, members }) {
  if (members) {
    client.on('guildMemberUpdate', (_old, m) => { try { if (m.guild.id === ctx.cfg.guildId) syncMember(ctx, m); } catch (e) { log.error('member sync failed', e); } });
    client.on('guildMemberRemove', (m) => { try { if (m.guild.id === ctx.cfg.guildId) for (const k of ['tag', 'status']) setPerk(ctx.db, m.id, k, false, { reason: 'left' }); } catch (e) { log.error('member remove sync failed', e); } });
  }
  if (presences) client.on('presenceUpdate', (_old, p) => { try { if (p.guild?.id === ctx.cfg.guildId && p.member) syncMember(ctx, p.member); } catch (e) { log.error('presence sync failed', e); } });
  const run = () => syncAll(ctx).then((r) => log.info('activity synced', r)).catch((e) => log.error('activity sync failed', e));
  if (members) client.once(Events.ClientReady, () => { run(); setInterval(run, 600e3).unref?.(); });
}
