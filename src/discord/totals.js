import { Events } from 'discord.js';
import { globalStats } from '../core/stats.js';
import { log } from '../logger.js';
import * as ui from './ui.js';

const KEY = 'totals_msg';
const payload = (ctx) => ({ embeds: [ui.totalsEmbed(ctx.cfg, globalStats(ctx.db))], allowedMentions: { parse: [] } });
const chanOf = async (ctx, id) => ctx.client?.channels?.cache?.get(id) ?? await ctx.client?.channels?.fetch(id).catch(() => null);

/** Posts the panel and remembers it, so the numbers keep updating. A new post replaces the old one. */
export async function post(ctx, channel) {
  const old = ctx.db.prepare('SELECT value FROM kv WHERE key=?').get(KEY)?.value;
  const msg = await channel.send(payload(ctx));
  ctx.db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, `${channel.id}:${msg.id}`);
  if (old) { const [c, m] = old.split(':'); (await chanOf(ctx, c))?.messages?.fetch(m).then((x) => x.delete()).catch(() => {}); }
  return msg;
}
export async function refresh(ctx) {
  const ref = ctx.db.prepare('SELECT value FROM kv WHERE key=?').get(KEY)?.value; if (!ref) return;
  const [c, m] = ref.split(':'); const ch = await chanOf(ctx, c); const msg = await ch?.messages?.fetch(m).catch(() => null);
  await msg?.edit(payload(ctx)).catch((e) => log.error('totals edit failed', e));
}
export function startTotalsLoop(client, ctx) {
  client.once(Events.ClientReady, () => { refresh(ctx); setInterval(() => refresh(ctx).catch(() => {}), 300_000).unref?.(); });
}
