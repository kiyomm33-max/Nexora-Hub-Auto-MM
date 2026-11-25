import { Events } from 'discord.js';
import * as P from '../core/polls.js';
import { parseDuration, GiveawayError } from '../core/giveaways.js';
import { audit } from '../core/audit.js';
import { log } from '../logger.js';
import * as ui from './ui.js';
import { UserError } from './automm.js';
import { logoFile } from './status.js';

const wrap = (fn) => { try { return fn(); } catch (e) { if (e instanceof P.PollError || e instanceof GiveawayError) throw new UserError(e.message); throw e; } };
const chanOf = async (ctx, id) => ctx.client?.channels?.cache?.get(id) ?? await ctx.client?.channels?.fetch(id).catch(() => null);
const eph = { flags: 64, allowedMentions: { parse: [] } };
const render = (ctx, p) => ui.pollPayload(ctx.cfg, p, P.tally(ctx.db, p.id));

async function refresh(ctx, p) {
  const ch = await chanOf(ctx, p.channel_id); if (!ch || !p.message_id) return;
  const msg = await ch.messages.fetch(p.message_id).catch(() => null);
  await msg?.edit(render(ctx, p)).catch((e) => log.error('poll edit failed', e));
}

export async function create(i, ctx, { channel, question, duration, options }) {
  const ms = wrap(() => parseDuration(duration));
  const ch = await chanOf(ctx, channel.id);
  if (!ch || !ch.isTextBased?.() || !ch.guild || ch.guild.id !== i.guild?.id) throw new UserError('I cannot find that text channel in this server.');
  const p = wrap(() => P.create(ctx.db, { channelId: ch.id, hostId: i.user.id, question, options, endsAt: Date.now() + ms }));
  try { const msg = await ch.send({ ...render(ctx, p), files: [logoFile()] }); P.setMessage(ctx.db, p.id, msg.id); }
  catch (e) { P.remove(ctx.db, p.id); log.error('poll post failed', e); throw new UserError(`I could not post in <#${ch.id}>. Check my permissions there.`); }
  audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'poll.created', detail: { staff: true, id: p.id, channel: ch.id } });
  const ts = Math.floor(p.ends_at / 1000);
  return i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, 'Poll created', `**ID:** ${p.id}\n**Channel:** <#${ch.id}>\n**Ends:** <t:${ts}:R>\n\nEnd it early with \`/poll end ${p.id}\`.`)] });
}
export async function vote(i, ctx, id, n) {
  const p = P.get(ctx.db, Number(id));
  if (!p || p.state !== 'open' || p.ends_at <= Date.now()) throw new UserError('This poll has ended.');
  const r = wrap(() => P.vote(ctx.db, p.id, i.user.id, Number(n)));
  const name = JSON.parse(p.options)[Number(n)];
  await i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, r === 'removed' ? 'Vote removed' : 'Vote counted', r === 'removed' ? 'Your vote was removed.' : `You voted for **${name}**${r === 'changed' ? ' (changed from your earlier vote)' : ''}.`)] });
  await refresh(ctx, p);
}
export async function finish(ctx, id) {
  const p = wrap(() => P.end(ctx.db, id));
  audit(ctx.db, { category: 'system', actor: 'system', action: 'poll.ended', detail: { id } });
  await refresh(ctx, p);
  const counts = P.tally(ctx.db, id); const opts = JSON.parse(p.options); const top = Math.max(...counts); const total = counts.reduce((a, b) => a + b, 0);
  const ch = await chanOf(ctx, p.channel_id);
  const winners = opts.filter((_, k) => counts[k] === top);
  const text = !total ? `The poll **${p.question}** ended with no votes.` : winners.length === 1 ? `The poll **${p.question}** ended. **${winners[0]}** won with **${top}** of **${total}** votes.` : `The poll **${p.question}** ended in a tie between ${winners.map((w) => `**${w}**`).join(' and ')} with **${top}** votes each.`;
  await ch?.send({ content: text, allowedMentions: { parse: [] }, ...(p.message_id ? { reply: { messageReference: p.message_id, failIfNotExists: false } } : {}) }).catch((e) => log.error('poll result failed', e));
  return p;
}
/** Staff only: who voted for what. */
export async function votes(i, ctx, id) {
  const p = id == null ? P.latest(ctx.db) : P.get(ctx.db, id); if (!p) throw new UserError(id == null ? 'There is no poll yet.' : 'No poll with that ID.');
  const opts = JSON.parse(p.options); const all = P.voters(ctx.db, p.id); const by = opts.map(() => []);
  for (const v of all) if (by[v.choice]) by[v.choice].push(v.user_id);
  let budget = 3500;
  const blocks = opts.map((o, k) => {
    const shown = []; for (const u of by[k]) { const t = `<@${u}>`; if (budget - t.length - 1 < 0) { shown.push(`...and ${by[k].length - shown.length} more`); break; } budget -= t.length + 1; shown.push(t); }
    return `**${o}** - **${by[k].length}** vote${by[k].length === 1 ? '' : 's'}\n${shown.join(' ') || 'No votes'}`;
  });
  return i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, `Poll ${p.id} - who voted`, `**${p.question}**\n**State:** ${p.state === 'open' ? 'open' : 'ended'} | **Voters:** **${all.length}**\n\n${blocks.join('\n\n')}`)] });
}
export async function endNow(i, ctx, id) { await finish(ctx, id); return i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, 'Poll ended', `Poll ${id} is closed and the result was posted.`)] }); }
export async function sweep(ctx) { for (const p of P.due(ctx.db)) { try { await finish(ctx, p.id); } catch (e) { log.error('poll end failed', e); } } }
export function startPollLoop(client, ctx) { client.once(Events.ClientReady, () => { sweep(ctx); setInterval(() => sweep(ctx), 15_000).unref?.(); }); }
