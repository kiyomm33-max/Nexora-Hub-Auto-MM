import { Events } from 'discord.js';
import * as I from '../core/invites.js';
import { log } from '../logger.js';

let cache = {}; // code -> { uses, inviter }
const snap = (invites) => Object.fromEntries([...invites.values()].map((v) => [v.code, { uses: v.uses ?? 0, inviter: v.inviter?.id ?? null }]));
const guildOf = (client, ctx) => client.guilds.cache.get(ctx.cfg.guildId) ?? client.guilds.cache.first();

export async function inviteStats(guild, ctx, userId) {
  let uses = null;
  try { uses = [...(await guild.invites.fetch()).values()].filter((v) => v.inviter?.id === userId).reduce((a, v) => a + (v.uses ?? 0), 0); } catch { /* needs Manage Server */ }
  return { uses, ...I.stats(ctx.db, userId) };
}

export function startInvites(client, ctx) {
  const load = async () => { try { cache = snap(await guildOf(client, ctx).invites.fetch()); } catch (e) { log.warn('invite tracking needs the Manage Server permission'); } };
  client.once(Events.ClientReady, load);
  client.on(Events.InviteCreate, (inv) => { cache[inv.code] = { uses: inv.uses ?? 0, inviter: inv.inviter?.id ?? null }; });
  client.on(Events.InviteDelete, () => {}); // keep the entry: a deleted code is how a last-use invite shows up on join
  client.on(Events.GuildMemberAdd, async (m) => {
    if (m.user?.bot) return;
    try {
      const after = snap(await m.guild.invites.fetch());
      const used = I.usedInvite(cache, after); cache = after;
      if (used?.inviter) I.recordJoin(ctx.db, m.id, used.inviter, used.code);
    } catch (e) { log.warn('invite attribution failed', e?.message); }
  });
  client.on(Events.GuildMemberRemove, (m) => { try { I.recordLeave(ctx.db, m.id); } catch (e) { log.error('invite leave failed', e); } });
}
