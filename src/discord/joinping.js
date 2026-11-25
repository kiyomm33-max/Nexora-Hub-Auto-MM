import { isPaused } from '../core/pause.js';
// Pings a new member in a few channels, then deletes the ping after 10 seconds.
// Discord does not tell bots when a member has seen a message, so the delay is the only trigger.
export const PING_TTL_MS = 10_000;

export async function pingNewMember(ctx, member, { ttl = PING_TTL_MS } = {}) {
  if (member.user?.bot || (ctx.db && isPaused(ctx.db, 'ping'))) return 0;
  const id = member.user?.id ?? member.id; let sent = 0;
  for (const cid of ctx.cfg.channels.joinPing ?? []) {
    const ch = await ctx.client.channels.fetch(cid).catch(() => null); if (!ch?.send) continue;
    const msg = await ch.send({ content: `<@${id}>`, allowedMentions: { users: [id] } }).catch(() => null); if (!msg) continue;
    sent++; setTimeout(() => { msg.delete().catch(() => {}); }, ttl).unref?.();
  }
  return sent;
}
