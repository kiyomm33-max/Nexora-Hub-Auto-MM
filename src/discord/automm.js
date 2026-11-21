import crypto from 'node:crypto';
import { MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder } from 'discord.js';
import QRCode from 'qrcode';
import * as V from '../core/validate.js';
import { DealError } from '../core/deals.js';
import { audit } from '../core/audit.js';
import { calcFee, calcTotals, usdWorth } from '../core/fees.js';
import { CAPS, LEVELS } from '../core/permissions.js';
import { log } from '../logger.js';
import * as ui from './ui.js';
import * as rooms from './rooms.js';

export class UserError extends Error {}
const EPH = MessageFlags.Ephemeral;

/** Who gets pinged when this deal's message is (re)posted. */
export function pingIds(ctx, d) {
  const ids = (...x) => x.filter(Boolean);
  if (d.status === 'waiting_parties') {
    const set = ctx.deals.setup(d);
    switch (set.step) {
      case 'type': case 'partner': return ids(d.party_a);
      case 'accept': return ids(d.desc_by === d.party_a ? d.party_b : d.party_a);
      case 'fee': return ids(d.sender_id);
      case 'fee_confirm': return ids(d.receiver_id);
      default: return ids(d.party_a, d.party_b);
    }
  }
  const ph = ui.phaseOf(d);
  if (ph === 'invoice') return ids(d.sender_id);
  if (ph === 'payout') return ids(d.receiver_id);
  if (['detected', 'received', 'paying', 'short'].includes(ph)) return ids(d.sender_id, d.receiver_id);
  return [];
}

export const markPosted = (id, p) => posted.set(id, sigOf(p));
export async function payloadFor(ctx, d) {
  if (d.status === 'waiting_parties') {
    const p = { files: [], ...ui.stepPayload(ctx.cfg, d, ctx.deals.setup(d)) };
    if (!((p.flags ?? 0) & (1 << 15))) p.content = pingIds(ctx, d).map((x) => `<@${x}>`).join(' ') || undefined;
    return p;
  }
  const embeds = ui.statusEmbeds(ctx.cfg, d); const files = [];
  if (ui.phaseOf(d) === 'invoice' && d.pay_address) {
    try { files.push(new AttachmentBuilder(await QRCode.toBuffer(d.pay_address, { margin: 1, width: 220 }), { name: 'qr.png' })); embeds[1].setThumbnail('attachment://qr.png'); }
    catch (e) { log.error('qr failed', e); }
  }
  const ping = pingIds(ctx, d).map((x) => `<@${x}>`).join(' ') || null;
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
/** Post a deal's current payload as a NEW message that pings the people who need to act, then delete the previous one. */
const posted = new Map();
export const sigOf = (p) => JSON.stringify({ c: p.content ?? null, e: p.embeds, k: p.components, f: p.flags ?? 0 });
export async function putStep(ctx, channel, msg, d, p, { force = false } = {}) {
  const sig = sigOf(p);
  if (!force && msg && posted.get(d.id) === sig) return msg; // the same state was just posted (button handler and room sync both ask)
  posted.set(d.id, sig);
  const m = await channel.send({ ...p, content: (p.flags ?? 0) & V2 ? undefined : (p.content ?? undefined), allowedMentions: { users: pingIds(ctx, d) } });
  ctx.deals.setChannel(d.id, 'status_message_id', m.id);
  const prev = d.status_message_id && d.status_message_id !== msg?.id ? await channel.messages.fetch(d.status_message_id).catch(() => null) : null;
  for (const x of [msg, prev]) if (x && x.id !== m.id) await x.delete?.().catch(() => {});
  return m;
}
const done = async (i, ctx, d) => {
  const p = await payloadFor(ctx, d);
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
  const d = load(ctx, id); if (d.party_a !== by) throw new UserError('Only the deal creator can add the other trader.'); stepIs(ctx, d, 'partner', 'type');
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
    if (i.user.id !== d.sender_id) throw new UserError('Only the **sender** can choose how the fee is handled.');
    if (!['sender', 'receiver', 'split'].includes(choice)) throw new UserError('Invalid choice.');
    const nd = await locked(ctx, id, async () => { const cur = load(ctx, id); return ctx.deals.patch(id, i.user.id, { setup: { ...setStep(ctx, cur, 'fee_confirm'), pending: choice } }, 'setup.fee_chosen'); });
    return done(i, ctx, nd);
  },
  async feeno(i, ctx, [id]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'fee_confirm');
    if (i.user.id !== d.receiver_id) throw new UserError('Only the **receiver** can answer this.');
    const nd = await locked(ctx, id, async () => { const cur = load(ctx, id); return ctx.deals.patch(id, i.user.id, { setup: { ...setStep(ctx, cur, 'fee'), pending: null } }, 'setup.fee_rejected'); });
    return done(i, ctx, nd);
  },
  async feeok(i, ctx, [id]) {
    const d = load(ctx, id); trader(ctx, d, i); stepIs(ctx, d, 'fee_confirm');
    if (i.user.id !== d.receiver_id) throw new UserError('Only the **receiver** can answer this.');
    const nd = await locked(ctx, id, async () => {
      const cur = load(ctx, id); const choice = ctx.deals.setup(cur).pending;
      if (!['sender', 'receiver', 'split'].includes(choice)) throw new UserError('No fee option was chosen yet.');
      const p = ctx.deals.patch(id, i.user.id, { fee_payer: choice, setup: setStep(ctx, cur, 'payment') }, 'setup.fee_agreed');
      return finalize(ctx, p);
    });
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
/** Close a deal room. Staff close at once; the two traders must BOTH agree (one asks, the other agrees). */
export async function closeDeal(i, ctx, id, { staffCan }) {
  const d = load(ctx, id);
  const isStaff = staffCan('dispute.review');
  const party = ctx.deals.isParty(d, i.user.id);
  if (!party && !isStaff) throw new UserError('Only the traders and staff can close this deal.');
  if (!isStaff) {
    const final = ['completed', 'cancelled'].includes(d.status);
    if (!final && d.status === 'disputed') throw new UserError('Disputed deals are resolved by the provider and cannot be closed.');
    if (!final && (d.escrow_status === 'provider_confirmed' || d.observed_status !== 'none')) throw new UserError('Funds have been seen or secured by the provider, so the room cannot just be closed. Use **Cancel & refund** or ask staff.');
    if (!d.party_b) throw new UserError('Add the other trader first, or ask staff to close this room.');
    const req = ctx.db.prepare('SELECT * FROM close_req WHERE deal_id=?').get(id);
    if (req && req.requested_by !== i.user.id) return performClose(i, ctx, d, true); // the other trader pressed Close too: that is agreement
    if (req) throw new UserError('You already asked to close. The other trader must agree.');
    ctx.db.prepare('INSERT INTO close_req(deal_id, requested_by, created_at) VALUES(?,?,?)').run(id, i.user.id, new Date().toISOString());
    audit(ctx.db, { actor: i.user.id, action: 'close.requested', dealId: id, detail: {} });
    const o = other(d, i.user.id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nx:am-closeyes:${id}`).setLabel('Agree to close').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`nx:am-closeno:${id}`).setLabel('Decline').setStyle(ButtonStyle.Secondary));
    const m = await i.channel.send({ content: `<@${o}>`, embeds: [ui.base(ctx.cfg, 'Close request', `<@${i.user.id}> wants to **close this ${final ? 'room' : 'deal'}**.\n\n**Both traders must agree.** <@${o}>, do you agree?${final ? '' : '\nThe deal will be cancelled.'}`)], components: [row], allowedMentions: { users: [o] } });
    ctx.db.prepare('UPDATE close_req SET message_id=? WHERE deal_id=?').run(m.id, id);
    return i.reply({ flags: EPH, content: 'Close request sent. The other trader must agree.' });
  }
  return performClose(i, ctx, d, false);
}
export async function closeYes(i, ctx, id) {
  const d = load(ctx, id); const req = ctx.db.prepare('SELECT * FROM close_req WHERE deal_id=?').get(id);
  if (!ctx.deals.isParty(d, i.user.id)) throw new UserError('Only the two traders in this deal can do that.');
  if (!req) throw new UserError('There is no open close request.');
  if (req.requested_by === i.user.id) throw new UserError('You already asked to close. The other trader must agree.');
  return performClose(i, ctx, d, true);
}
export async function closeNo(i, ctx, id) {
  const d = load(ctx, id); const req = ctx.db.prepare('SELECT * FROM close_req WHERE deal_id=?').get(id);
  if (!ctx.deals.isParty(d, i.user.id)) throw new UserError('Only the two traders in this deal can do that.');
  if (!req) throw new UserError('There is no open close request.');
  ctx.db.prepare('DELETE FROM close_req WHERE deal_id=?').run(id);
  audit(ctx.db, { actor: i.user.id, action: 'close.declined', dealId: id, detail: {} });
  await i.deferUpdate();
  if (req.message_id) await i.channel.messages.fetch(req.message_id).then((m) => m.delete()).catch(() => {});
  await i.channel.send({ embeds: [ui.base(ctx.cfg, 'Close request declined', `<@${i.user.id}> declined. **The room stays open.**`)], allowedMentions: { parse: [] } });
}
async function performClose(i, ctx, d, agreed) {
  const final = ['completed', 'cancelled'].includes(d.status);
  if (!final) {
    if (d.status === 'disputed') throw new UserError('Disputed deals are resolved by the provider and cannot be closed.');
    ctx.deals.cancel(d.id, i.user.id, agreed ? 'both traders agreed to close' : 'closed by staff', { staff: !ctx.deals.isParty(d, i.user.id) });
    try { await ctx.provider.cancelEscrow?.(d); } catch (e) { log.error('provider cancel failed', e); }
  }
  const req = ctx.db.prepare('SELECT * FROM close_req WHERE deal_id=?').get(d.id);
  ctx.db.prepare('DELETE FROM close_req WHERE deal_id=?').run(d.id);
  if (req) audit(ctx.db, { actor: i.user.id, action: 'close.agreed', dealId: d.id, detail: {} });
  await i.deferReply({ flags: EPH });
  if (req?.message_id) await i.channel.messages.fetch(req.message_id).then((m) => m.delete()).catch(() => {});
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
  if (ctx.db.prepare('SELECT 1 FROM cancel_req WHERE deal_id=?').get(id)) throw new UserError('A cancel request is open. Finish or decline it before releasing.');
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

// ---------- short payment: continue with what arrived, or get exactly that back ----------
export async function shortYes(i, ctx, id) {
  const d = load(ctx, id);
  if (d.sender_id !== i.user.id) throw new UserError('Only the sender can choose.');
  if (d.short_state !== 'pending') throw new UserError('This choice was already made.');
  if (cancelRow(ctx, id)) throw new UserError('A refund is already in progress for this deal.');
  await i.deferUpdate();
  const nd = await locked(ctx, id, async () => {
    let r;
    try { r = await ctx.provider.acceptShort(id); } catch (e) { throw new UserError(e?.userFacing ? e.message : 'Could not read the payment from the chain right now. Try again in a minute.'); }
    return ctx.deals.acceptShort(id, i.user.id, r.amount, usdWorth(d, r.amount), ctx.cfg.fee);
  });
  return nd;
}
export async function shortNo(i, ctx, id) {
  const d = load(ctx, id);
  if (d.sender_id !== i.user.id) throw new UserError('Only the sender can choose.');
  if (d.short_state !== 'pending') throw new UserError('This choice was already made.');
  const started = await locked(ctx, id, async () => {
    if (cancelRow(ctx, id)) return false;
    ctx.db.prepare("INSERT INTO cancel_req(deal_id, requested_by, agreed, state, created_at) VALUES(?,?,?,?,?)").run(id, i.user.id, JSON.stringify([i.user.id]), 'address', new Date().toISOString());
    audit(ctx.db, { actor: i.user.id, action: 'payment.short_cancel_chosen', dealId: id, detail: { received: d.short_crypto } });
    return true;
  });
  if (!started) throw new UserError('A refund is already in progress for this deal.');
  await i.deferUpdate(); await i.message?.edit?.({ components: [] }).catch?.(() => {});
  const m = await i.channel.send({ content: `<@${d.sender_id}>`, embeds: [ui.base(ctx.cfg, 'Cancelled: type your address to get your money back', `<@${d.sender_id}>, **type your ${d.asset} address in this room**. The bot sends back **exactly what you sent** (\`${d.short_crypto}\` ${d.asset}), minus the network fee.\n\nCheck it carefully: **refunds are sent on-chain and cannot be reversed.**`, ui.BRAND.red)], allowedMentions: { users: [d.sender_id] } });
  ctx.db.prepare('UPDATE cancel_req SET message_id=? WHERE deal_id=?').run(m.id, id);
}

// ---------- mutual cancel + refund (funds in escrow, before any release) ----------
const cancelRow = (ctx, id) => ctx.db.prepare('SELECT * FROM cancel_req WHERE deal_id=?').get(id);
const other = (d, u) => (u === d.party_a ? d.party_b : d.party_a);
function cancelable(d) {
  if (d.short_state === 'pending' && d.status === 'verification_pending' && d.escrow_status !== 'provider_confirmed' && !d.release_at && !d.released_at) return; // short payment: the sender may take it back
  if (d.status !== 'verification_pending' || d.escrow_status !== 'provider_confirmed') throw new UserError('Cancel & refund is only available once your payment is confirmed in escrow.');
  if (d.release_at || d.released_at) throw new UserError('The release already started. Cancel the release first, or ask staff.');
}
export async function cancelAsk(i, ctx, id) {
  const d = load(ctx, id);
  if (!ctx.deals.isParty(d, i.user.id)) throw new UserError('Only the two traders in this deal can do that.');
  cancelable(d);
  const r = await locked(ctx, id, async () => {
    if (cancelRow(ctx, id)) return false;
    ctx.db.prepare("INSERT INTO cancel_req(deal_id, requested_by, agreed, state, created_at) VALUES(?,?,?,?,?)").run(id, i.user.id, JSON.stringify([i.user.id]), 'asking', new Date().toISOString());
    audit(ctx.db, { actor: i.user.id, action: 'cancel.requested', dealId: id, detail: {} });
    return true;
  });
  if (!r) throw new UserError('A cancel request is already open.');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nx:am-cancelyes:${id}`).setLabel('Agree to cancel').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`nx:am-cancelno:${id}`).setLabel('Decline').setStyle(ButtonStyle.Secondary));
  const o = other(d, i.user.id);
  const m = await i.channel.send({ content: `<@${o}>`, embeds: [ui.base(ctx.cfg, 'Cancel request', `<@${i.user.id}> wants to **cancel this deal and refund the sender**.\n\n**Both traders must agree.** <@${o}>, do you agree?\nThe funds go back to the sender, the receiver gets nothing.`, ui.BRAND.red)], components: [row], allowedMentions: { users: [o] } });
  ctx.db.prepare('UPDATE cancel_req SET message_id=? WHERE deal_id=?').run(m.id, id);
  return i.reply({ flags: EPH, content: 'Cancel request sent. The other trader must agree.' });
}
async function dropRequestMessage(ctx, i, c) {
  if (c?.message_id) await i.channel.messages.fetch(c.message_id).then((m) => m.delete()).catch(() => {});
}
export async function cancelYes(i, ctx, id) {
  const d = load(ctx, id); const c = cancelRow(ctx, id);
  if (!ctx.deals.isParty(d, i.user.id)) throw new UserError('Only the two traders in this deal can do that.');
  if (!c || c.state !== 'asking') throw new UserError('There is no open cancel request.');
  if (c.requested_by === i.user.id) throw new UserError('You already asked to cancel. The other trader must agree.');
  cancelable(d);
  await locked(ctx, id, async () => {
    ctx.db.prepare("UPDATE cancel_req SET state='address', agreed=? WHERE deal_id=? AND state='asking'").run(JSON.stringify([c.requested_by, i.user.id]), id);
    audit(ctx.db, { actor: i.user.id, action: 'cancel.agreed', dealId: id, detail: {} });
  });
  await i.deferUpdate(); await dropRequestMessage(ctx, i, c);
  const m = await i.channel.send({ content: `<@${d.sender_id}>`, embeds: [ui.base(ctx.cfg, 'Both traders agreed to cancel', `<@${d.sender_id}>, **type your ${d.asset} address in this room** to get your funds back.\n\nCheck it carefully: **refunds are sent on-chain and cannot be reversed.**`, ui.BRAND.red)], allowedMentions: { users: [d.sender_id] } });
  ctx.db.prepare('UPDATE cancel_req SET message_id=? WHERE deal_id=?').run(m.id, id);
}
export async function cancelNo(i, ctx, id) {
  const d = load(ctx, id); const c = cancelRow(ctx, id);
  if (!ctx.deals.isParty(d, i.user.id)) throw new UserError('Only the two traders in this deal can do that.');
  if (!c || c.state === 'refunding') throw new UserError('There is no open cancel request.');
  await locked(ctx, id, async () => { ctx.db.prepare('DELETE FROM cancel_req WHERE deal_id=?').run(id); audit(ctx.db, { actor: i.user.id, action: 'cancel.declined', dealId: id, detail: {} }); });
  await i.deferUpdate(); await dropRequestMessage(ctx, i, c);
  await i.channel.send({ embeds: [ui.base(ctx.cfg, 'Cancel request closed', `<@${i.user.id}> declined. **The deal continues** and the funds stay in escrow.`)], allowedMentions: { parse: [] } });
}
/** After both agreed, the sender types their refund address in the room. The bot validates it and asks for confirmation. */
export async function refundFromMessage(msg, ctx) {
  if (msg.author.bot || !msg.guild) return;
  const d = ctx.db.prepare("SELECT d.* FROM deals d JOIN cancel_req c ON c.deal_id=d.id WHERE d.channel_id=? AND c.state='address'").get(msg.channelId);
  if (!d || d.sender_id !== msg.author.id) return;
  const raw = msg.content.trim().split(/\s+/)[0]; if (!raw) return;
  try {
    const addr = V.payoutAddress(d.asset, d.network, raw);
    try { ctx.provider.validateAddress?.(addr, d); } catch (e) { throw new UserError(e.message); }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nx:am-refyes:${d.id}:${addr}`).setLabel('Yes, this is correct').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`nx:am-refno:${d.id}`).setLabel('No, re-enter').setStyle(ButtonStyle.Secondary));
    await msg.channel.send({ content: `<@${d.sender_id}>`, embeds: [ui.base(ctx.cfg, 'Confirm your refund address', `**Refund address** (${d.asset} on ${d.network}):\n\`${addr}\`\n\n**Refunds cannot be reversed.** Confirm only if this is **exactly your address**.`, ui.BRAND.red)], components: [row], allowedMentions: { users: [d.sender_id] } });
    await msg.delete().catch(() => {});
  } catch (e) {
    if (e instanceof UserError || e?.name === 'ValidationError' || e?.constructor?.name === 'ValidationError') await msg.reply({ content: `${e.message} Send your ${d.asset} address again.`, allowedMentions: { repliedUser: false } }).catch(() => {});
    else log.error('refund address message failed', e);
  }
}
export async function refundYes(i, ctx, id, raw) {
  const d = load(ctx, id);
  if (d.sender_id !== i.user.id) throw new UserError('Only the sender can confirm the refund address.');
  const addr = V.payoutAddress(d.asset, d.network, raw);
  const claim = ctx.db.prepare("UPDATE cancel_req SET state='refunding', address=? WHERE deal_id=? AND state='address'").run(addr, id);
  if (!claim.changes) throw new UserError('This refund is already being processed, or was not agreed by both traders.');
  await i.update({ content: null, embeds: [ui.base(ctx.cfg, 'Sending your refund', `Sending the funds to \`${addr}\`...`)], components: [], allowedMentions: { parse: [] } });
  try {
    cancelable(d);
    const short = d.short_state === 'pending';
    const txid = await ctx.provider.sweep(id, addr);
    ctx.db.prepare('DELETE FROM cancel_req WHERE deal_id=?').run(id);
    ctx.deals.refundCancel(id, i.user.id, { txid, address: addr, short });
    const url = ctx.provider.explorerTx?.(txid, d);
    await i.channel.send({ content: `<@${d.sender_id}> <@${d.receiver_id}>`, embeds: [ui.base(ctx.cfg, 'Deal cancelled and refunded', `${short ? 'The sender cancelled after sending less than the deal amount.' : 'Both traders agreed to cancel.'} The funds were sent back to the sender.\n\n**Refund address:** \`${addr}\`\n**TXID:** \`${txid}\`${url ? `\n[View on explorer](${url})` : ''}`)], allowedMentions: { users: [d.sender_id, d.receiver_id] } });
  } catch (e) {
    ctx.db.prepare("UPDATE cancel_req SET state='address', address=NULL WHERE deal_id=? AND state='refunding'").run(id);
    log.error('refund failed', { deal: id, err: String(e?.message ?? e) });
    await i.channel.send({ content: `<@${d.sender_id}>`, embeds: [ui.base(ctx.cfg, 'Refund failed', `${e instanceof UserError || e?.userFacing ? e.message : 'The refund could not be sent. Nothing was moved. Type your address again to retry, or ask an admin.'}`, ui.BRAND.red)], allowedMentions: { users: [d.sender_id] } });
  }
}
export async function refundNo(i, ctx, id) {
  const d = load(ctx, id);
  if (d.sender_id !== i.user.id) throw new UserError('Only the sender can do that.');
  return i.update({ content: null, embeds: [ui.base(ctx.cfg, 'Address not confirmed', `Type your ${d.asset} refund address in the room again.`)], components: [], allowedMentions: { parse: [] } });
}
