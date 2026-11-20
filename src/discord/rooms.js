import crypto from 'node:crypto';
import { ChannelType, PermissionFlagsBits as P, AttachmentBuilder } from 'discord.js';
import { LEVELS, CAPS } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { log } from '../logger.js';
import { base, dealEmbed, completedEmbed, BRAND } from './ui.js';
import { payloadFor } from './automm.js';

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
export async function refreshStatus(ctx, deal, { bump = false } = {}) {
  const ch = await fetchChannel(ctx, deal.channel_id);
  if (!ch) return;
  const payload = { ...(await payloadFor(ctx, deal)), allowedMentions: bump ? { users: [deal.sender_id, deal.receiver_id].filter(Boolean) } : { parse: [] } };
  if (deal.status_message_id) {
    // bump = repost at the bottom of the room (and ping) so the buttons are never buried under notices
    if (bump) { try { await (await ch.messages.fetch(deal.status_message_id)).delete(); } catch { /* already gone */ } }
    else { try { return await (await ch.messages.fetch(deal.status_message_id)).edit(payload); } catch (e) { log.error('status edit failed, reposting', e); } }
  }
  const m = await ch.send(payload);
  ctx.deals.setChannel(deal.id, 'status_message_id', m.id);
}

export async function publishCompleted(ctx, deal) {
  if (deal.status !== 'completed' || deal.completed_message_id) return;
  const ch = await fetchChannel(ctx, ctx.cfg.channels.completed);
  if (!ch) return;
  const name = async (id) => { try { const u = await ctx.client.users.fetch(id); return `**${u.username}** (<@${id}>)`; } catch { return `<@${id}>`; } };
  const names = { a: await name(deal.party_a), b: await name(deal.party_b), middleman: deal.middleman_id ? await name(deal.middleman_id) : null };
  // Deliberately omits item, value, asset, network, wallet and provider data.
  const m = await ch.send({ embeds: [completedEmbed(ctx.cfg, deal, names)], allowedMentions: { parse: [] } });
  ctx.deals.setChannel(deal.id, 'completed_message_id', m.id);
  audit(ctx.db, { actor: 'system', action: 'completed_deal.published', dealId: deal.id, detail: { messageId: m.id } });
}

const NOTICE = {
  observed: (d) => `Provider reported a payment observation (${d.confirmations} conf.). This is a blockchain observation, **not** escrow confirmation.`,
  escrow: () => 'The escrow provider has **confirmed the funds are held in escrow**.',
  completed: () => 'The payout was sent and this deal is **complete**. This room closes automatically in 5 minutes and a transcript is saved.',
  cancelled: () => 'This deal was cancelled.',
  claimed: (d) => `<@${d.middleman_id}> is now the assigned middleman.`,
  evidence: () => 'New evidence was added to the deal record.',
  released: (d) => `The sender released the payment. <@${d.receiver_id}>, provide your ${d.asset} address to receive the payout.`,
  disputed: () => 'A dispute was opened and **referred to the external escrow provider**. Staff will review evidence; staff cannot release disputed funds.',
};

export async function syncDeal(ctx, deal, change) {
  if (change === 'activated' || change === 'confirmed') return;
  await refreshStatus(ctx, deal, { bump: ['escrow', 'released'].includes(change) });
  const room = await fetchChannel(ctx, deal.channel_id);
  if (room && NOTICE[change] && !['observed', 'escrow', 'released'].includes(change)) await room.send({ embeds: [base(ctx.cfg, 'Deal update', NOTICE[change](deal), deal.status === 'disputed' ? BRAND.red : BRAND.purple)], allowedMentions: { parse: [] } }).catch(() => {});
  if (change === 'disputed') await ensureDisputeChannel(ctx, deal);
  if (change === 'completed') await publishCompleted(ctx, deal);
  if (['disputed', 'completed', 'cancelled'].includes(change))
    await staffLog(ctx, base(ctx.cfg, `Deal ${change}`, `\`${deal.id}\` is now **${deal.status}**.`));
}

export async function ensureDisputeChannel(ctx, deal) {
  if (deal.dispute_channel_id) return;
  const guild = await ctx.client.guilds.fetch(ctx.cfg.guildId);
  const id = newTicketId();
  const ch = await createPrivateChannel(guild, ctx.cfg, { name: `dispute-${deal.id.slice(4).toLowerCase()}`, parent: ctx.cfg.channels.disputeCategory, minStaff: CAPS['dispute.review'], topic: `Staff review for ${deal.id}` });
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
/** Store the transcript (immutable hash) and send it to the staff transcript channel. */
export async function saveTranscript(ctx, refId, channel, by) {
  const body = renderTranscript(await collectMessages(channel)) || '(empty)';
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  ctx.db.prepare('INSERT OR IGNORE INTO transcripts(ticket_id,body,sha256,created_at) VALUES(?,?,?,?)').run(refId, body, sha, new Date().toISOString());
  audit(ctx.db, { category: 'staff', actor: by, action: 'transcript.saved', detail: { refId, sha256: sha, channel: channel.id } });
  const out = await fetchChannel(ctx, ctx.cfg.channels.transcripts);
  if (out) await out.send({ embeds: [base(ctx.cfg, `Transcript  •  ${refId}`, `SHA-256 \`${sha}\``)], files: [new AttachmentBuilder(Buffer.from(body), { name: `${refId}.txt` })], allowedMentions: { parse: [] } });
  return sha;
}
