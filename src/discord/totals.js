import { ChannelType, PermissionFlagsBits as P, Events } from 'discord.js';
import { globalStats } from '../core/stats.js';
import { log } from '../logger.js';

// Two locked voice channels whose names show the numbers: "Volume: $1,200.50" and "Total Deals: 12".
// Discord allows about 2 renames per 10 minutes per channel, so a channel is renamed at most once every 5 minutes.
const KEY = 'totals_voice';
const MIN_GAP = 300_000;
const last = { volume: 0, deals: 0 };
export const namesFor = (st) => ({
  volume: `Volume: $${st.volume.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  deals: `Total Deals: ${st.deals.toLocaleString('en-US')}`,
});
const chanOf = async (ctx, id) => (id ? (ctx.client?.channels?.cache?.get(id) ?? await ctx.client?.channels?.fetch(id).catch(() => null)) : null);
const saved = (ctx) => { try { return JSON.parse(ctx.db.prepare('SELECT value FROM kv WHERE key=?').get(KEY)?.value ?? '{}'); } catch { return {}; } };
const ids = (ctx) => ({ volume: ctx.cfg.channels.volumeVoice ?? saved(ctx).volume, deals: ctx.cfg.channels.dealsVoice ?? saved(ctx).deals });

/** Creates the two channels (everyone can see them, nobody can join) unless they already exist. */
export async function setup(ctx, guild) {
  const have = ids(ctx); const names = namesFor(globalStats(ctx.db)); const out = { ...have }; const created = [];
  for (const k of ['volume', 'deals']) {
    if (await chanOf(ctx, have[k])) continue;
    const ch = await guild.channels.create({ name: names[k], type: ChannelType.GuildVoice, parent: ctx.cfg.channels.statsCategory || undefined,
      permissionOverwrites: [{ id: guild.id, allow: [P.ViewChannel], deny: [P.Connect, P.Speak] }] });
    out[k] = ch.id; created.push(k); last[k] = Date.now();
  }
  ctx.db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify({ volume: out.volume, deals: out.deals }));
  return { ids: out, created };
}
/** Renames a channel when its number changed. Returns how many were renamed. */
export async function refresh(ctx, { now = Date.now() } = {}) {
  const want = namesFor(globalStats(ctx.db)); const have = ids(ctx); let n = 0;
  for (const k of ['volume', 'deals']) {
    const ch = await chanOf(ctx, have[k]); if (!ch || ch.name === want[k] || now - last[k] < MIN_GAP) continue;
    try { await ch.setName(want[k]); last[k] = now; n++; } catch (e) { log.error('totals rename failed', e); last[k] = now; }
  }
  return n;
}
export function startTotalsLoop(client, ctx) {
  client.once(Events.ClientReady, () => { refresh(ctx).catch(() => {}); setInterval(() => refresh(ctx).catch(() => {}), 30_000).unref?.(); });
}
