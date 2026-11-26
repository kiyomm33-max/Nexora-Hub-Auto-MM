import { MessageFlags, AttachmentBuilder, Events } from 'discord.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as earn from '../core/earn.js';
import * as V from '../core/validate.js';
import { audit } from '../core/audit.js';
import { log } from '../logger.js';
import * as ui from './ui.js';
import { UserError } from './automm.js';
import { createPrivateChannel } from './rooms.js';
import { LEVELS } from '../core/permissions.js';
import { fromSat } from '../providers/ltc.js';

const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/status.png');
export const logoFile = () => new AttachmentBuilder(LOGO, { name: 'status.png' });
const eph = (ctx, payload) => ({ flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] }, ...payload });

export const hasRole = (member, cfg) => !cfg.statusRoleId || !!member?.roles?.cache?.has?.(cfg.statusRoleId);
/** Online or Do Not Disturb, with the phrase in the custom status. */
export function qualifies(member, cfg) {
  const p = member?.presence;
  if (!p || !['online', 'dnd'].includes(p.status)) return false;
  const phrase = cfg.statusPhrase.toLowerCase();
  if (!hasRole(member, cfg)) return false;
  return (p.activities ?? []).some((a) => a.type === 4 && String(a.state ?? '').toLowerCase().includes(phrase));
}
const guildOf = (ctx) => ctx.client?.guilds?.cache?.get(ctx.cfg.guildId) ?? ctx.client?.guilds?.cache?.first();

export function tick(ctx, at = Date.now()) {
  if (!ctx.presenceTracking) return;
  const g = guildOf(ctx); if (!g) return;
  earn.heartbeat(ctx.db, at);
  for (const uid of earn.enrolled(ctx.db)) {
    const m = g.members.cache.get(uid);
    if (!m) { earn.setQualifying(ctx.db, uid, false, at); continue; }
    earn.setQualifying(ctx.db, uid, qualifies(m, ctx.cfg), at);
  }
}
export function startStatusLoop(client, ctx) {
  client.once(Events.ClientReady, () => {
    try { earn.closeStale(ctx.db); } catch (e) { log.error('status closeStale failed', e); }
    setTimeout(() => { tick(ctx); setInterval(() => { try { tick(ctx); } catch (e) { log.error('status tick failed', e); } payoutLoop(ctx).catch((e) => log.error('payout loop failed', e)); }, 60_000).unref?.(); }, 20_000).unref?.();
  });
}

export async function postPanel(ctx, channel) { return channel.send(ui.statusPanelPayload(ctx.cfg)); }

export async function start(i, ctx) {
  if (!ctx.presenceTracking) throw new UserError('Status tracking is not available right now. Ask staff.');
  const m = i.member ?? await guildOf(ctx)?.members.fetch(i.user.id);
  if (!hasRole(m, ctx.cfg)) throw new UserError(`You need the <@&${ctx.cfg.statusRoleId}> role to earn from your status.`);
  if (!qualifies(m, ctx.cfg)) throw new UserError(`Set your custom status to **Best Auto MM - .${ctx.cfg.statusPhrase}**, stay **Online** or **Do Not Disturb**, then press Start Earning again.`);
  const fresh = earn.enroll(ctx.db, i.user.id);
  earn.setQualifying(ctx.db, i.user.id, true);
  if (fresh) audit(ctx.db, { category: 'status', actor: i.user.id, action: 'status.enrolled', detail: {} });
  return i.reply(eph(ctx, { embeds: [ui.base(ctx.cfg, 'Earning started', fresh ? 'Your time is now being counted. Keep the status on and stay Online or Do Not Disturb.' : 'You are already earning. Your time keeps adding up.')] }));
}
export function time(i, ctx) {
  return i.reply(eph(ctx, { embeds: [ui.earnTimeEmbed(ctx.cfg, earn.summary(ctx.db, i.user.id, ctx.cfg.statusPay))] }));
}

// ---------- payout requests: a private ticket, the member's LTC address, then the bot pays from the rewards wallet ----------
const fetchCh = async (ctx, id) => (id ? (ctx.client?.channels?.cache?.get(id) ?? await ctx.client?.channels?.fetch(id).catch(() => null)) : null);
const staffCh = (ctx) => fetchCh(ctx, ctx.cfg.channels.statusPayouts ?? ctx.cfg.channels.staffLog);
async function postCard(ctx, r) {
  const ch = await staffCh(ctx);
  if (!ch) { log.warn('no staff channel for status payouts: set STATUS_PAYOUT_CHANNEL_ID'); return; }
  const msg = await ch.send({ embeds: [ui.earnPayoutEmbed(ctx.cfg, r, earn.METHODS)], components: ui.earnPayoutButtons(r.id), allowedMentions: { parse: [] } }).catch((e) => { log.error('payout post failed', e); return null; });
  if (msg) earn.setPayoutMessage(ctx.db, r.id, ch.id, msg.id);
}
async function updateCard(ctx, r) {
  if (!r.channel_id || !r.message_id) return;
  const ch = await fetchCh(ctx, r.channel_id); const msg = await ch?.messages?.fetch(r.message_id).catch(() => null);
  await msg?.edit({ embeds: [ui.earnPayoutEmbed(ctx.cfg, r, earn.METHODS)], components: r.state === 'pending' ? ui.earnPayoutButtons(r.id) : [], allowedMentions: { parse: [] } }).catch(() => {});
}
async function closeRoom(ctx, r, ms) { const ch = await fetchCh(ctx, r.room_id); if (ch) setTimeout(() => ch.delete('Status payout finished').catch(() => {}), ms).unref?.(); }
const say = (ctx, ch, title, text, extra = {}) => ch?.send(ui.asCard({ embeds: [ui.base(ctx.cfg, title, text)], allowedMentions: { users: extra.ping ? [extra.ping] : [] }, content: extra.ping ? `<@${extra.ping}>` : undefined })).catch(() => {});

export async function payout(i, ctx) {
  const ltc = ctx.provider?.ltc;
  if (!ltc?.sendReward) throw new UserError('Payouts are not available right now. Ask staff.');
  const s = earn.summary(ctx.db, i.user.id, ctx.cfg.statusPay);
  if (!s.enrolled) throw new UserError('Press **Start Earning** first.');
  if (!hasRole(i.member, ctx.cfg)) throw new UserError(`You need the <@&${ctx.cfg.statusRoleId}> role to request a payout.`);
  const open = ctx.db.prepare("SELECT room_id FROM status_payouts WHERE user_id=? AND state='pending'").get(i.user.id);
  if (open) throw new UserError(`You already have an open payout request${open.room_id ? ` in <#${open.room_id}>` : ''}. Finish or cancel it first.`);
  const m = i.member ?? await guildOf(ctx)?.members.fetch(i.user.id);
  if (!qualifies(m, ctx.cfg)) throw new UserError(`To request a payout your custom status must say **Best Auto MM - .${ctx.cfg.statusPhrase}** and you must be **Online** or **Do Not Disturb**. Fix that, then press Request Payout again.`);
  if (s.available < ctx.cfg.statusPay.minPayoutCents) throw new UserError(`You need at least **${earn.usd(ctx.cfg.statusPay.minPayoutCents)}** to request a payout. You have **${earn.usd(s.available)}** available.`);
  await i.deferReply({ flags: MessageFlags.Ephemeral | (1 << 15) });
  let r;
  try { r = earn.requestPayout(ctx.db, i.user.id, { method: 'ltc', details: '', pay: ctx.cfg.statusPay }); }
  catch (e) { if (e instanceof earn.PayoutError) throw new UserError(e.message); throw e; }
  let room;
  try {
    room = await createPrivateChannel(i.guild, ctx.cfg, { name: `payout-${r.id}`, parent: ctx.cfg.channels.ticketCategory || ctx.cfg.channels.dealCategory, members: [i.user.id], minStaff: LEVELS.admin, topic: `Status payout #${r.id}` });
  } catch (e) {
    earn.handlePayout(ctx.db, r.id, 'rejected', 'system'); // give the balance back
    log.error('payout room failed', e); throw new UserError('I could not open your ticket. Tell staff to give me the **Manage Channels** permission.');
  }
  ctx.db.prepare('UPDATE status_payouts SET room_id=? WHERE id=?').run(room.id, r.id);
  audit(ctx.db, { category: 'status', actor: i.user.id, action: 'status.payout.requested', detail: { id: r.id, cents: r.cents, room: room.id } });
  await room.send(ui.asCard({ content: `<@${i.user.id}>`, embeds: [ui.base(ctx.cfg, `Status payout #${r.id}`, `You are claiming **${earn.usd(r.cents)}**.\n\n**Send your Litecoin (LTC) address** in this channel. I will ask you to confirm it, then send the payment.\n\n**Payments cannot be reversed.** Double-check the address.`)], components: ui.earnRoomButtons(r.id), allowedMentions: { users: [i.user.id] } })).catch((e) => log.error('payout intro failed', e));
  return i.editReply(ui.asCard({ embeds: [ui.base(ctx.cfg, 'Ticket opened', `Your payout request is open in <#${room.id}>. Send your LTC address there.`)] }));
}

/** The member types their address in their payout room; the bot asks them to confirm it. */
export async function addressFromMessage(msg, ctx) {
  if (msg.author.bot || !msg.guild) return;
  const r = ctx.db.prepare("SELECT * FROM status_payouts WHERE room_id=? AND state='pending' AND address_ok=0").get(msg.channelId);
  if (!r || r.user_id !== msg.author.id) return;
  const raw = msg.content.trim().split(/\s+/)[0]; if (!raw) return;
  try {
    const addr = V.payoutAddress('LTC', 'litecoin', raw);
    try { ctx.provider.ltc.validateAddress(addr); } catch (e) { throw new UserError(e.message); }
    await msg.channel.send(ui.asCard({ content: `<@${r.user_id}>`, embeds: [ui.base(ctx.cfg, 'Confirm your address', `**Payout address (LTC):**\n\`${addr}\`\n\n**Amount:** **${earn.usd(r.cents)}** in LTC at today's rate.\n**Payments cannot be reversed.** Confirm only if this is your own address.`)], components: ui.earnAddrButtons(r.id, addr), allowedMentions: { users: [r.user_id] } }));
    await msg.delete().catch(() => {});
  } catch (e) {
    if (e instanceof UserError || e?.name === 'ValidationError' || e?.constructor?.name === 'ValidationError') await msg.reply({ content: `${e.message} Send your LTC address again.`, allowedMentions: { repliedUser: false } }).catch(() => {});
    else log.error('payout address message failed', e);
  }
}
export async function addrYes(i, ctx, [id, addr]) {
  const r = earn.getPayout(ctx.db, id);
  if (!r || r.state !== 'pending') throw new UserError('This request is already finished.');
  if (r.user_id !== i.user.id) throw new UserError('Only the member who requested this payout can confirm the address.');
  if (r.address_ok) throw new UserError('You already confirmed an address for this request.');
  try { ctx.provider.ltc.validateAddress(addr); } catch (e) { throw new UserError(e.message); }
  const ok = ctx.db.prepare("UPDATE status_payouts SET details=?, address_ok=1 WHERE id=? AND state='pending' AND address_ok=0").run(addr, r.id).changes;
  if (!ok) throw new UserError('You already confirmed an address for this request.');
  audit(ctx.db, { category: 'status', actor: i.user.id, action: 'status.payout.address', detail: { id: r.id } });
  await i.update(ui.asCard({ embeds: [ui.base(ctx.cfg, 'Address confirmed', `**${addr}**`)], components: [] }));
  await postCard(ctx, earn.getPayout(ctx.db, r.id));
  await sendPayout(ctx, r.id);
}
export const addrNo = (i, ctx, [id]) => {
  const r = earn.getPayout(ctx.db, id);
  if (!r || r.state !== 'pending' || r.address_ok) throw new UserError('This request is already finished.');
  if (r.user_id !== i.user.id) throw new UserError('Only the member who requested this payout can do that.');
  return i.update(ui.asCard({ embeds: [ui.base(ctx.cfg, 'No problem', 'Send your LTC address again in this channel.')], components: [] }));
};
export async function cancel(i, ctx, [id], { isStaff = false } = {}) {
  const r = earn.getPayout(ctx.db, id);
  if (!r || r.state !== 'pending') throw new UserError('This request is already finished.');
  if (r.user_id !== i.user.id && !isStaff) throw new UserError('Only the member or staff can cancel this request.');
  if (r.send_state) throw new UserError('The payment is already being sent.');
  const done = earn.handlePayout(ctx.db, r.id, 'rejected', i.user.id);
  audit(ctx.db, { category: 'status', actor: i.user.id, action: 'status.payout.cancelled', detail: { id: r.id } });
  await i.update(ui.asCard({ embeds: [ui.base(ctx.cfg, 'Request cancelled', `**${earn.usd(r.cents)}** is back in your balance. This ticket closes in a few seconds.`)], components: [] }));
  await updateCard(ctx, done); await closeRoom(ctx, done, 8000);
}

/** Pay a confirmed request from the rewards wallet. Safe to call repeatedly: the DB claim lets one call send, ever. */
export async function sendPayout(ctx, id) {
  const ltc = ctx.provider?.ltc; if (!ltc?.sendReward) return 'unavailable';
  let r = earn.getPayout(ctx.db, id);
  if (!r || r.state !== 'pending' || !r.address_ok || r.send_state) return 'skip';
  const room = await fetchCh(ctx, r.room_id);
  if (r.cents > ctx.cfg.statusPay.autoMaxCents) {
    if (!r.notified) { ctx.db.prepare('UPDATE status_payouts SET notified=1 WHERE id=?').run(r.id); await say(ctx, room, 'Staff will pay this one', `**${earn.usd(r.cents)}** is above what I send on my own. Staff will pay it and mark it done.`); }
    return 'manual';
  }
  if (!ctx.db.prepare("UPDATE status_payouts SET send_state='sending' WHERE id=? AND state='pending' AND address_ok=1 AND send_state IS NULL").run(id).changes) return 'skip';
  try {
    const t = await ltc.sendReward(r.details, r.cents);
    ctx.db.prepare("UPDATE status_payouts SET send_state='sent' WHERE id=?").run(id);
    r = earn.handlePayout(ctx.db, id, 'paid', 'system', { ref: t.txid });
    audit(ctx.db, { category: 'status', actor: 'system', action: 'status.payout.sent', detail: { id, cents: r.cents, txid: t.txid } });
    await updateCard(ctx, r);
    await say(ctx, room, 'Payment sent', `**${earn.usd(r.cents)}** (**${fromSat(t.sat)} LTC**) was sent to \`${r.details}\`.\n[View transaction](${t.url})\n\nThis ticket closes in 2 minutes.`, { ping: r.user_id });
    await closeRoom(ctx, r, 120_000);
    return 'sent';
  } catch (e) {
    if (e?.uncertain) { // the broadcast may have gone through: never resend on our own
      ctx.db.prepare("UPDATE status_payouts SET send_state='uncertain' WHERE id=?").run(id); // staff decide with Mark paid or Reject
      log.error('status payout broadcast uncertain', { id, err: String(e) });
      audit(ctx.db, { category: 'status', actor: 'system', action: 'status.payout.uncertain', detail: { id, error: String(e.message).slice(0, 200) } });
      await say(ctx, await staffCh(ctx), 'Check payout by hand', `Payout #${id} may or may not have been broadcast (the network did not answer). **I will not retry.** Check the rewards wallet on a block explorer, then use **Mark paid** or **Reject** on the request.`);
      return 'uncertain';
    }
    ctx.db.prepare("UPDATE status_payouts SET send_state=NULL WHERE id=? AND send_state='sending'").run(id);
    if (e?.insufficient) {
      if (!r.notified) {
        ctx.db.prepare('UPDATE status_payouts SET notified=1 WHERE id=?').run(id);
        const { needSat, haveSat } = e.insufficient;
        await say(ctx, room, 'Waiting for funds', `The payout wallet is being topped up. Your **${earn.usd(r.cents)}** will be sent **automatically** as soon as it is. Staff were told.`);
        await say(ctx, await staffCh(ctx), 'Rewards wallet is short', `Payout #${id} needs **${fromSat(needSat)} LTC** but the wallet has **${fromSat(haveSat)} LTC** confirmed.\nDeposit LTC to \`${ltc.rewardsAddress()}\`. It sends by itself once the deposit has 1 confirmation.`);
      }
      return 'waiting';
    }
    log.error('status payout failed (will retry)', { id, err: String(e) });
    return 'retry';
  }
}
export async function payoutLoop(ctx) {
  for (const { id } of ctx.db.prepare("SELECT id FROM status_payouts WHERE state='pending' AND address_ok=1 AND send_state IS NULL ORDER BY id").all()) await sendPayout(ctx, id);
}

export function paidAsk(i, ctx, [id]) { if (!earn.getPayout(ctx.db, id)) throw new UserError('Unknown request.'); return i.showModal(ui.earnPaidModal(id)); }
async function finish(i, ctx, id, state, ref) {
  const cur = earn.getPayout(ctx.db, Number(id));
  if (cur?.send_state === 'sending') throw new UserError('The bot is sending this one right now. Try again in a minute.');
  let r;
  try { r = earn.handlePayout(ctx.db, Number(id), state, i.user.id, { ref }); }
  catch (e) { if (e instanceof earn.PayoutError) throw new UserError(e.message); throw e; }
  audit(ctx.db, { category: 'staff', actor: i.user.id, action: `status.payout.${state}`, detail: { staff: true, id: r.id, cents: r.cents } });
  const payload = { embeds: [ui.earnPayoutEmbed(ctx.cfg, r, earn.METHODS)], components: [], allowedMentions: { parse: [] } };
  if (i.isModalSubmit?.() && i.message) await i.update(payload); else if (i.isButton?.()) await i.update(payload); else await i.reply(eph(ctx, payload));
  const msg = state === 'paid' ? `Your status payout of ${earn.usd(r.cents)} was sent.${r.ref ? ` Reference: ${r.ref}` : ''}` : `Your status payout request of ${earn.usd(r.cents)} was rejected. The amount is back in your balance. Contact staff if you have questions.`;
  if (r.room_id) { await say(ctx, await fetchCh(ctx, r.room_id), state === 'paid' ? 'Marked as paid' : 'Request rejected', msg, { ping: r.user_id }); await closeRoom(ctx, r, 60_000); }
  const u = await ctx.client?.users?.fetch(r.user_id).catch(() => null);
  await u?.send(msg).catch(() => {});
}
export const paidSubmit = (i, ctx, id, ref) => finish(i, ctx, id, 'paid', ref || null);
export const reject = (i, ctx, [id]) => finish(i, ctx, id, 'rejected', null);
