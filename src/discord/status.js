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
  return (p.activities ?? []).some((a) => (a.type === 4 || /custom/i.test(String(a.name ?? ''))) && `${a.state ?? ''} ${a.name ?? ''}`.toLowerCase().includes(phrase));
}
/** The member that comes with a button click has no presence, so Start Earning always said "set your status". Look the member
 *  up in the guild instead: the cache, the guild's presence cache, then Discord (with a time limit, a slow lookup must not eat the 3 seconds a reply gets). */
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
export async function memberWithPresence(ctx, i) {
  const g = guildOf(ctx); const id = i.user.id; let m = g?.members?.cache?.get(id); let fetched = 'skipped';
  if (!m?.presence && !g?.presences?.cache?.get?.(id) && g?.members?.fetch) {
    const r = await within(g.members.fetch({ user: id, withPresences: true, force: true }).then((x) => x, (e) => ({ err: String(e?.message ?? e).slice(0, 60) })), 4000);
    fetched = r === null ? 'timeout' : r?.err ? `error ${r.err}` : 'ok'; if (r && !r.err) m = r;
  }
  const presence = m?.presence ?? g?.presences?.cache?.get?.(id) ?? i.member?.presence ?? null;
  const roles = i.member?.roles?.cache?.size ? i.member.roles : (m?.roles ?? i.member?.roles);
  return { id, roles, presence, found: !!m, fetched, seen: m ? 'member' : g?.presences?.cache?.get?.(id) ? 'presence' : 'none' };
}
/** Every activity the bot was sent, as plain text: the member's own status text is theirs to see. */
export const activityList = (p) => (p?.activities ?? []).map((a) => `type ${a.type} "${String(a.name ?? '').slice(0, 30)}" / "${String(a.state ?? '').slice(0, 60)}"`).join('; ') || 'none';
/** What the bot sees, in words the member can compare with their own status. */
export function seenText(m) {
  if (!m.presence) return 'I cannot see your status at all right now (Discord has not sent it to the bot).';
  const custom = (m.presence.activities ?? []).find((a) => a.type === 4);
  return `I see you as **${m.presence.status}** with ${custom ? `the custom status "${String(custom.state ?? '').slice(0, 60)}"` : 'no custom status'}.`;
}
const guildOf = (ctx) => ctx.client?.guilds?.cache?.get(ctx.cfg.guildId) ?? ctx.client?.guilds?.cache?.first();

/** Enrolled members are often not in the cache (large server, restart, members list not loaded), and then nobody counts.
 *  Ask Discord for exactly those members, with their presence, so the next tick can see their status. */
let warnedFetch = false;
export async function loadEnrolled(ctx) {
  if (!ctx.presenceTracking) return;
  const g = guildOf(ctx); if (!g?.members?.fetch) return;
  const ids = earn.enrolled(ctx.db);
  for (let k = 0; k < ids.length; k += 100) {
    try { await g.members.fetch({ user: ids.slice(k, k + 100), withPresences: true, time: 20_000 }); warnedFetch = false; }
    catch (e) { if (!warnedFetch) { warnedFetch = true; log.warn('status tracking: could not load members and presences', { err: String(e?.message ?? e) }); } }
  }
}
/** Why each enrolled member is or is not counting, for staff. */
export async function statusReport(ctx) {
  const lines = [];
  if (!ctx.presenceTracking) {
    return `**Tracking is OFF.** The bot connected ${ctx.intentLevel === 2 ? 'without the **Presence Intent**' : 'without the **Server Members Intent** and **Presence Intent**'}, so it cannot see anyone's status and **nothing counts**.\n\nFix: Discord Developer Portal > your application > **Bot** > **Privileged Gateway Intents**: turn on **Presence Intent**, **Server Members Intent** and **Message Content Intent**, save, then restart the bot (redeploy).`;
  }
  await loadEnrolled(ctx);
  const g = guildOf(ctx); const ids = earn.enrolled(ctx.db); let counting = 0;
  for (const uid of ids) {
    const m = g?.members?.cache?.get(uid); const p = m?.presence; const phrase = ctx.cfg.statusPhrase.toLowerCase();
    const custom = (p?.activities ?? []).find((a) => a.type === 4);
    const why = !m ? 'not found in the server' : !p ? 'no presence (offline or invisible)' : !['online', 'dnd'].includes(p.status) ? `status is ${p.status} (needs Online or Do Not Disturb)` : !hasRole(m, ctx.cfg) ? 'missing the status role' : !custom ? 'no custom status set' : !String(custom.state ?? '').toLowerCase().includes(phrase) ? `custom status is "${String(custom.state ?? '').slice(0, 40)}" (must contain .${ctx.cfg.statusPhrase})` : 'counting';
    if (why === 'counting') counting++;
    if (lines.length < 20) lines.push(`<@${uid}>: ${why}`);
  }
  return `**Tracking is ON.** ${counting} of ${ids.length} enrolled member${ids.length === 1 ? '' : 's'} counting right now.\n\n${lines.join('\n') || 'Nobody has pressed Start Earning yet.'}`;
}

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
    sweepRooms(ctx).catch(() => {});
    try { earn.closeStale(ctx.db); } catch (e) { log.error('status closeStale failed', e); }
    const run = async () => { await loadEnrolled(ctx); tick(ctx); };
    setTimeout(() => { run().catch((e) => log.error('status tick failed', e)); setInterval(() => { run().catch((e) => log.error('status tick failed', e)); payoutLoop(ctx).catch((e) => log.error('payout loop failed', e)); sweepRooms(ctx).catch((e) => log.error('room sweep failed', e)); }, 60_000).unref?.(); }, 20_000).unref?.();
  });
}

export async function postPanel(ctx, channel) { return channel.send(ui.statusPanelPayload(ctx.cfg)); }

/** Rejects every open payout request (the balances go back to the members), updates the staff cards and deletes the request rooms. Returns how many were cleared. */
export async function clearPending(ctx, staffId) {
  const open = earn.pendingPayouts(ctx.db); let n = 0;
  for (const r of open) {
    try { const done = earn.handlePayout(ctx.db, r.id, 'rejected', staffId); n++; await updateCard(ctx, done); await closeRoom(ctx, done, 0); audit(ctx.db, { category: 'status', actor: staffId, action: 'status.payout.cleared', detail: { id: r.id, cents: r.cents } }); }
    catch (e) { log.warn('clear payout failed', { id: r.id, err: String(e?.message ?? e) }); }
  }
  return n;
}

export async function start(i, ctx) {
  if (!ctx.presenceTracking) throw new UserError('Status tracking is not available right now. Ask staff.');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const m = await memberWithPresence(ctx, i);
  if (!hasRole(m, ctx.cfg)) throw new UserError(`You need the <@&${ctx.cfg.statusRoleId}> role to earn from your status.`);
  if (!ctx.presenceTracking) throw new UserError('Status tracking is switched off because the bot cannot see statuses yet. Staff need to turn on the **Presence Intent** and **Server Members Intent** in the Discord Developer Portal and restart the bot.');
  if (!qualifies(m, ctx.cfg)) { log.info(`start earning refused: source ${m.seen}, lookup ${m.fetched}, status ${m.presence?.status ?? 'none'}, activities ${activityList(m.presence)}`); throw new UserError(`${seenText(m)}\n-# Bot check: source ${m.seen}, lookup ${m.fetched}, activities ${activityList(m.presence)}\nSet your custom status to **Best Auto MM - .${ctx.cfg.statusPhrase}**, stay **Online** or **Do Not Disturb**, then press Start Earning again.`); }
  const fresh = earn.enroll(ctx.db, i.user.id);
  earn.setQualifying(ctx.db, i.user.id, true);
  if (fresh) audit(ctx.db, { category: 'status', actor: i.user.id, action: 'status.enrolled', detail: {} });
  return i.editReply({ embeds: [ui.base(ctx.cfg, 'Earning started', fresh ? 'Your time is now being counted. Keep the status on and stay Online or Do Not Disturb.' : 'You are already earning. Your time keeps adding up.')] });
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
/** Rooms are closed from the database, not a timer, so a restart or deploy cannot leave one open. */
async function closeRoom(ctx, r, ms) {
  if (!r.room_id) return;
  ctx.db.prepare('UPDATE status_payouts SET close_at=? WHERE id=?').run(Date.now() + ms, r.id);
  if (ms <= 0) await sweepRooms(ctx);
}
let sweeping = false;
export async function sweepRooms(ctx) {
  if (sweeping) return; sweeping = true;
  try {
    const due = ctx.db.prepare("SELECT id, room_id FROM status_payouts WHERE close_at IS NOT NULL AND close_at<=? AND room_id IS NOT NULL").all(Date.now());
    for (const r of due) {
      const ch = await fetchCh(ctx, r.room_id);
      try { if (ch) await ch.delete('Status payout finished'); ctx.db.prepare('UPDATE status_payouts SET close_at=NULL, room_id=NULL WHERE id=?').run(r.id); }
      catch (e) { if (e?.code === 10003) ctx.db.prepare('UPDATE status_payouts SET close_at=NULL, room_id=NULL WHERE id=?').run(r.id); else log.error('status payout room delete failed (needs Manage Channels)', { id: r.id, err: String(e) }); }
      if (!ch) ctx.db.prepare('UPDATE status_payouts SET close_at=NULL, room_id=NULL WHERE id=?').run(r.id);
    }
  } finally { sweeping = false; }
}
const say = (ctx, ch, title, text, extra = {}) => ch?.send(ui.asCard({ embeds: [ui.base(ctx.cfg, title, text)], allowedMentions: { users: extra.ping ? [extra.ping] : [] }, content: extra.ping ? `<@${extra.ping}>` : undefined })).catch(() => {});

export async function payout(i, ctx) {
  const ltc = ctx.provider?.ltc;
  if (!ltc?.sendReward) throw new UserError('Payouts are not available right now. Ask staff.');
  const s = earn.summary(ctx.db, i.user.id, ctx.cfg.statusPay);
  if (!s.enrolled) throw new UserError('Press **Start Earning** first.');
  if (!hasRole(i.member, ctx.cfg)) throw new UserError(`You need the <@&${ctx.cfg.statusRoleId}> role to request a payout.`);
  const open = ctx.db.prepare("SELECT room_id FROM status_payouts WHERE user_id=? AND state='pending'").get(i.user.id);
  if (open) throw new UserError(`You already have an open payout request${open.room_id ? ` in <#${open.room_id}>` : ''}. Finish or cancel it first.`);
  const m = await memberWithPresence(ctx, i);
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
  await room.send(ui.asCard({ content: `<@${i.user.id}>`, embeds: [ui.base(ctx.cfg, `<:lock:1575100909191430197> Status payout #${r.id}`, `You are claiming **${earn.usd(r.cents)}**.\n\n**Send your Litecoin (LTC) address** in this channel. I will ask you to confirm it, then send the payment.\n\n**Payments cannot be reversed.** Double-check the address.`)], components: ui.earnRoomButtons(r.id), allowedMentions: { users: [i.user.id] } }, { thumb: 'https://cdn.discordapp.com/emojis/1575122530015125585.png?size=128' })).catch((e) => log.error('payout intro failed', e));
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
