import { Events } from 'discord.js';
import * as G from '../core/giveaways.js';
import * as act from '../core/activity.js';
import { audit } from '../core/audit.js';
import { log } from '../logger.js';
import * as ui from './ui.js';
import { UserError } from './automm.js';

const wrap = (fn) => { try { return fn(); } catch (e) { if (e instanceof G.GiveawayError) throw new UserError(e.message); throw e; } };
const chanOf = async (ctx, id) => ctx.client?.channels?.cache?.get(id) ?? await ctx.client?.channels?.fetch(id).catch(() => null);
const eph = { flags: 64, allowedMentions: { parse: [] } };

async function refresh(ctx, g) {
  const ch = await chanOf(ctx, g.channel_id); if (!ch || !g.message_id) return;
  const msg = await ch.messages.fetch(g.message_id).catch(() => null);
  await msg?.edit(ui.giveawayPayload(ctx.cfg, g, G.entryCount(ctx.db, g.id))).catch((e) => log.error('giveaway edit failed', e));
}
async function announce(ctx, g, { rerolled = false } = {}) {
  const ch = await chanOf(ctx, g.channel_id); if (!ch) return;
  const text = g.winner_id
    ? `${rerolled ? 'New winner' : 'Congratulations'} <@${g.winner_id}>! You won **${g.prize}**.${g.picked_by ? ' (Winner chosen by staff.)' : ''}`
    : `Nobody entered the giveaway for **${g.prize}**, so there is no winner.`;
  await ch.send({ content: text, allowedMentions: { users: g.winner_id ? [g.winner_id] : [] }, ...(g.message_id ? { reply: { messageReference: g.message_id, failIfNotExists: false } } : {}) }).catch((e) => log.error('giveaway announce failed', e));
}

export async function create(i, ctx, { channel, duration, details }) {
  const cid = /^<#(\d{15,25})>$|^(\d{15,25})$/.exec(channel.trim()); if (!cid) throw new UserError('Give a channel ID or #channel first. Usage: `.giveawaycreate <channel ID> <duration> <prize> <requirement>`');
  const ms = wrap(() => G.parseDuration(duration)); const { prize, req } = wrap(() => G.splitDetails(details));
  const ch = await chanOf(ctx, cid[1] ?? cid[2]);
  if (!ch || !ch.isTextBased?.() || !ch.guild || ch.guild.id !== i.guild?.id) throw new UserError('I cannot find that text channel in this server.');
  const g = G.create(ctx.db, { channelId: ch.id, hostId: i.user.id, prize, req, endsAt: Date.now() + ms });
  try {
    const msg = await ch.send(ui.giveawayPayload(ctx.cfg, g, 0)); G.setMessage(ctx.db, g.id, msg.id);
  } catch (e) { G.remove(ctx.db, g.id); log.error('giveaway post failed', e); throw new UserError(`I could not post in <#${ch.id}>. Check my permissions there.`); }
  audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'giveaway.created', detail: { staff: true, id: g.id, prize, channel: ch.id } });
  const ts = Math.floor(g.ends_at / 1000);
  return i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, 'Giveaway created', `**ID:** ${g.id}\n**Prize:** ${prize}\n**Channel:** <#${ch.id}>\n**Ends:** <t:${ts}:R>\n**Requirement:** ${ui.reqText(g)}\n\nEnd it early with \`.giveawayend ${g.id}\` (random) or \`.giveawayend ${g.id} @member\` (you pick).`)] });
}

async function meets(i, ctx, g) {
  if (!g.req_kind) return null;
  if (g.req_kind === 'messages') {
    const n = act.userMessages(ctx.db, i.user.id).all;
    return n >= g.req_n ? null : `You need **${g.req_n}** messages to enter. I have counted **${n}** from you.`;
  }
  let invites;
  try { invites = await i.guild.invites.fetch(); } catch { throw new UserError('I cannot check invites right now. Ask staff.'); }
  const n = [...invites.values()].filter((v) => v.inviter?.id === i.user.id).reduce((a, v) => a + (v.uses ?? 0), 0);
  return n >= g.req_n ? null : `You need **${g.req_n}** invite${g.req_n === 1 ? '' : 's'} to enter. Your invite links have **${n}** use${n === 1 ? '' : 's'}.`;
}
export async function enter(i, ctx, id) {
  const g = G.get(ctx.db, Number(id));
  if (!g || g.state !== 'open' || g.ends_at <= Date.now()) throw new UserError('This giveaway has ended.');
  if (G.hasEntered(ctx.db, g.id, i.user.id)) return i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, 'Already entered', 'You are in this giveaway. Good luck.')], components: ui.giveawayLeaveRow(g.id) });
  const why = await meets(i, ctx, g); if (why) throw new UserError(why);
  G.enter(ctx.db, g.id, i.user.id);
  await i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, 'You are in', `You entered the giveaway for **${g.prize}**. Good luck.`)] });
  await refresh(ctx, g);
}
export async function leave(i, ctx, id) {
  const g = G.get(ctx.db, Number(id)); if (!g || g.state !== 'open') throw new UserError('This giveaway has ended.');
  G.leave(ctx.db, g.id, i.user.id);
  await i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, 'Left', 'You left the giveaway.')] });
  await refresh(ctx, g);
}

export async function finish(ctx, id, opts = {}) {
  const g = wrap(() => G.end(ctx.db, id, opts));
  audit(ctx.db, { category: 'system', actor: opts.pickedBy ?? 'system', action: 'giveaway.ended', detail: { id, winner: g.winner_id, staffPicked: !!g.picked_by } });
  await refresh(ctx, g); await announce(ctx, g);
  return g;
}
export async function endNow(i, ctx, id, member) {
  const g = await finish(ctx, id, { winner: member?.id ?? null, pickedBy: member ? i.user.id : null });
  return i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, 'Giveaway ended', g.winner_id ? `**Winner:** <@${g.winner_id}> (${g.picked_by ? 'chosen by you' : 'random'}).` : 'Nobody entered, so there is no winner.')] });
}
export async function reroll(i, ctx, id) {
  const g = wrap(() => G.reroll(ctx.db, id));
  audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'giveaway.rerolled', detail: { staff: true, id, winner: g.winner_id } });
  await refresh(ctx, g); await announce(ctx, g, { rerolled: true });
  return i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, 'Rerolled', `**New winner:** <@${g.winner_id}>.`)] });
}

export async function sweep(ctx) {
  for (const g of G.due(ctx.db)) { try { await finish(ctx, g.id); } catch (e) { log.error('giveaway end failed', e); } }
}
export function startGiveawayLoop(client, ctx) {
  client.once(Events.ClientReady, () => { sweep(ctx); setInterval(() => sweep(ctx), 15_000).unref?.(); });
}
