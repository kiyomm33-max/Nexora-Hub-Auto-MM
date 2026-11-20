import crypto from 'node:crypto';
import { MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder } from 'discord.js';
import QRCode from 'qrcode';
import * as V from '../core/validate.js';
import { DealError } from '../core/deals.js';
import { audit } from '../core/audit.js';
import { calcFee, calcTotals } from '../core/fees.js';
import { CAPS, LEVELS } from '../core/permissions.js';
import { log } from '../logger.js';
import * as ui from './ui.js';
import * as rooms from './rooms.js';

export class UserError extends Error {}
const EPH = MessageFlags.Ephemeral;

export async function payloadFor(ctx, d) {
  if (d.status === 'waiting_parties') return { files: [], ...ui.stepPayload(ctx.cfg, d, ctx.deals.setup(d)) };
  const embeds = ui.statusEmbeds(ctx.cfg, d); const files = [];
  if (ui.phaseOf(d) === 'invoice' && d.pay_address) {
    try { files.push(new AttachmentBuilder(await QRCode.toBuffer(d.pay_address, { margin: 1, width: 220 }), { name: 'qr.png' })); embeds[1].setThumbnail('attachment://qr.png'); }
    catch (e) { log.error('qr failed', e); }
  }
  const ping = ui.phaseOf(d) === 'invoice' ? `<@${d.sender_id}>` : ui.phaseOf(d) === 'received' ? `<@${d.sender_id}> <@${d.receiver_id}>` : ui.phaseOf(d) === 'payout' ? `<@${d.receiver_id}>` : null;
  return { content: ping, embeds, files, components: ui.roomButtons(d, ctx.cfg) };
}

const load = (ctx, id) => { const d = ctx.deals.get(V.dealId(id)); if (!d) throw new UserError('Deal not found.'); return d; };
function trader(ctx, d, i) {
  if (!ctx.deals.isParty(d, i.user.id)) {
    audit(ctx.db, { category: 'security', actor: i.user.id, action: 'permission.denied', dealId: d.id, detail: { where: i.customId } });
    throw new UserError('Only the two traders in this deal can do that.');
  }
}
const stepIs = (ctx, d, ...steps) => { if (d.status !== 'waiting_parties' || !steps.includes(ctx.deals.setup(d).step)) throw new UserError('That step is already done or not available right now.'); };
/** Serialise state changes per deal so two clicks can never interleave. */
async function locked(ctx, id, fn) {
  const r = await ctx.limiter.once(`deal:${id}`, fn);
  if (r.duplicate) throw new UserError('Another action on this deal is still processing. Try again in a moment.');
  return r.value;
}
const V2 = 1 << 15;
const editable = (p) => ((p.flags ?? 0) & V2 ? { ...p, allowedMentions: { parse: [] } } : { ...p, content: p.content ?? null, allowedMentions: { parse: [] } });
/** Show a deal's current payload on its step message. Components V2 and embed messages cannot be converted into each other, so a switch deletes the old message and posts a new one. */
export async function putStep(ctx, channel, msg, d, p) {
  const was = !!(msg.flags?.bitfield & V2); const now = !!((p.flags ?? 0) & V2);
  if (was === now) return msg.edit(editable(p));
  const m = await channel.send({ ...editable(p), content: now ? undefined : (p.content ?? undefined) });
  ctx.deals.setChannel(d.id, 'status_message_id', m.id);
  await msg.delete().catch(() => {});
  return m;
}
const done = async (i, ctx, d) => {
  const p = await payloadFor(ctx, d);
  const was = !!(i.message?.flags?.bitfield & V2); const now = !!((p.flags ?? 0) & V2);
  if (was === now) return i.update(editable(p));
  await i.deferUpdate(); return putStep(ctx, i.channel, i.message, d, p);
};
const setStep = (ctx, d, step, votes = {}) => ({ ...ctx.deals.setup(d), step, votes });

// ---------- start ----------
export async function startAuto(i, ctx, key) {
  const coin = ui.COINS[key]; if (!coin) throw new UserError('Unknown coin.');
  if (ctx.mode === 'live' && !ctx.cfg.coins.enabled.includes(key)) throw new UserError(`${coin.label} deals are not available right now.`);
  const r = ctx.limiter.check(`amstart:${i.user.id}`, 3, 600e3); if (!r.ok) throw new UserError('Slow down — you are opening deals too quickly.');
  if (ctx.deals.openCount(i.user.id) >= 2) throw new UserError('You already have 2 open deals. Finish or close one first.');
  await i.deferReply({ flags: EPH });
  const deal = ctx.deals.createAuto({ creator: i.user.id, asset: coin.asset, network: coin.network, channelId: null });
  let ch;
  try {
    ch = await rooms.createPrivateChannel(i.guild, ctx.cfg, { name: `${key.toLowerCase()}-${deal.id.slice(4).toLowerCase()}`, parent: ctx.cfg.channels.dealCategory, members: [i.user.id], minStaff: LEVELS.admin, topic: `Nexora Hub deal ${deal.id}` });
  } catch (e) { ctx.deals.cancel(deal.id, 'system', 'room creation failed', { staff: true }); throw e; }
  ctx.deals.db.prepare('UPDATE deals SET channel_id=? WHERE id=?').run(ch.id, deal.id);
  const d = ctx.deals.get(deal.id);
  await ch.send({ content: `<@${i.user.id}>`, embeds: ui.startedEmbeds(ctx.cfg, d), components: ui.closeButton(d.id), allowedMentions: { users: [i.user.id] } });
  const m = await ch.send({ ...(await payloadFor(ctx, d)), allowedMentions: { parse: [] } });
  ctx.deals.setChannel(d.id, 'status_message_id', m.id);
  return i.editReply({ embeds: [ui.okEmbed(ctx.cfg, 'Deal room created', `Continue in <#${ch.id}>.`)] });
}

/** Adds the other trader to a deal in the partner step. Shared by the modal fallback and the typed-message flow. */
async function addPartner(ctx, id, by, u, guild, channel) {
  const d = load(ctx, id); if (d.party_a !== by) throw new UserError('Only the deal creator can add the other trader.'); stepIs(ctx, d, 'partner');
  V.snowflake(u);
  if (u === by) throw new UserError('You cannot trade with yourself.');
  let member; try { member = await guild.members.fetch(u); } catch { throw new UserError('That user is not in this server.'); }
  if (member.user?.bot) throw new UserError('Bots cannot be deal partners.');
  const nd = await locked(ctx, id, async () => ctx.deals.patch(id, by, { party_b: u, setup: setStep(ctx, d, 'roles') }, 'setup.partner_added'));
  await channel.permissionOverwrites?.edit(u, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true });
  await channel.send({ content: `<@${u}> you were invited to this deal by <@${by}>.`, allowedMentions: { users: [u] } });
  return nd;
}

/** The creator types @user or a user ID in the room while the deal is at the partner step. */
export async function partnerFromMessage(msg, ctx) {
  if (msg.author.bot || !msg.guild) return;
  const d = ctx.db.prepare("SELECT * FROM deals WHERE channel_id=? AND status='waiting_parties'").get(msg.channelId);
  if (!d || d.party_a !== msg.author.id || ctx.deals.setup(d).step !== 'partner') return;
  const u = msg.mentions.users.first()?.id ?? msg.content.match(/\b\d{15,25}\b/)?.[0];
  if (!u) { await msg.reply({ content: 'Mention the other trader (**@user**) or send their **user ID**.', allowedMentions: { repliedUser: false } }).catch(() => {}); return; }
  try {
    const nd = await addPartner(ctx, d.id, msg.author.id, u, msg.guild, msg.channel);
    const sm = await msg.channel.messages.fetch(d.status_message_id).catch(() => null);
    if (sm) await putStep(ctx, msg.channel, sm, nd, await payloadFor(ctx, nd));
    await msg.delete().catch(() => {});
  } catch (e) {
    if (e instanceof UserError) await msg.reply({ content: e.message, allowedMentions: { repliedUser: false } }).catch(() => {});
    else log.error('partner message failed', e);
  }
}

// ---------- steps ----------
export const handlers = {
  async type(i, ctx, [id]) {
    const d = load(ctx, id); if (d.party_a !== i.user.id) throw new UserError('Only the deal creator can pick the deal type.'); stepIs(ctx, d, 'type');
    const v = i.values?.[0]; if (!ui.DEAL_TYPES.some((t) => t.value === v)) throw new UserError('Invalid deal type.');
    const nd = await locked(ctx, id, async () => ctx.deals.patch(id, i.user.id, { deal_type: v, setup: setStep(ctx, d, 'partner') }, 'setup.type'));
    return done(i, ctx, nd);
  },
  async partner(i, ctx, [id], uid) {
    const u = uid ?? i.users?.first?.()?.id;
    const nd = await addPartner(ctx, id, i.user.id, u, i.guild, i.channel);
    return done(i, ctx, nd);
  },
  partnermodal: (i, ctx, [id]) => handlers.partner(i, ctx, [id], i.fields.getTextInputValue('uid').replace(/[<@!>\s]/g, '')),
  partnerid: (i, ctx, [id]) => { const d = load(ctx, id); if (d.party_a !== i.user.id) throw new UserError('Only the deal creator can add the other trader.'); return i.showModal(ui.partnerIdModal(id)); },
  async role(i, ctx, [id, role]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'roles');
    if (!['sender', 'receiver'].includes(role)) throw new UserError('Invalid role.');
    const nd = await locked(ctx, id, async () => {
      const set = ctx.deals.setup(load(ctx, id)); const votes = { ...set.votes };
      const holder = Object.entries(votes).find(([u, r]) => r === role && u !== i.user.id);
      if (holder) throw new UserError(`That role is already taken by <@${holder[0]}>.`);
      votes[i.user.id] = role;
      const sender = Object.keys(votes).find((u) => votes[u] === 'sender'); const receiver = Object.keys(votes).find((u) => votes[u] === 'receiver');
      if (sender && receiver) return ctx.deals.patch(id, i.user.id, { sender_id: sender, receiver_id: receiver, setup: { ...set, step: 'describe', votes: {} } }, 'setup.roles_set');
      return ctx.deals.patch(id, i.user.id, { setup: { ...set, votes } }, 'setup.role_vote', { silent: true });
    });
    return done(i, ctx, nd);
  },
  async rolereset(i, ctx, [id]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'roles');
    return done(i, ctx, await locked(ctx, id, async () => ctx.deals.patch(id, i.user.id, { setup: setStep(ctx, d, 'roles') }, 'setup.roles_reset', { silent: true })));
  },
  describe: (i, ctx, [id]) => { const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'describe'); return i.showModal(ui.descModal(id)); },
  async descmodal(i, ctx, [id]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'describe');
    const item = V.text(i.fields.getTextInputValue('desc'), { min: 5, max: 300, label: 'Description' });
    const nd = await locked(ctx, id, async () => ctx.deals.patch(id, i.user.id, { item, desc_by: i.user.id, setup: setStep(ctx, d, 'accept') }, 'setup.described'));
    return done(i, ctx, nd);
  },
  async accept(i, ctx, [id]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'accept');
    if (d.desc_by === i.user.id) throw new UserError('The other trader has to accept your description.');
    return done(i, ctx, await locked(ctx, id, async () => ctx.deals.patch(id, i.user.id, { setup: setStep(ctx, d, 'amount') }, 'setup.description_accepted')));
  },
  async decline(i, ctx, [id]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'accept');
    if (d.desc_by === i.user.id) throw new UserError('Only the other trader can decline.');
    return done(i, ctx, await locked(ctx, id, async () => ctx.deals.patch(id, i.user.id, { item: '', desc_by: null, setup: setStep(ctx, d, 'describe') }, 'setup.description_declined')));
  },
  amount: (i, ctx, [id]) => { const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'amount'); return i.showModal(ui.amountModal(id)); },
  async amountmodal(i, ctx, [id]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'amount');
    const amount = V.usdAmount(i.fields.getTextInputValue('amount'));
    return done(i, ctx, await locked(ctx, id, async () => ctx.deals.patch(id, i.user.id, { amount, setup: setStep(ctx, d, 'amount_confirm') }, 'setup.amount_set')));
  },
  async amtno(i, ctx, [id]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'amount_confirm');
    return done(i, ctx, await locked(ctx, id, async () => ctx.deals.patch(id, i.user.id, { setup: setStep(ctx, d, 'amount') }, 'setup.amount_rejected')));
  },
  async amtok(i, ctx, [id]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'amount_confirm');
    const nd = await locked(ctx, id, async () => {
      const cur = load(ctx, id); const set = ctx.deals.setup(cur); const votes = { ...set.votes, [i.user.id]: 'confirmed' };
      if (Object.keys(votes).length < 2) return ctx.deals.patch(id, i.user.id, { setup: { ...set, votes } }, 'setup.amount_vote', { silent: true });
      const fee = calcFee(cur.amount, ctx.cfg.fee);
      const fields = { confirmed_a: 1, confirmed_b: 1, fee_usd: fee.toFixed(2) };
      if (fee > 0) return ctx.deals.patch(id, i.user.id, { ...fields, setup: setStep(ctx, cur, 'fee') }, 'setup.amount_confirmed');
      const p = ctx.deals.patch(id, i.user.id, { ...fields, setup: setStep(ctx, cur, 'payment') }, 'setup.amount_confirmed');
      return finalize(ctx, p);
    });
    return done(i, ctx, nd);
  },
  async fee(i, ctx, [id, choice]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'fee');
    if (!['sender', 'receiver', 'split'].includes(choice)) throw new UserError('Invalid choice.');
    let mismatch = false;
    const nd = await locked(ctx, id, async () => {
      const cur = load(ctx, id); const set = ctx.deals.setup(cur); const votes = { ...set.votes, [i.user.id]: choice };
      const vals = Object.values(votes);
      if (vals.length < 2) return ctx.deals.patch(id, i.user.id, { setup: { ...set, votes } }, 'setup.fee_vote', { silent: true });
      if (vals[0] !== vals[1]) { mismatch = true; return ctx.deals.patch(id, i.user.id, { setup: { ...set, votes: {} } }, 'setup.fee_disagreement', { silent: true }); }
      const p = ctx.deals.patch(id, i.user.id, { fee_payer: choice, setup: setStep(ctx, cur, 'payment') }, 'setup.fee_agreed');
      return finalize(ctx, p);
    });
    if (mismatch) await i.channel.send({ content: 'The two fee choices did not match, so both were reset. Please choose again.', allowedMentions: { parse: [] } }).catch(() => {});
    return done(i, ctx, nd);
  },
};

/** Totals are computed, the provider is asked for an escrow, and the deal goes live. */
async function finalize(ctx, deal) {
  const t = calcTotals(deal.amount, deal.fee_usd, deal.fee_payer);
  const withTotals = ctx.deals.patch(deal.id, 'system', { send_usd: t.send, receive_usd: t.receive }, 'setup.totals_calculated');
  let escrow;
  try { escrow = await ctx.provider.createEscrow(withTotals); } catch (e) { if (e.userFacing) throw new UserError(e.message); throw e; }
  return ctx.deals.activate(deal.id, { provider: ctx.provider.name, reference: escrow.reference, channelId: deal.channel_id, address: escrow.address, payAmount: escrow.payAmount, rateUsd: escrow.rateUsd });
}

// ---------- close ----------
export async function closeDeal(i, ctx, id, { staffCan }) {
  const d = load(ctx, id);
  const isStaff = staffCan('dispute.review');
  if (!ctx.deals.isParty(d, i.user.id) && !isStaff) throw new UserError('Only the traders and staff can close this deal.');
  const final = ['completed', 'cancelled'].includes(d.status);
  if (!final) {
    if (!ctx.deals.isParty(d, i.user.id) && !staffCan('deal.cancel')) throw new UserError('You cannot cancel this deal.');
    if (d.status === 'disputed') throw new UserError('Disputed deals are resolved by the provider and cannot be closed.');
    ctx.deals.cancel(d.id, i.user.id, 'closed by user', { staff: !ctx.deals.isParty(d, i.user.id) });
    try { await ctx.provider.cancelEscrow?.(d); } catch (e) { log.error('provider cancel failed', e); }
  } else if (!isStaff) throw new UserError('Staff close finished deal rooms after saving the transcript.');
  await i.deferReply({ flags: EPH });
  await rooms.saveTranscript(ctx, d.id, i.channel, i.user.id);
  await i.editReply({ embeds: [ui.okEmbed(ctx.cfg, 'Deal closed', 'Transcript saved. This room will be removed shortly.')] });
  setTimeout(() => i.channel.delete('Deal closed').catch(() => {}), 8000).unref?.();
}

// ---------- release ----------
export async function releaseAsk(i, ctx, id) {
  const d = load(ctx, id);
  if (d.sender_id !== i.user.id) throw new UserError('Only the sender can release the payment.');
  if (d.status !== 'verification_pending' || d.escrow_status !== 'provider_confirmed') throw new UserError('The provider has not confirmed the payment yet.');
  if (d.release_at) throw new UserError('A release is already in progress.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nx:am-relyes:${id}`).setLabel('Yes, release').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`nx:am-relno:${id}`).setLabel('No, go back').setStyle(ButtonStyle.Secondary));
  return i.reply({ flags: EPH, embeds: [ui.base(ctx.cfg, 'Are you sure?', `Releasing sends **$${d.receive_usd} USD** worth of ${d.asset} to <@${d.receiver_id}>. **This cannot be undone.** Only release once you have received what you were promised.\n\nA ${ctx.cfg.releaseDelaySec}-second countdown starts, and you can cancel it until it ends.`, ui.BRAND.red)], components: [row] });
}
export const releaseNo = (i) => i.update({ content: 'Release not started.', embeds: [], components: [] });
export async function releaseYes(i, ctx, id) {
  const r = await locked(ctx, id, async () => ctx.deals.scheduleRelease(id, i.user.id, ctx.cfg.releaseDelaySec));
  await i.update({ content: r.started ? 'Release countdown started.' : 'A release is already in progress.', embeds: [], components: [] });
  if (!r.started) return;
  const at = Math.floor(Date.parse(r.deal.release_at) / 1000);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nx:am-relcancel:${id}`).setLabel('Cancel release').setStyle(ButtonStyle.Danger));
  await i.channel.send({ embeds: [ui.base(ctx.cfg, 'Release countdown', `<@${i.user.id}> started a release.\nFunds are released <t:${at}:R> (at <t:${at}:T>).\nOnly <@${i.user.id}> can cancel before then.`, ui.BRAND.red)], components: [row], allowedMentions: { parse: [] } });
  await rooms.refreshStatus(ctx, ctx.deals.get(id));
  armRelease(ctx, id);
}
export async function releaseCancel(i, ctx, id) {
  await locked(ctx, id, async () => ctx.deals.cancelRelease(id, i.user.id));
  clearTimeout(timers.get(id)); timers.delete(id);
  return i.update({ content: `Release cancelled by <@${i.user.id}>.`, embeds: [], components: [], allowedMentions: { parse: [] } });
}
const timers = new Map();
export function armRelease(ctx, id) {
  const d = ctx.deals.get(id); if (!d?.release_at) return;
  clearTimeout(timers.get(id)); timers.delete(id);
  const wait = Math.max(0, Date.parse(d.release_at) - Date.now());
  const t = setTimeout(() => { timers.delete(id); fireRelease(ctx, id).catch((e) => log.error('release failed', e)); }, wait);
  t.unref?.(); timers.set(id, t);
}
export async function fireRelease(ctx, id) {
  const r = await ctx.limiter.once(`fire:${id}`, async () => {
    const d = ctx.deals.releaseDue(id); if (!d) return 'skipped';
    ctx.deals.markReleased(id); // sender's release is approved; payout waits for the receiver's address
    audit(ctx.db, { actor: 'system', action: 'release.sent_to_provider', dealId: id, detail: { by: d.release_by } });
    await ctx.provider.requestRelease(d);
    return 'sent';
  });
  return r.value;
}

// ---------- payout address (after release) ----------
export function payAddr(i, ctx, id) {
  const d = load(ctx, id);
  if (d.receiver_id !== i.user.id) throw new UserError('Only the receiver can provide the payout address.');
  if (d.status !== 'verification_pending' || !d.released_at || d.payout_address) throw new UserError('No payout address is needed right now.');
  return i.showModal(ui.payoutModal(id, d.asset));
}
export async function payAddrSubmit(i, ctx, id, raw) {
  const d = load(ctx, id);
  if (d.receiver_id !== i.user.id) throw new UserError('Only the receiver can provide the payout address.');
  const addr = V.payoutAddress(d.asset, d.network, raw);
  try { ctx.provider.validateAddress?.(addr, d); } catch (e) { throw new UserError(e.message); }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nx:am-payyes:${id}:${addr}`).setLabel('Yes, this is correct').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`nx:am-payno:${id}`).setLabel('No, re-enter').setStyle(ButtonStyle.Secondary));
  return i.reply({ flags: EPH, embeds: [ui.base(ctx.cfg, 'Confirm your address', `Payout address (${d.asset} on ${d.network}):\n\`${addr}\`\n**Payouts cannot be reversed.** Confirm only if this is exactly your address.`, ui.BRAND.red)], components: [row] });
}
export async function payAddrConfirm(i, ctx, id, raw) {
  const d = load(ctx, id);
  if (d.receiver_id !== i.user.id) throw new UserError('Only the receiver can confirm the payout address.');
  if (d.payout_address) throw new UserError('The payout address is already confirmed.');
  const addr = V.payoutAddress(d.asset, d.network, raw);
  await locked(ctx, id, async () => ctx.deals.setPayout(id, i.user.id, addr));
  await i.update({ content: null, embeds: [ui.base(ctx.cfg, 'Address confirmed', `Payout address: \`${addr}\`\nThe payout is being sent.`)], components: [] });
  const fresh = ctx.deals.get(id);
  await rooms.refreshStatus(ctx, fresh);
  const res = await ctx.provider.requestPayout(fresh);
  audit(ctx.db, { actor: 'system', action: 'payout.requested_from_provider', dealId: id, detail: {} });
  if (res?.simulateEvent && ctx.mode === 'demo') ctx.deals.applyProviderEvent({ id: `sim-payout-${crypto.randomUUID()}`, type: res.simulateEvent, reference: fresh.provider_ref }, { simulated: true });
}
export function recoverReleases(ctx) {
  for (const d of ctx.db.prepare("SELECT id FROM deals WHERE release_at IS NOT NULL AND status='verification_pending'").all()) armRelease(ctx, d.id);
}

/** The receiver types their payout address in the room after the sender released. The bot checks it and asks them to confirm. */
export async function payoutFromMessage(msg, ctx) {
  if (msg.author.bot || !msg.guild) return;
  const d = ctx.db.prepare("SELECT * FROM deals WHERE channel_id=? AND status='verification_pending' AND released_at IS NOT NULL AND payout_address IS NULL").get(msg.channelId);
  if (!d || d.receiver_id !== msg.author.id) return;
  const raw = msg.content.trim().split(/\s+/)[0];
  if (!raw) return;
  try {
    const addr = V.payoutAddress(d.asset, d.network, raw);
    try { ctx.provider.validateAddress?.(addr, d); } catch (e) { throw new UserError(e.message); }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nx:am-payyes:${d.id}:${addr}`).setLabel('Yes, this is correct').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`nx:am-payno:${d.id}`).setLabel('No, re-enter').setStyle(ButtonStyle.Secondary));
    await msg.channel.send({ content: `<@${d.receiver_id}>`, embeds: [ui.base(ctx.cfg, 'Confirm your address', `**Payout address** (${d.asset} on ${d.network}):\n\`${addr}\`\n\n**Payouts cannot be reversed.** Confirm only if this is **exactly your address**.`)], components: [row], allowedMentions: { users: [d.receiver_id] } });
    await msg.delete().catch(() => {});
  } catch (e) {
    if (e instanceof UserError || e?.name === 'ValidationError' || e?.constructor?.name === 'ValidationError') await msg.reply({ content: `${e.message} Send your ${d.asset} address again.`, allowedMentions: { repliedUser: false } }).catch(() => {});
    else log.error('payout address message failed', e);
  }
}
