import { MessageFlags, AttachmentBuilder, Events } from 'discord.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as earn from '../core/earn.js';
import * as V from '../core/validate.js';
import { audit } from '../core/audit.js';
import { log } from '../logger.js';
import * as ui from './ui.js';
import { UserError } from './automm.js';

const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/logo.png');
export const logoFile = () => new AttachmentBuilder(LOGO, { name: 'logo.png' });
const eph = (ctx, payload) => ({ flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] }, ...payload });

/** Online or Do Not Disturb, with the phrase in the custom status. */
export function qualifies(member, cfg) {
  const p = member?.presence;
  if (!p || !['online', 'dnd'].includes(p.status)) return false;
  const phrase = cfg.statusPhrase.toLowerCase();
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
    setTimeout(() => { tick(ctx); setInterval(() => { try { tick(ctx); } catch (e) { log.error('status tick failed', e); } }, 60_000).unref?.(); }, 20_000).unref?.();
  });
}

export async function postPanel(ctx, channel) { return channel.send({ ...ui.statusPanelPayload(ctx.cfg), files: [logoFile()] }); }

export async function start(i, ctx) {
  if (!ctx.presenceTracking) throw new UserError('Status tracking is not available right now. Ask staff.');
  const m = i.member ?? await guildOf(ctx)?.members.fetch(i.user.id);
  if (!qualifies(m, ctx.cfg)) throw new UserError(`Set your custom status to **.${ctx.cfg.statusPhrase}**, stay **Online** or **Do Not Disturb**, then press Start Earning again.`);
  const fresh = earn.enroll(ctx.db, i.user.id);
  earn.setQualifying(ctx.db, i.user.id, true);
  if (fresh) audit(ctx.db, { category: 'status', actor: i.user.id, action: 'status.enrolled', detail: {} });
  return i.reply(eph(ctx, { embeds: [ui.base(ctx.cfg, 'Earning started', fresh ? 'Your time is now being counted. Keep the status on and stay Online or Do Not Disturb.' : 'You are already earning. Your time keeps adding up.')] }));
}
export function time(i, ctx) {
  return i.reply(eph(ctx, { embeds: [ui.earnTimeEmbed(ctx.cfg, earn.summary(ctx.db, i.user.id, ctx.cfg.statusPay))] }));
}
export function payout(i, ctx) {
  const s = earn.summary(ctx.db, i.user.id, ctx.cfg.statusPay);
  if (!s.enrolled) throw new UserError('Press **Start Earning** first.');
  if (s.available < ctx.cfg.statusPay.minPayoutCents) throw new UserError(`You need at least **${earn.usd(ctx.cfg.statusPay.minPayoutCents)}** to request a payout. You have **${earn.usd(s.available)}** available.`);
  return i.reply(eph(ctx, { embeds: [ui.base(ctx.cfg, 'Request payout', `You have **${earn.usd(s.available)}** available. Choose how you want to be paid.`)], components: ui.payMethodRow(earn.METHODS) }));
}
export const pickMethod = (i, ctx, [m]) => { if (!earn.METHODS[m]) throw new UserError('Unknown method.'); return i.showModal(ui.earnPayModal(m, earn.METHODS[m])); };

function cleanDetails(method, raw) {
  const v = String(raw ?? '').trim();
  if (method === 'paypal') { if (!/^[^\s@]{1,64}@[^\s@]{1,128}\.[^\s@]{2,}$/.test(v)) throw new UserError('That does not look like a valid PayPal email.'); return v; }
  const [asset, network] = { ltc: ['LTC', 'litecoin'], sol: ['SOL', 'solana'], eth: ['ETH', 'ethereum'] }[method];
  return V.payoutAddress(asset, network, v);
}
export async function payoutSubmit(i, ctx, method, raw) {
  const details = cleanDetails(method, raw);
  let r;
  try { r = earn.requestPayout(ctx.db, i.user.id, { method, details, pay: ctx.cfg.statusPay }); }
  catch (e) { if (e instanceof earn.PayoutError) throw new UserError(e.message); throw e; }
  audit(ctx.db, { category: 'status', actor: i.user.id, action: 'status.payout.requested', detail: { id: r.id, cents: r.cents, method } });
  const ch = ctx.client?.channels?.cache?.get(ctx.cfg.channels.statusPayouts ?? ctx.cfg.channels.staffLog)
    ?? await ctx.client?.channels?.fetch(ctx.cfg.channels.statusPayouts ?? ctx.cfg.channels.staffLog).catch(() => null);
  if (ch) {
    const msg = await ch.send({ embeds: [ui.earnPayoutEmbed(ctx.cfg, r, earn.METHODS)], components: ui.earnPayoutButtons(r.id), allowedMentions: { parse: [] } }).catch((e) => { log.error('payout post failed', e); return null; });
    if (msg) earn.setPayoutMessage(ctx.db, r.id, ch.id, msg.id);
  } else log.warn('no staff channel for status payouts: set STATUS_PAYOUT_CHANNEL_ID');
  return i.reply(eph(ctx, { embeds: [ui.base(ctx.cfg, 'Payout requested', `Request **#${r.id}** for **${earn.usd(r.cents)}** via **${earn.METHODS[method]}** was sent to staff. They will pay you by hand.`)] }));
}

export function paidAsk(i, ctx, [id]) { if (!earn.getPayout(ctx.db, id)) throw new UserError('Unknown request.'); return i.showModal(ui.earnPaidModal(id)); }
async function finish(i, ctx, id, state, ref) {
  let r;
  try { r = earn.handlePayout(ctx.db, Number(id), state, i.user.id, { ref }); }
  catch (e) { if (e instanceof earn.PayoutError) throw new UserError(e.message); throw e; }
  audit(ctx.db, { category: 'staff', actor: i.user.id, action: `status.payout.${state}`, detail: { staff: true, id: r.id, cents: r.cents } });
  const payload = { embeds: [ui.earnPayoutEmbed(ctx.cfg, r, earn.METHODS)], components: [], allowedMentions: { parse: [] } };
  if (i.isModalSubmit?.() && i.message) await i.update(payload); else if (i.isButton?.()) await i.update(payload); else await i.reply(eph(ctx, payload));
  const u = await ctx.client?.users?.fetch(r.user_id).catch(() => null);
  await u?.send(state === 'paid' ? `Your status payout of ${earn.usd(r.cents)} via ${earn.METHODS[r.method]} was sent.${r.ref ? ` Reference: ${r.ref}` : ''}` : `Your status payout request of ${earn.usd(r.cents)} was rejected. The amount is back in your balance. Contact staff if you have questions.`).catch(() => {});
}
export const paidSubmit = (i, ctx, id, ref) => finish(i, ctx, id, 'paid', ref || null);
export const reject = (i, ctx, [id]) => finish(i, ctx, id, 'rejected', null);
