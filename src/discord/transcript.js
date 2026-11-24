import { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { UserError } from './automm.js';
import { audit } from '../core/audit.js';
import { base } from './ui.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LINE = /^\[(\d{4}-\d\d-\d\dT[^\]]+)\] (.*?) \((\d+|\?)\): ?(.*)$/;

/** Turn the stored plain text back into messages. A line that does not start a message continues the one before it. */
export function parseBody(body) {
  const out = [];
  for (const line of String(body).split('\n')) {
    const m = LINE.exec(line);
    if (m) out.push({ at: m[1], name: m[2], id: m[3], text: m[4] });
    else if (out.length) out.at(-1).text += `\n${line}`;
  }
  return out;
}

/** Who a transcript belongs to and what it was about, from the deal or ticket row. */
export function metaOf(db, refId) {
  const d = db.prepare('SELECT * FROM deals WHERE id=?').get(refId);
  if (d) return { kind: 'Deal', title: `Deal ${d.id}`, status: d.status, amount: d.receive_usd || d.amount, asset: d.asset, parties: [...new Set([d.party_a, d.party_b, d.sender_id, d.receiver_id].filter(Boolean))], middleman: d.middleman_id };
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(refId);
  if (t) return { kind: 'Ticket', title: `${t.kind} ticket ${t.id}`, status: t.status, parties: [t.opener].filter((x) => x && x !== 'system') };
  return { kind: 'Room', title: refId, parties: [] };
}

const PAGE = 3800; const MAX_PAGES = 15;
/** The conversation as embed pages (Discord caps an embed at 4096 characters). */
export function pages(cfg, refId, body, meta = {}) {
  const msgs = parseBody(body);
  const lines = msgs.map((m) => `**${m.name}** <t:${Math.floor(Date.parse(m.at) / 1000)}:f>\n${m.text.length > 1500 ? `${m.text.slice(0, 1500)}...` : m.text}`);
  const chunks = []; let cur = '';
  for (const l of lines) { if (cur && cur.length + l.length + 2 > PAGE) { chunks.push(cur); cur = ''; } cur += (cur ? '\n\n' : '') + l; }
  if (cur || !chunks.length) chunks.push(cur || '*No messages.*');
  const head = [`**ID:** \`${refId}\``, meta.status ? `**Status:** ${meta.status}` : null, `**Messages:** ${msgs.length}`].filter(Boolean).join('\n');
  const total = chunks.length;
  return chunks.slice(0, MAX_PAGES).map((c, k) => base(cfg, k ? `${meta.title ?? refId} (${k + 1}/${total})` : `${meta.title ?? refId}${total > 1 ? ` (1/${total})` : ''}`, k ? c : `${head}\n\n${c}`));
}
/** Send the transcript into a user's DMs as readable messages. Throws if their DMs are closed. */
export async function dmTranscript(user, ctx, refId, body, meta) {
  const embeds = pages(ctx.cfg, refId, body, meta);
  for (const e of embeds) await user.send({ embeds: [e] });
  const total = Math.ceil(String(body).length / PAGE);
  if (embeds.length >= MAX_PAGES && parseBody(body).length > 0 && total > MAX_PAGES) await user.send({ content: 'This transcript is long, so the full text is attached.', files: [new AttachmentBuilder(Buffer.from(body), { name: `transcript_${refId}.txt` })] });
}
export const viewButton = (refId) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`nx:tview:${refId}`).setLabel('View Transcript').setStyle(ButtonStyle.Primary));

/** The View Transcript button: sends the transcript to the member's DMs. Only the people in the room and admin-level staff may. */
export async function viewTranscript(i, ctx, refId, { isStaff }) {
  const row = ctx.db.prepare('SELECT body FROM transcripts WHERE ticket_id=?').get(refId);
  if (!row) throw new UserError('That transcript is not saved yet. It is saved when the room closes.');
  const meta = metaOf(ctx.db, refId);
  if (!isStaff && !meta.parties.includes(i.user.id)) {
    audit(ctx.db, { category: 'security', actor: i.user.id, action: 'permission.denied', detail: { where: 'transcript.view', refId } });
    throw new UserError('Only the people in that room and staff can view this transcript.');
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try { await dmTranscript(i.user, ctx, refId, row.body, meta); }
  catch { throw new UserError('I could not DM you. Turn on direct messages from server members, then press the button again.'); }
  audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'transcript.viewed', detail: { refId } });
  return i.editReply({ content: 'I sent the transcript to your DMs.' });
}
