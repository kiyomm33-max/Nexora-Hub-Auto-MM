import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ChannelType, PermissionFlagsBits as P, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { LEVELS, CAPS } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { log } from '../logger.js';
import * as ui from './ui.js';
import { base, dealEmbed, completedEmbed, dealCard, BRAND, phaseOf } from './ui.js';
import { payloadFor, pingIds, putStep, markPosted } from './automm.js';
import { hiddenFor, ANON } from '../core/privacy.js';
import { syncTrustRoles } from './trustroles.js';
import { metaOf, parseBody, renderHtml } from './transcript.js';

const ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];

export const staffIds = (cfg, minLevel) => Object.entries(cfg.roles).filter(([n]) => LEVELS[n] >= minLevel).flatMap(([, ids]) => ids);

export async function createPrivateChannel(guild, cfg, { name, parent, members = [], minStaff, topic }) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: guild.members.me.id, allow: [...ALLOW, P.ManageChannels] },
    ...members.map((id) => ({ id, allow: ALLOW })),
    ...staffIds(cfg, minStaff).map((id) => ({ id, allow: ALLOW })),
  ];
  return guild.channels.create({ name, type: ChannelType.GuildText, parent: parent || undefined, topic, permissionOverwrites: overwrites });
}
export const roomName = (d) => `deal-${d.id.slice(4).toLowerCase()}`;
export const newTicketId = () => 'TCK-' + crypto.randomBytes(3).toString('hex').toUpperCase();

export async function fetchChannel(ctx, id) {
  if (!id) return null;
  try { return await ctx.client.channels.fetch(id); } catch { return null; }
}
export async function staffLog(ctx, embed) {
  const ch = await fetchChannel(ctx, ctx.cfg.channels.staffLog);
  if (ch) await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((e) => log.error('staff log failed', e));
}

/** Re-render the live status message in the deal room. */
const lastPhase = new Map();
// One refresh at a time per deal: two overlapping ones (a chain event and the poller) used to post a card, then the
// second one tried to edit the card the first had just replaced, failed, and posted the same card again.
const queues = new Map();
export function refreshStatus(ctx, deal, opts = {}) {
  const prev = queues.get(deal.id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    let fresh = deal; try { fresh = ctx.deals.get?.(deal.id) ?? deal; } catch { /* keep the deal we were given */ }
    return refreshStatusNow(ctx, fresh, opts);
  });
  queues.set(deal.id, run); run.finally(() => { if (queues.get(deal.id) === run) queues.delete(deal.id); }).catch(() => {});
  return run;
}
async function refreshStatusNow(ctx, deal, { bump = false } = {}) {
  const ch = await fetchChannel(ctx, deal.channel_id);
  if (!ch) return;
  if (deal.card_message_id) { // the card at the top of the room follows the deal
    try { const card = await ch.messages.fetch(deal.card_message_id); await card.edit(dealCard(ctx.cfg, deal, ctx.deals.setup(deal))); } catch (e) { log.warn('deal card update failed', { err: String(e?.message ?? e) }); }
  }
  if (['completed', 'cancelled'].includes(deal.status)) { // no status card once a deal is over: the one closing notice replaces it
    if (deal.status_message_id) { try { await (await ch.messages.fetch(deal.status_message_id)).delete(); } catch { /* already gone */ } ctx.deals.setChannel(deal.id, 'status_message_id', null); }
    return;
  }
  const payload = { ...(await payloadFor(ctx, deal)), allowedMentions: { users: pingIds(ctx, deal) } };
  const phase = deal.status === 'waiting_parties' ? `s:${ctx.deals.setup(deal).step}` : phaseOf(deal);
  const changed = lastPhase.get(deal.id) !== phase; lastPhase.set(deal.id, phase);
  let old = null;
  if (deal.status_message_id) { try { old = await ch.messages.fetch(deal.status_message_id); } catch { /* already gone */ } }
  // progress ticks inside one phase (confirmation counts) edit in place; everything else is a fresh message with a ping
  // a V2 card of the same phase (confirmation count, countdown) is edited in place; its attachments stay on the message
  if (old && !bump && !changed && deal.status !== 'waiting_parties' && (payload.flags ?? 0) & (1 << 15)) { try { markPosted(deal.id, payload); return await old.edit({ flags: payload.flags, components: payload.components }); } catch (e) { log.error('status edit failed, reposting', e); } }
  if (old && !bump && !changed && deal.status !== 'waiting_parties' && payload.flags == null) { try { markPosted(deal.id, payload); return await old.edit({ ...payload, content: payload.content ?? null }); } catch (e) { log.error('status edit failed, reposting', e); } }
  return putStep(ctx, ch, old, deal, payload, { force: !old || bump });
}

/** The completed-deal post (embed, coin icon, buttons). Names of members who hid themselves show as Anonymous. */
export async function completedPayload(ctx, deal, names, info, { test = false } = {}) {
  const embed = completedEmbed(ctx.cfg, deal, names, info, { test });
  const files = []; const components = [];
  embed.setThumbnail('https://cdn.discordapp.com/emojis/1575100909191430197.png?size=128'); // lock emoji from the Nexora server
  const crow = new ActionRowBuilder();
  if (info?.url) crow.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`View on ${info.explorerName}`).setURL(info.url));
  if (crow.components.length) components.push(crow);
  return { embeds: [embed], files, components, allowedMentions: { parse: [] } };
}
const pendingPublish = new Set();
export async function publishCompleted(ctx, deal, { force = false } = {}) {
  if (deal.status !== 'completed' || deal.completed_message_id) return;
  const wait = ctx.cfg.privacyChoiceSec;
  if (!force && wait > 0) { // give both traders time to pick Show on Profile / Keep Anonymous
    if (pendingPublish.has(deal.id)) return;
    pendingPublish.add(deal.id);
    setTimeout(() => { pendingPublish.delete(deal.id); const fresh = ctx.deals.get(deal.id); if (fresh) publishCompleted(ctx, fresh, { force: true }).catch((e) => log.error('completed post failed', e)); }, wait * 1000).unref?.();
    return;
  }
  const ch = await fetchChannel(ctx, ctx.cfg.channels.completed);
  if (!ch) return;
  const name = async (id) => {
    if (hiddenFor(ctx.db, deal.id, id)) return ANON;
    try { const u = await ctx.client.users.fetch(id); return `**${u.username}** (<@${id}>)`; } catch { return `<@${id}>`; }
  };
  const names = { a: await name(deal.party_a), b: await name(deal.party_b), middleman: deal.middleman_id ? await name(deal.middleman_id) : null };
  if (deal.sender_id && deal.receiver_id) { names.sender = await name(deal.sender_id); names.receiver = await name(deal.receiver_id); }
  const info = ctx.provider.payoutInfo?.(deal.id) ?? null;
  const m = await ch.send(await completedPayload(ctx, deal, names, info));
  ctx.deals.setChannel(deal.id, 'completed_message_id', m.id);
  audit(ctx.db, { actor: 'system', action: 'completed_deal.published', dealId: deal.id, detail: { messageId: m.id } });
}

const NOTICE = {
  observed: (d) => `Provider reported a payment observation (${d.confirmations} conf.). This is a blockchain observation, **not** escrow confirmation.`,
  escrow: () => 'The escrow provider has **confirmed the funds are held in escrow**.',
  completed: () => 'This ticket closes in **5 minutes**.',
  cancelled: () => 'This ticket closes in **5 minutes**.',
  claimed: (d) => `<@${d.middleman_id}> is now the assigned middleman.`,
  evidence: () => 'New evidence was added to the deal record.',
  released: (d) => `The sender released the payment. <@${d.receiver_id}>, provide your ${d.asset} address to receive the payout.`,
  disputed: () => 'A dispute was opened and **referred to the external escrow provider**. Staff will review evidence; staff cannot release disputed funds.',
};

export async function syncDeal(ctx, deal, change) {
  if (change === 'activated' || change === 'confirmed') return;
  await refreshStatus(ctx, deal, { bump: ['escrow', 'released'].includes(change) });
  const room = await fetchChannel(ctx, deal.channel_id);
  if (room && NOTICE[change] && !['observed', 'escrow', 'released'].includes(change)) await room.send(ui.asCard({ embeds: [base(ctx.cfg, change === 'completed' ? 'Deal completed' : change === 'cancelled' ? 'Deal cancelled' : 'Deal update', NOTICE[change](deal), deal.status === 'disputed' ? BRAND.red : BRAND.purple)], allowedMentions: { parse: [] } })).catch(() => {});
  if (change === 'disputed') await ensureDisputeChannel(ctx, deal);
  if (change === 'completed') {
    if (room && ctx.cfg.privacyChoiceSec > 0) await room.send({ ...ui.dealCompletePayload(ctx.cfg, deal), allowedMentions: { users: [deal.sender_id, deal.receiver_id].filter(Boolean) } });
    if (room && deal.mode === 'live') { const v = ui.vouchCardPayload(ctx.cfg, deal); if (v) await room.send({ ...v, allowedMentions: { users: [deal.sender_id, deal.receiver_id].filter(Boolean) } }).catch((e) => log.warn('vouch card failed', { err: String(e?.message ?? e) })); }
    await publishCompleted(ctx, deal);
    for (const uid of new Set([deal.party_a, deal.party_b, deal.sender_id, deal.receiver_id].filter(Boolean))) syncTrustRoles(ctx, uid).catch((e) => log.warn('trust role sync failed', { uid, err: String(e?.message ?? e) }));
  }
  if (['disputed', 'completed', 'cancelled'].includes(change))
    await staffLog(ctx, base(ctx.cfg, `Deal ${change}`, `\`${deal.id}\` is now **${deal.status}**.`));
}

export async function ensureDisputeChannel(ctx, deal) {
  if (deal.dispute_channel_id) return;
  const guild = await ctx.client.guilds.fetch(ctx.cfg.guildId);
  const id = newTicketId();
  const ch = await createPrivateChannel(guild, ctx.cfg, { name: `dispute-${deal.id.slice(4).toLowerCase()}`, parent: ctx.cfg.channels.disputeCategory, minStaff: LEVELS.admin, topic: `Staff review for ${deal.id}` });
  ctx.deals.setChannel(deal.id, 'dispute_channel_id', ch.id);
  ctx.db.prepare("INSERT INTO tickets(id,kind,opener,deal_id,channel_id,subject,created_at) VALUES(?,?,?,?,?,?,?)").run(id, 'dispute', 'system', deal.id, ch.id, `Dispute ${deal.id}`, new Date().toISOString());
  const ev = ctx.db.prepare('SELECT author,note,url,created_at FROM evidence WHERE deal_id=? ORDER BY id').all(deal.id);
  const e = base(ctx.cfg, `Staff review  •  ${deal.id}`, 'Private staff channel. Review evidence and assist the parties. **Disputed funds are resolved by the escrow provider only** — do not instruct or promise releases.', BRAND.red)
    .addFields({ name: 'Evidence on file', value: ev.map((x) => `<@${x.author}>: ${x.note.slice(0, 150)}${x.url ? ` — ${x.url}` : ''}`).join('\n').slice(0, 1000) || 'None yet. Parties can use /evidence.' });
  const { ticketButtons } = await import('./ui.js');
  await ch.send({ embeds: [dealEmbed(ctx.cfg, deal), e], components: ticketButtons(id), allowedMentions: { parse: [] } });
}

export function renderTranscript(messages) {
  return messages.map((m) => {
    const att = [...(m.attachments?.values?.() ?? [])].map((a) => ` [attachment: ${a.name} ${a.url}]`).join('');
    const emb = (m.embeds ?? []).map((e) => ` [embed: ${e.title ?? ''} ${e.description ?? ''}]`.replace(/\s+/g, ' ')).join('');
    return `[${new Date(m.createdTimestamp).toISOString()}] ${m.author?.username ?? '?'} (${m.author?.id ?? '?'}): ${m.content ?? ''}${att}${emb}`;
  }).join('\n');
}
export async function collectMessages(channel, max = 2000) {
  const all = []; let before;
  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values()); before = batch.last().id;
  }
  return all.reverse();
}
/** Store the transcript (immutable hash), send it to the staff transcript channel, and DM each person in the room their copy once. */
export async function saveTranscript(ctx, refId, channel, by) {
  const messages = await collectMessages(channel);
  const body = renderTranscript(messages) || '(empty)';
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const fresh = ctx.db.prepare('INSERT OR IGNORE INTO transcripts(ticket_id,body,sha256,created_at) VALUES(?,?,?,?)').run(refId, body, sha, new Date().toISOString()).changes === 1;
  audit(ctx.db, { category: 'staff', actor: by, action: 'transcript.saved', detail: { refId, sha256: sha, channel: channel.id } });
  const meta = metaOf(ctx.db, refId); const now = new Date();
  const fileName = `transcript_${channel.id}.html`;
  const html = renderHtml(messages, { title: meta.title, channelName: channel.name ?? String(refId).toLowerCase(), generatedAt: now });
  const files = () => [new AttachmentBuilder(Buffer.from(html), { name: fileName }), ui.lineFile()];
  const out = await fetchChannel(ctx, ctx.cfg.channels.transcripts);
  const note = `**Participants:** ${meta.parties.map((u) => `<@${u}>`).join(', ') || 'none'} | **Status:** ${meta.status ?? 'closed'}${meta.amount ? ` | **Deal amount:** $${meta.amount}` : ''}\n**Messages:** ${parseBody(body).length} | **SHA-256:** \`${sha}\``;
  if (out) await out.send({ ...ui.transcriptCard(meta, fileName, { generatedAt: now, staffNote: note }), files: files() }).catch((e) => log.error('transcript post failed', e));
  if (fresh) for (const uid of meta.parties) {
    try { const u = await ctx.client.users.fetch(uid); await u.send({ ...ui.transcriptCard(meta, fileName, { generatedAt: now }), files: files() }); }
    catch (e) { log.warn?.('transcript DM failed (DMs closed?)', { user: uid, err: String(e.message ?? e).slice(0, 80) }); }
  }
  return sha;
}

/** Re-apply the privacy rules to rooms that already exist: nobody below admin level keeps a role overwrite. Returns how many channels were changed. */
export async function lockRooms(ctx) {
  const low = new Set(staffIds(ctx.cfg, 0)); for (const id of staffIds(ctx.cfg, LEVELS.admin)) low.delete(id);
  const rows = [
    ...ctx.db.prepare("SELECT channel_id c FROM tickets WHERE status='open' AND channel_id IS NOT NULL").all(),
    ...ctx.db.prepare("SELECT channel_id c FROM deals WHERE status NOT IN ('completed','cancelled') AND channel_id IS NOT NULL").all(),
    ...ctx.db.prepare("SELECT dispute_channel_id c FROM deals WHERE dispute_channel_id IS NOT NULL AND status!='completed'").all(),
  ];
  let n = 0;
  for (const { c } of rows) {
    const ch = await fetchChannel(ctx, c); if (!ch?.permissionOverwrites) continue;
    await ch.permissionOverwrites.edit(ch.guild.roles.everyone.id, { ViewChannel: false }).catch(() => {});
    for (const id of low) if (ch.permissionOverwrites.cache?.has(id)) { await ch.permissionOverwrites.delete(id).catch(() => {}); }
    n++;
  }
  return n;
}
