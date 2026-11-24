import { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { UserError } from './automm.js';
import { audit } from '../core/audit.js';

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

export function renderHtml(refId, body, meta = {}, at = new Date()) {
  const msgs = parseBody(body);
  const rows = msgs.map((m) => `<div class="m"><div class="h"><span class="n">${esc(m.name)}</span><span class="t">${esc(m.at.replace('T', ' ').slice(0, 19))} UTC</span></div><div class="c">${esc(m.text).replace(/\n/g, '<br>')}</div></div>`).join('\n') || '<p class="t">No messages.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Transcript ${esc(refId)}</title><style>
body{background:#313338;color:#dbdee1;font:15px/1.4 "gg sans",Segoe UI,Arial,sans-serif;margin:0;padding:24px}
h1{color:#fff;font-size:26px;margin:0 0 4px}.s{color:#949ba4;margin-bottom:18px}.m{padding:8px 0;border-top:1px solid #3f4147}
.n{color:#fff;font-weight:600;margin-right:8px}.t{color:#949ba4;font-size:12px}.c{margin-top:2px;word-break:break-word;white-space:normal}
.f{margin-top:24px;background:#232428;padding:14px 16px;border-radius:6px}</style></head><body>
<h1>${esc(meta.title ?? refId)}</h1><div class="s">${esc(meta.status ? `Status: ${meta.status} - ` : '')}${msgs.length} message${msgs.length === 1 ? '' : 's'}</div>
${rows}
<div class="f">This transcript was generated on ${esc(at.toUTCString())}.</div></body></html>`;
}
export const htmlFile = (refId, body, meta, at) => new AttachmentBuilder(Buffer.from(renderHtml(refId, body, meta, at)), { name: `transcript_${refId}.html` });
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
  try { await i.user.send({ content: `Transcript for **${meta.title}**`, files: [htmlFile(refId, row.body, meta)] }); }
  catch { throw new UserError('I could not DM you. Turn on direct messages from server members, then press the button again.'); }
  audit(ctx.db, { category: 'staff', actor: i.user.id, action: 'transcript.viewed', detail: { refId } });
  return i.editReply({ content: 'I sent the transcript to your DMs.' });
}
