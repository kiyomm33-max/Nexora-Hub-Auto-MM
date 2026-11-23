import crypto from 'node:crypto';
import { MessageFlags, UserSelectMenuBuilder, ActionRowBuilder } from 'discord.js';
import * as V from '../core/validate.js';
import { DealError } from '../core/deals.js';
import { addVouch } from '../core/vouches.js';
import { audit, dealHistory, staffActivity, verifyAuditChain } from '../core/audit.js';
import { welcomePayload } from './welcome.js';
import { rulesPayload } from './rules.js';
import { userStats } from '../core/stats.js';
import * as act from '../core/activity.js';
import { staffRole, can, CAPS, LEVELS } from '../core/permissions.js';
import { backupNow } from '../jobs/backup.js';
import { log } from '../logger.js';
import * as ui from './ui.js';
import * as rooms from './rooms.js';
import path from 'node:path';
import * as am from './automm.js';
import * as st from './status.js';
import * as gw from './giveaway.js';
import * as pl from './poll.js';
import * as totals from './totals.js';
import { inviteStats } from './invites.js';

export { UserError } from './automm.js';
import { UserError } from './automm.js';
const isUserErr = (e) => e instanceof UserError || e instanceof DealError || e instanceof V.ValidationError;
const EPH = MessageFlags.Ephemeral;

// ---------- helpers ----------
export function staffOf(i, ctx) {
  const r = i.member?.roles;
  const ids = r?.cache ? [...r.cache.keys()] : Array.isArray(r) ? r : [];
  const uid = i.user.id;
  const isOwner = (i.guild?.ownerId ?? ctx.guildOwnerId) === uid || (ctx.cfg.ownerUserIds ?? []).includes(uid);
  const role = staffRole(ids, ctx.cfg.roles, { isGuildOwner: isOwner });
  // Server Administrators get at least Administrator rights (lower than owner).
  if (!role && i.memberPermissions?.has?.('Administrator')) return 'admin';
  return role;
}
function need(i, ctx, cap) {
  const role = staffOf(i, ctx);
  if (!can(role, cap)) {
    audit(ctx.db, { category: 'security', actor: i.user.id, action: 'permission.denied', detail: { cap, where: i.commandName ?? i.customId } });
    throw new UserError('You do not have permission to do that.');
  }
  return role;
}
function accessDeal(i, ctx, rawId) {
  const d = ctx.deals.get(V.dealId(rawId));
  if (!d) throw new UserError('Deal not found.');
  const staff = can(staffOf(i, ctx), 'dispute.review');
  if (!ctx.deals.isParty(d, i.user.id) && !staff) {
    audit(ctx.db, { category: 'security', actor: i.user.id, action: 'permission.denied', dealId: d.id, detail: { where: i.customId ?? i.commandName } });
    throw new UserError('Only the participants of this deal and staff can do that.');
  }
  return { deal: d, staff };
}
const limit = (ctx, i, key, max, ms) => {
  const r = ctx.limiter.check(`${key}:${i.user.id}`, max, ms);
  if (!r.ok) throw new UserError(`Slow down — try again in ${Math.ceil(r.retryMs / 1000)}s.`);
};
async function reply(i, payload) {
  const p = { flags: EPH, allowedMentions: { parse: [] }, ...payload };
  if (i.deferred || i.replied) { delete p.flags; return i.followUp({ ...p, flags: EPH }); }
  return i.reply(p);
}
const say = (ctx, i, title, msg) => reply(i, { embeds: [ui.okEmbed(ctx.cfg, title, msg)] });

// ---------- deal room actions ----------
async function cancelDeal(i, ctx, id) {
  const { deal, staff } = accessDeal(i, ctx, id);
  const isStaffCancel = !ctx.deals.isParty(deal, i.user.id);
  if (isStaffCancel) need(i, ctx, 'deal.cancel');
  ctx.deals.cancel(deal.id, i.user.id, 'cancelled via button', { staff: isStaffCancel });
  try { await ctx.provider.cancelEscrow?.(deal); } catch (e) { log.error('provider cancel failed', e); }
  return say(ctx, i, 'Deal cancelled', `\`${deal.id}\` was cancelled.`);
}
async function openDispute(i, ctx, dealId, reason) {
  limit(ctx, i, 'dispute', 3, 600e3);
  const { deal } = accessDeal(i, ctx, dealId);
  const staffOpen = !ctx.deals.isParty(deal, i.user.id);
  reason = V.text(reason, { min: 10, max: 1000, label: 'Reason' });
  ctx.deals.dispute(deal.id, i.user.id, reason, { staff: staffOpen });
  ctx.deals.addEvidence(deal.id, i.user.id, `Dispute reason: ${reason}`, null);
  let note = 'Referral recorded.';
  try { note = (await ctx.provider.referDispute(deal, reason))?.note ?? note; } catch (e) { log.error('provider dispute referral failed', e); note = 'Provider referral could not be confirmed automatically — staff have been notified.'; }
  audit(ctx.db, { actor: 'system', action: 'dispute.provider_referral', dealId: deal.id, detail: { note } });
  return say(ctx, i, 'Dispute opened', `\`${deal.id}\` is now **Disputed**. ${note}\nStaff review it privately; **the escrow provider decides any release**. Add proof with **Submit evidence**.`);
}
async function submitEvidence(i, ctx, dealId, note, url) {
  limit(ctx, i, 'evidence', 10, 600e3);
  const { deal } = accessDeal(i, ctx, dealId);
  ctx.deals.addEvidence(deal.id, i.user.id, V.text(note, { min: 5, max: 1000, label: 'Description' }), V.evidenceUrl(url));
  return say(ctx, i, 'Evidence recorded', `Saved to \`${deal.id}\` for staff and provider review. Evidence never releases funds.`);
}
async function vouch(i, ctx, dealId, rating, text) {
  limit(ctx, i, 'vouch', 5, 3600e3);
  const id = V.dealId(dealId);
  const r = addVouch(ctx.db, { dealId: id, author: i.user.id, rating: V.rating(rating), text: V.text(text, { min: 5, max: 500, label: 'Feedback' }) });
  const emb = ui.vouchEmbed(ctx.cfg, { dealId: id, author: `<@${i.user.id}>`, target: `<@${r.target}>`, rating: Number(rating), text: V.text(text, { min: 5, max: 500 }), createdAt: r.createdAt });
  const ch = await rooms.fetchChannel(ctx, ctx.cfg.channels.vouches);
  if (ch) await ch.send({ embeds: [emb], allowedMentions: { parse: [] } });
  return reply(i, { embeds: [emb] });
}
async function callStaff(i, ctx, key, label) {
  const r = ctx.limiter.check(`callstaff:${key}`, 1, 300e3);
  if (!r.ok) throw new UserError(`Staff were already called. You can call again in ${Math.ceil(r.retryMs / 1000)}s.`);
  const ids = rooms.staffIds(ctx.cfg, LEVELS.admin);
  await i.channel.send({ content: ids.map((x) => `<@&${x}>`).join(' ') || undefined, embeds: [ui.base(ctx.cfg, 'Staff assistance requested', `<@${i.user.id}> asked for help with ${label}.`)], allowedMentions: { roles: ids } });
  audit(ctx.db, { actor: i.user.id, action: 'staff.requested', detail: { label } });
  return say(ctx, i, 'Staff notified', 'A staff member will join shortly.');
}

// ---------- tickets ----------
async function openTicket(i, ctx, subject, details) {
  limit(ctx, i, 'ticket', 3, 600e3);
  subject = V.text(subject, { min: 3, max: 80, label: 'Subject' }); details = V.text(details, { min: 10, max: 1000, label: 'Details' });
  const id = rooms.newTicketId();
  const ch = await rooms.createPrivateChannel(i.guild, ctx.cfg, { name: `ticket-${id.slice(4).toLowerCase()}`, parent: ctx.cfg.channels.ticketCategory, members: [i.user.id], minStaff: LEVELS.admin, topic: `Support ticket ${id}` });
  ctx.db.prepare('INSERT INTO tickets(id,kind,opener,channel_id,subject,created_at) VALUES(?,?,?,?,?,?)').run(id, 'support', i.user.id, ch.id, subject, new Date().toISOString());
  audit(ctx.db, { actor: i.user.id, action: 'ticket.opened', detail: { id } });
  await ch.send({ content: `<@${i.user.id}>`, embeds: [ui.base(ctx.cfg, `Support  •  ${id}`, `**${subject}**\n${details}\n\nA staff member will assist you. Never share passwords, 2FA codes or seed phrases.`)], components: ui.ticketButtons(id), allowedMentions: { users: [i.user.id] } });
  return say(ctx, i, 'Ticket opened', `Head to <#${ch.id}>.`);
}
async function closeTicket(i, ctx, id) {
  const t = ctx.db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  if (!t || t.status === 'closed') throw new UserError('Ticket not found or already closed.');
  const role = staffOf(i, ctx);
  const allowed = t.kind === 'support' ? (t.opener === i.user.id || LEVELS[role] >= LEVELS.admin) : LEVELS[role] >= LEVELS.admin;
  if (!allowed) { audit(ctx.db, { category: 'security', actor: i.user.id, action: 'permission.denied', detail: { where: 'ticket.close', id } }); throw new UserError('You cannot close this ticket.'); }
  const r = await ctx.limiter.once(`close:${id}`, async () => {
    await i.deferReply({ flags: EPH });
    const sha = await rooms.saveTranscript(ctx, id, i.channel, i.user.id);
    ctx.db.prepare("UPDATE tickets SET status='closed', closed_at=?, closed_by=?, transcript_sha256=? WHERE id=? AND status='open'").run(new Date().toISOString(), i.user.id, sha, id);
    audit(ctx.db, { category: t.kind === 'dispute' || can(role, 'ticket.handle') ? 'staff' : 'deal', actor: i.user.id, action: 'ticket.closed', dealId: t.deal_id, detail: { id, sha256: sha } });
    await say(ctx, i, 'Ticket closed', 'Transcript saved. This channel will be removed shortly.');
    setTimeout(() => i.channel.delete('Ticket closed').catch(() => {}), 8000).unref?.();
  });
  if (r.duplicate) throw new UserError('Already closing.');
}
// ---------- slash commands ----------
const commands = {
  vouch: (i, ctx) => vouch(i, ctx, i.options.getString('deal_id', true), i.options.getInteger('rating', true), i.options.getString('feedback', true)),
  ticket: (i, ctx) => (i.prefix ? openTicket(i, ctx, i.options.getString('subject', true), i.options.getString('details', true)) : i.showModal(ui.ticketModal())),
  dispute: (i, ctx) => openDispute(i, ctx, i.options.getString('deal_id', true), i.options.getString('reason', true)),
  evidence: (i, ctx) => {
    const att = i.options.getAttachment('file');
    const note = i.options.getString('note', true);
    return submitEvidence(i, ctx, i.options.getString('deal_id', true), note, att?.url);
  },
  async mydeals(i, ctx) {
    const rows = ctx.deals.forUser(i.user.id);
    return reply(i, { embeds: [ui.base(ctx.cfg, 'Your deals', rows.map((d) => `\`${d.id}\`  •  ${ui.statusText(d.status)}${d.channel_id ? `  •  <#${d.channel_id}>` : ''}`).join('\n') || 'No deals yet. Start one from the panel.')] });
  },
  async dealinfo(i, ctx) {
    const { deal } = accessDeal(i, ctx, i.options.getString('deal_id', true));
    return reply(i, { embeds: [ui.dealEmbed(ctx.cfg, deal)] });
  },
  async stats(i, ctx) {
    const only = ctx.cfg.channels.stats;
    if (only && i.channel?.id !== only) throw new UserError(`Use the stats command in <#${only}>.`);
    limit(ctx, i, 'stats', 5, 60e3);
    const u = i.options.getUser('member') ?? i.user;
    const name = (u.id === i.user.id ? i.member?.displayName : null) ?? u.displayName ?? u.globalName ?? u.username ?? 'Member';
    return i.reply({ embeds: [ui.statsEmbed(name, u.displayAvatarURL?.({ size: 256 }), userStats(ctx.db, u.id))], allowedMentions: { parse: [] } });
  },
  async leaderboard(i, ctx) {
    limit(ctx, i, 'leaderboard', 5, 60e3);
    const raw = String(i.options.getString('period') ?? 'all').toLowerCase();
    const period = { day: 'today', daily: 'today', weekly: 'week', monthly: 'month', alltime: 'all', total: 'all' }[raw] ?? raw;
    if (!(period in act.PERIODS)) throw new UserError('Pick a period: today, week, month or all.');
    const b = act.leaderboard(ctx.db, period, { limit: 10 }); const rank = act.userRank(ctx.db, i.user.id, period);
    const me = rank ? { id: i.user.id, rank, n: act.userMessages(ctx.db, i.user.id)[period === 'all' ? 'all' : period] } : null;
    return i.reply({ embeds: [ui.leaderboardEmbed(ctx.cfg, { period, label: act.PERIOD_LABEL[period], ...b, me, since: act.trackingSince(ctx.db) })], allowedMentions: { parse: [] } });
  },
  async messages(i, ctx) {
    limit(ctx, i, 'messages', 5, 60e3);
    const u = i.options.getUser('member') ?? i.user;
    const name = (u.id === i.user.id ? i.member?.displayName : null) ?? u.displayName ?? u.globalName ?? u.username ?? 'Member';
    return i.reply({ embeds: [ui.messagesEmbed(ctx.cfg, name, u.displayAvatarURL?.({ size: 256 }), act.userMessages(ctx.db, u.id))], allowedMentions: { parse: [] } });
  },
  async invites(i, ctx) {
    limit(ctx, i, 'invites', 5, 60e3);
    const u = i.options.getUser('member') ?? i.user;
    const name = (u.id === i.user.id ? i.member?.displayName : null) ?? u.displayName ?? u.globalName ?? u.username ?? 'Member';
    return i.reply({ embeds: [ui.invitesEmbed(ctx.cfg, name, u.displayAvatarURL?.({ size: 256 }), await inviteStats(i.guild, ctx, u.id))], allowedMentions: { parse: [] } });
  },
  async tag(i, ctx) {
    need(i, ctx, 'activity.view');
    const u = i.options.getUser('member') ?? i.user;
    return reply(i, { embeds: [ui.tagEmbed(ctx.cfg, u.id, act.perkSummary(ctx.db, u.id, 'tag'), act.perkSummary(ctx.db, u.id, 'status'), act.duration, `.gg/${ctx.cfg.statusPhrase.replace(/^.*gg\//, '')}`)] });
  },
  async tags(i, ctx) {
    need(i, ctx, 'activity.view');
    return reply(i, { embeds: [ui.tagBoardEmbed(ctx.cfg, act.perkBoard(ctx.db, 'tag', { limit: 10 }), act.perkBoard(ctx.db, 'status', { limit: 10 }), act.duration, `.gg/${ctx.cfg.statusPhrase.replace(/^.*gg\//, '')}`)] });
  },
  async welcome(i, ctx) {
    need(i, ctx, 'panel.post');
    const target = (await rooms.fetchChannel(ctx, ctx.cfg.channels.welcome)) ?? i.channel;
    await target.send(welcomePayload(ctx.cfg, i.user));
    audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'welcome.previewed', detail: { staff: true, channel: target.id } });
    return say(ctx, i, 'Welcome preview posted', `Posted in <#${target.id}> with you as the new member.`);
  },
  async fees(i, ctx) {
    need(i, ctx, 'panel.post');
    const target = (await rooms.fetchChannel(ctx, ctx.cfg.channels.fees)) ?? i.channel;
    await target.send({ ...ui.feesPanelPayload(ctx.cfg), files: [st.logoFile()] });
    audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'feespanel.posted', detail: { staff: true, channel: target.id } });
    return say(ctx, i, 'Fee panel posted', `Posted in <#${target.id}>.`);
  },
  async totals(i, ctx) {
    need(i, ctx, 'panel.post');
    let r; try { r = await totals.setup(ctx, i.guild); } catch (e) { log.error('totals setup failed', e); throw new UserError('I could not create the voice channels. Give me the **Manage Channels** permission and try again.'); }
    audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'totals.setup', detail: { staff: true, ...r.ids } });
    return say(ctx, i, r.created.length ? 'Stats channels created' : 'Stats channels already exist', `<#${r.ids.volume}> and <#${r.ids.deals}> are locked: nobody can join. They rename themselves when a deal completes (at most every 5 minutes).`);
  },
  async steal(i, ctx) {
    need(i, ctx, 'panel.post');
    const found = new Map();
    for (const m of String(i.options.getString('emoji') ?? '').matchAll(/<(a?):(\w{2,32}):(\d{15,25})>/g)) if (!found.has(m[3])) found.set(m[3], { animated: !!m[1], id: m[3] });
    if (!found.size) throw new UserError('Reply to a message that has a **custom emoji** with `.steal`, or type it after the command.');
    if (found.size > 10) throw new UserError('That is more than 10 emoji. Do 10 at a time.');
    await i.deferReply?.();
    const taken = new Set([...(i.guild.emojis.cache?.values?.() ?? [])].map((e) => e.name));
    const added = []; const failed = [];
    for (const e of found.values()) {
      let name; do { name = `nexora_${crypto.randomInt(1000, 10000)}`; } while (taken.has(name)); taken.add(name);
      try { const made = await i.guild.emojis.create({ attachment: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=128&quality=lossless`, name }); added.push(`${made} \`${name}\``); }
      catch (err) { failed.push(/Maximum number|emoji slots|30008/i.test(String(err?.message) + String(err?.code)) ? 'No free emoji slots left in this server.' : /Missing Permissions|50013/i.test(String(err?.message) + String(err?.code)) ? 'I need the **Manage Expressions** permission.' : 'Discord refused that emoji (too big or not available).'); }
    }
    audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'emoji.stolen', detail: { staff: true, added: added.length, failed: failed.length } });
    const parts = []; if (added.length) parts.push(`**Added:**\n${added.join('\n')}`); if (failed.length) parts.push(`**Failed:**\n${[...new Set(failed)].join('\n')}`);
    return reply(i, { embeds: [ui.okEmbed(ctx.cfg, added.length ? 'Emoji added' : 'Nothing added', parts.join('\n\n'))] });
  },
  async check(i, ctx) {
    need(i, ctx, 'panel.post');
    return gw.entries(i, ctx, i.options.getInteger('id'));
  },
  async poll(i, ctx) {
    need(i, ctx, 'panel.post');
    if (i.options.getSubcommand() === 'end') return pl.endNow(i, ctx, i.options.getInteger('id', true));
    const o = i.options;
    return pl.create(i, ctx, { channel: o.getChannel('channel') ?? i.channel, question: o.getString('question', true), duration: o.getString('duration', true),
      options: [1, 2, 3, 4, 5].map((n) => o.getString(`option${n}`)).filter(Boolean) });
  },
  async giveaway(i, ctx) {
    need(i, ctx, 'panel.post');
    const sub = i.options.getSubcommand();
    if (sub === 'create') return gw.create(i, ctx, { channel: i.options.getChannel('channel', true), duration: i.options.getString('duration', true), prize: i.options.getString('prize', true), invites: i.options.getInteger('invites') });
    if (sub === 'end') return gw.endNow(i, ctx, i.options.getInteger('id', true));
    return gw.reroll(i, ctx, i.options.getInteger('id', true));
  },
  async rules(i, ctx) {
    need(i, ctx, 'panel.post');
    const target = (await rooms.fetchChannel(ctx, ctx.cfg.channels.rules)) ?? i.channel;
    await target.send(rulesPayload());
    audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'rules.posted', detail: { staff: true, channel: target.id } });
    return say(ctx, i, 'Rules posted', `Posted in <#${target.id}>.`);
  },
  async supportpanel(i, ctx) {
    need(i, ctx, 'panel.post');
    const target = (await rooms.fetchChannel(ctx, ctx.cfg.channels.supportPanel)) ?? i.channel;
    await target.send(ui.supportPanelPayload());
    audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'supportpanel.posted', detail: { staff: true, channel: target.id } });
    return say(ctx, i, 'Support panel posted', `Posted in <#${target.id}>.`);
  },
  async status(i, ctx) {
    need(i, ctx, 'panel.post');
    const target = (await rooms.fetchChannel(ctx, ctx.cfg.channels.statusPanel)) ?? i.channel;
    await st.postPanel(ctx, target);
    audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'statuspanel.posted', detail: { staff: true, channel: target.id } });
    return say(ctx, i, 'Status panel posted', `Posted in <#${target.id}>.`);
  },
  async panel(i, ctx) {
    need(i, ctx, 'panel.post');
    const target = (await rooms.fetchChannel(ctx, ctx.cfg.channels.panel)) ?? i.channel;
    await target.send(ui.panelPayload(ctx.cfg, ctx.mode));
    audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'panel.posted', detail: { staff: true, channel: target.id } });
    return say(ctx, i, 'Panel posted', `Posted in <#${target.id}>.`);
  },
  async staff(i, ctx) {
    const sub = i.options.getSubcommand();
    const staffAudit = (action, dealId, detail) => audit(ctx.db, { category: 'staff', actor: i.user.id, action, dealId, detail });
    if (sub === 'history') {
      need(i, ctx, 'history.view'); const id = V.dealId(i.options.getString('deal_id', true));
      if (!ctx.deals.get(id)) throw new UserError('Deal not found.');
      staffAudit('staff.viewed_history', id, {});
      return reply(i, { embeds: [ui.historyEmbed(ctx.cfg, id, dealHistory(ctx.db, id))] });
    }
    if (sub === 'activity') {
      const target = i.options.getUser('member');
      if (target && target.id !== i.user.id) need(i, ctx, 'activity.view'); else need(i, ctx, 'ticket.handle');
      const uid = target?.id ?? i.user.id; const rows = staffActivity(ctx.db, uid);
      return reply(i, { embeds: [ui.base(ctx.cfg, 'Staff activity', rows.map((r) => `<t:${Math.floor(Date.parse(r.ts) / 1000)}:R> \`${r.action}\` ${r.deal_id ?? ''}`).join('\n') || `No recorded actions for <@${uid}>.`)] });
    }
    if (sub === 'cancel') {
      need(i, ctx, 'deal.cancel'); const id = V.dealId(i.options.getString('deal_id', true));
      const reason = V.text(i.options.getString('reason', true), { min: 5, max: 300, label: 'Reason' });
      const d = ctx.deals.cancel(id, i.user.id, reason, { staff: true });
      try { await ctx.provider.cancelEscrow?.(d); } catch (e) { log.error('provider cancel failed', e); }
      return say(ctx, i, 'Deal cancelled', `\`${id}\` cancelled. Logged with your ID and reason.`);
    }
    if (sub === 'simulate') {
      need(i, ctx, 'simulate');
      if (ctx.mode !== 'demo') throw new UserError('Simulation is only available in demo mode.');
      const id = V.dealId(i.options.getString('deal_id', true)); const type = i.options.getString('event', true);
      const d = ctx.deals.get(id); if (!d?.provider_ref) throw new UserError('Deal has no provider reference yet.');
      staffAudit('staff.simulated_provider_event', id, { type, staff: true });
      const res = ctx.deals.applyProviderEvent({ id: `sim-${crypto.randomUUID()}`, type, reference: d.provider_ref, confirmations: type === 'funds.confirmed_on_chain' ? 6 : 1, ...(type.startsWith('funds.') ? { txid: d.tx_hash ?? `DEMO-TX-${crypto.randomBytes(8).toString('hex')}`, amount: d.pay_amount ?? undefined, required_confirmations: 1 } : {}) }, { simulated: true });
      return say(ctx, i, 'Simulated provider event', `\`${type}\` → **${res.outcome}** (DEMO, flagged simulated in the audit log).`);
    }
    if (sub === 'audit') {
      need(i, ctx, 'audit.verify'); const r = verifyAuditChain(ctx.db);
      return say(ctx, i, r.ok ? 'Audit chain intact' : 'AUDIT CHAIN BROKEN', r.ok ? `${r.checked} entries verified.` : `Tampering detected at entry #${r.brokenAt}.`);
    }
    if (sub === 'backup') {
      need(i, ctx, 'backup'); const f = backupNow(ctx.db, path.join(ctx.cfg.dataDir, 'backups'), ctx.cfg.backupKeep);
      staffAudit('staff.backup', null, {});
      return say(ctx, i, 'Backup created', `\`${path.basename(f)}\``);
    }
    if (sub === 'wallet') {
      need(i, ctx, 'wallet');
      if (!ctx.provider.live) throw new UserError('The wallet only exists in live mode.');
      staffAudit('staff.viewed_wallet', null, {});
      const w = ctx.provider;
      const lines = (w.describe?.() ?? [{ label: 'Fee address', value: w.treasury }]).map((x) => `**${x.label}**\n\`${x.value}\``).join('\n');
      return reply(i, { embeds: [ui.base(ctx.cfg, 'Wallet (owner only)', `LTC network: **${ctx.cfg.ltc.network}**\nKey source: **${w.source}**\nCoins on the panel: **${ctx.cfg.coins.enabled.join(', ')}**\n\n${lines}\n\n**Recovery phrase** — write it down offline, never share it, and delete this message:\n||${w.mnemonic}||\n${w.source === 'generated' ? '\nThis phrase lives on the data volume. Store it, then add it as the LTC_MNEMONIC variable so the key does not depend on the volume.' : ''}`)] });
    }
    if (sub === 'lockrooms') {
      need(i, ctx, 'wallet'); await i.deferReply({ flags: EPH });
      const n = await rooms.lockRooms(ctx); audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'rooms.locked', detail: { staff: true, rooms: n } });
      return say(ctx, i, 'Rooms locked', `Checked **${n}** open rooms. Only the parties and admin-level roles can see them.`);
    }
    if (sub === 'refund') {
      need(i, ctx, 'refund');
      if (!ctx.provider.sweep) throw new UserError('Refunds are only available in live mode.');
      const id = V.dealId(i.options.getString('deal_id', true)); const to = i.options.getString('address', true).trim();
      const dealRow = ctx.db.prepare('SELECT asset, network FROM deals WHERE id=?').get(id);
      try { ctx.provider.validateAddress(to, dealRow); } catch (e) { throw new UserError(e.message); }
      await i.deferReply({ flags: EPH });
      let txid;
      try { txid = await ctx.provider.sweep(id, to); } catch (e) { throw new UserError(String(e.message ?? e).slice(0, 200)); }
      staffAudit('staff.refund_sent', id, { to, txid });
      return i.editReply({ embeds: [ui.okEmbed(ctx.cfg, 'Refund broadcast', `Deal \`${id}\` funds sent to \`${to}\`.\n${ctx.provider.explorerTx(txid, dealRow)}`)] });
    }
    if (sub === 'claim') {
      need(i, ctx, 'deal.claim'); const d = ctx.deals.claim(V.dealId(i.options.getString('deal_id', true)), i.user.id);
      return say(ctx, i, 'Deal claimed', `You are the middleman for \`${d.id}\`.`);
    }
  },
};

// ---------- components ----------
const buttons = {
  'pl-vote': (i, ctx, [id, n]) => pl.vote(i, ctx, id, n),
  'gw-enter': (i, ctx, [id]) => gw.enter(i, ctx, id),
  'gw-leave': (i, ctx, [id]) => gw.leave(i, ctx, id),
  'st-start': (i, ctx) => st.start(i, ctx),
  'st-time': (i, ctx) => st.time(i, ctx),
  'st-payout': (i, ctx) => st.payout(i, ctx),
  'st-pm': (i, ctx, a) => st.pickMethod(i, ctx, a),
  'st-paid': (i, ctx, a) => { need(i, ctx, 'panel.post'); return st.paidAsk(i, ctx, a); },
  'st-rej': (i, ctx, a) => { need(i, ctx, 'panel.post'); return st.reject(i, ctx, a); },
  'am-start': (i, ctx, [key]) => am.startAuto(i, ctx, key),
  'am-close': (i, ctx, [id]) => am.closeDeal(i, ctx, id, { staffCan: (cap) => can(staffOf(i, ctx), cap) }),
  'am-release': (i, ctx, [id]) => am.releaseAsk(i, ctx, id),
  'am-closeyes': (i, ctx, [id]) => am.closeYes(i, ctx, id),
  'am-closeno': (i, ctx, [id]) => am.closeNo(i, ctx, id),
  'am-relyes': (i, ctx, [id]) => am.releaseYes(i, ctx, id),
  'am-relno': (i) => am.releaseNo(i),
  'am-payaddr': (i, ctx, [id]) => am.payAddr(i, ctx, id),
  'am-payyes': (i, ctx, [id, addr]) => am.payAddrConfirm(i, ctx, id, addr),
  'am-payno': async (i, ctx, [id]) => { if (ctx.deals.get(id)?.receiver_id !== i.user.id) throw new UserError('Only the receiver can do that.'); return i.update({ content: null, embeds: [ui.base(ctx.cfg, 'Address not confirmed', '**Send your address again** in this channel.')], components: [] }); },
  'am-cancelpaid': (i, ctx, [id]) => { accessDeal(i, ctx, id); return i.showModal(ui.disputeModal(id)); },
  'am-shortyes': (i, ctx, [id]) => am.shortYes(i, ctx, id),
  'am-shortno': (i, ctx, [id]) => am.shortNo(i, ctx, id),
  'am-cancelask': (i, ctx, [id]) => am.cancelAsk(i, ctx, id),
  'am-cancelyes': (i, ctx, [id]) => am.cancelYes(i, ctx, id),
  'am-cancelno': (i, ctx, [id]) => am.cancelNo(i, ctx, id),
  'am-refyes': (i, ctx, [id, addr]) => am.refundYes(i, ctx, id, addr),
  'am-refno': (i, ctx, [id]) => am.refundNo(i, ctx, id),
  'am-relcancel': (i, ctx, [id]) => am.releaseCancel(i, ctx, id),
  'ticket-start': (i) => i.showModal(ui.ticketModal()),
  'dispute-start': (i) => i.showModal(ui.disputeModal()),
  async refresh(i, ctx, [id]) { const { deal } = accessDeal(i, ctx, id); return reply(i, { embeds: [ui.dealEmbed(ctx.cfg, deal)] }); },
  staff: (i, ctx, [id]) => { const { deal } = accessDeal(i, ctx, id); return callStaff(i, ctx, deal.id, `deal \`${deal.id}\``); },
  async claim(i, ctx, [id]) { need(i, ctx, 'deal.claim'); const d = ctx.deals.claim(V.dealId(id), i.user.id); return say(ctx, i, 'Deal claimed', `You are now the middleman for \`${d.id}\`.`); },
  cancel: (i, ctx, [id]) => cancelDeal(i, ctx, id),
  dispute: (i, ctx, [id]) => { accessDeal(i, ctx, id); return i.showModal(ui.disputeModal(id)); },
  evidence: (i, ctx, [id]) => { accessDeal(i, ctx, id); return i.showModal(ui.evidenceModal(id)); },
  vouch: (i, ctx, [id]) => { const { deal } = accessDeal(i, ctx, id); if (deal.status !== 'completed') throw new UserError('Only completed deals can be vouched.'); return i.showModal(ui.vouchModal(id)); },
  tstaff: (i, ctx, [id]) => callStaff(i, ctx, id, `ticket \`${id}\``),
  tclose: (i, ctx, [id]) => closeTicket(i, ctx, id),
};
const modals = {
  'st-pay': (i, ctx, [m]) => st.payoutSubmit(i, ctx, m, i.fields.getTextInputValue('details')),
  'st-paidm': (i, ctx, [id]) => { need(i, ctx, 'panel.post'); return st.paidSubmit(i, ctx, id, i.fields.getTextInputValue('ref').trim()); },
  disputemodal: (i, ctx, [id]) => openDispute(i, ctx, id === 'ask' ? i.fields.getTextInputValue('deal_id') : id, i.fields.getTextInputValue('reason')),
  evidencemodal: (i, ctx, [id]) => submitEvidence(i, ctx, id, i.fields.getTextInputValue('note'), i.fields.getTextInputValue('url')),
  'am-payaddrmodal': (i, ctx, [id]) => am.payAddrSubmit(i, ctx, id, i.fields.getTextInputValue('addr')),
  ticketmodal: (i, ctx) => openTicket(i, ctx, i.fields.getTextInputValue('subject'), i.fields.getTextInputValue('details')),
  vouchmodal: (i, ctx, [id]) => vouch(i, ctx, id, i.fields.getTextInputValue('rating'), i.fields.getTextInputValue('text')),
};

export async function route(i, ctx) {
  try {
    limit(ctx, i, 'global', 15, 10e3);
    if (i.isChatInputCommand?.()) return await (commands[i.commandName] ?? (() => { throw new UserError('Unknown command.'); }))(i, ctx);
    const [ns, action, ...args] = String(i.customId ?? '').split(':');
    if (ns !== 'nx') return;
    // Auto-MM setup steps (selects, buttons and modals): nx:am-<step>:<dealId>[:value]
    if (action?.startsWith('am-') && am.handlers[action.slice(3)] && !buttons[action]) {
      return await am.handlers[action.slice(3)](i, ctx, args);
    }
    // Buttons carry deal IDs; double-click guard per user+button.
    if (i.isButton?.()) {
      const h = buttons[action]; if (!h) return;
      const r = await ctx.limiter.once(`btn:${i.user.id}:${i.customId}`, () => h(i, ctx, args));
      if (r.duplicate) return reply(i, { embeds: [ui.errorEmbed(ctx.cfg, 'That action is already being processed.')] });
      return;
    }
    if (i.isModalSubmit?.()) { const h = modals[action]; if (h) return await h(i, ctx, args); }
  } catch (e) {
    let msg;
    if (isUserErr(e)) msg = e.message;
    else { const ref = crypto.randomBytes(3).toString('hex'); log.error('interaction failed', { ref, id: i.customId ?? i.commandName, err: e }); msg = `Something went wrong on our side. Reference \`${ref}\`.`; }
    try { await reply(i, { embeds: [ui.errorEmbed(ctx.cfg, msg)] }); } catch (e2) { log.error('error reply failed', e2); }
  }
}

export const _commands = commands;
