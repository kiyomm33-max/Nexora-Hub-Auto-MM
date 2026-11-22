import { Events } from 'discord.js';
import * as G from '../core/giveaways.js';
import { audit } from '../core/audit.js';
import { log } from '../logger.js';
import * as ui from './ui.js';
import { UserError } from './automm.js';
import { logoFile } from './status.js';

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
    ? `${rerolled ? 'New winner' : 'Congratulations'} <@${g.winner_id}>! You won **${g.prize}**. The winner was picked at random.`
    : `Nobody entered the giveaway for **${g.prize}**, so there is no winner.`;
  await ch.send({ content: text, allowedMentions: { users: g.winner_id ? [g.winner_id] : [] }, ...(g.message_id ? { reply: { messageReference: g.message_id, failIfNotExists: false } } : {}) }).catch((e) => log.error('giveaway announce failed', e));
}

const usesByInviter = (invites) => {
  const out = {};
  for (const v of invites.values()) if (v.inviter?.id) out[v.inviter.id] = (out[v.inviter.id] ?? 0) + (v.uses ?? 0);
  return out;
};
export async function create(i, ctx, { channel, duration, prize, invites }) {
  const ms = wrap(() => G.parseDuration(duration));
  prize = String(prize).trim(); if (!prize) throw new UserError('Add the prize.');
  const ch = await chanOf(ctx, channel.id);
  if (!ch || !ch.isTextBased?.() || !ch.guild || ch.guild.id !== i.guild?.id) throw new UserError('I cannot find that text channel in this server.');
  let baseline = null;
  if (invites) {
    try { baseline = usesByInviter(await i.guild.invites.fetch()); }
    catch { throw new UserError('I need the **Manage Server** permission to count invites. Give it to my role and try again.'); }
  }
  const g = G.create(ctx.db, { channelId: ch.id, hostId: i.user.id, prize, req: invites ? { kind: 'invites', n: invites } : null, endsAt: Date.now() + ms });
  if (baseline) G.setBaseline(ctx.db, g.id, baseline);
  try {
    const msg = await ch.send({ ...ui.giveawayPayload(ctx.cfg, g, 0), files: [logoFile()] }); G.setMessage(ctx.db, g.id, msg.id);
  } catch (e) { G.remove(ctx.db, g.id); log.error('giveaway post failed', e); throw new UserError(`I could not post in <#${ch.id}>. Check my permissions there.`); }
  audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'giveaway.created', detail: { staff: true, id: g.id, prize, channel: ch.id, invites: invites ?? 0 } });
  const ts = Math.floor(g.ends_at / 1000);
  return i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, 'Giveaway created', `**ID:** ${g.id}\n**Prize:** ${prize}\n**Channel:** <#${ch.id}>\n**Ends:** <t:${ts}:R>\n**Requirement:** ${ui.reqText(g)}\n\nThe winner is drawn **at random** from everyone who entered. End it early with \`/giveaway end ${g.id}\`.`)] });
}

async function meets(i, ctx, g) {
  if (!g.req_kind) return null;
  let invites;
  try { invites = await i.guild.invites.fetch(); } catch { throw new UserError('I cannot check invites right now. Ask staff.'); }
  const n = G.newInvites(ctx.db, g.id, i.user.id, usesByInviter(invites)[i.user.id] ?? 0);
  return n >= g.req_n ? null : `You need to invite **${g.req_n}** new member${g.req_n === 1 ? '' : 's'} after this giveaway started. Your invite links have brought **${n}** so far. Create an invite link, share it, and press Enter again once someone joins with it.`;
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

export async function finish(ctx, id) {
  const g = wrap(() => G.end(ctx.db, id));
  audit(ctx.db, { category: 'system', actor: 'system', action: 'giveaway.ended', detail: { id, winner: g.winner_id } });
  await refresh(ctx, g); await announce(ctx, g);
  return g;
}
export async function endNow(i, ctx, id) {
  const g = await finish(ctx, id);
  return i.reply({ ...eph, embeds: [ui.okEmbed(ctx.cfg, 'Giveaway ended', g.winner_id ? `**Winner:** <@${g.winner_id}> (picked at random).` : 'Nobody entered, so there is no winner.')] });
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
