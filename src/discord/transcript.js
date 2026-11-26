
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

// ---------- HTML transcript (opens in any browser, no account needed) ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rich = (s) => esc(s)
  .replace(/&lt;a?:(\w+):(\d+)&gt;/g, (_, n, id) => `<img class="emoji" alt=":${n}:" src="https://cdn.discordapp.com/emojis/${id}.png?size=44">`)
  .replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@user $1</span>').replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="mention">@role</span>').replace(/&lt;#(\d+)&gt;/g, '<span class="mention">#channel</span>')
  .replace(/&lt;t:(\d+)(?::\w)?&gt;/g, (_, t) => new Date(Number(t) * 1000).toUTCString())
  .replace(/^#{1,3} (.+)$/gm, '<b>$1</b>')
  .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');

/** Plain text and button labels found inside a Components V2 message, in order. */
export function componentLines(c, out = []) {
  const j = c?.toJSON ? c.toJSON() : c; if (!j) return out;
  if (j.type === 10 && j.content) out.push(j.content);
  else if (j.type === 2 && j.label) out.push(`[ ${j.label} ]`);
  else if (j.type === 11 || j.type === 12) for (const it of j.items ?? []) if (it?.description) out.push(it.description);
  for (const k of ['components', 'accessory']) for (const x of [].concat(j[k] ?? [])) componentLines(x, out);
  return out;
}

const CSS = `body{margin:0;background:#313338;color:#dbdee1;font:15px/1.4 "gg sans","Segoe UI",Helvetica,Arial,sans-serif}.head{padding:22px 16px 12px;border-bottom:1px solid #3f4147}.head h1{margin:0;font-size:30px;color:#fff}.head p{margin:4px 0 0;color:#949ba4}.msgs{padding:8px 16px 90px}.m{display:flex;gap:16px;margin-top:18px}.av{width:40px;height:40px;border-radius:50%;background:#5865f2;flex:none}.name{font-weight:600;color:#fff}.app{background:#5865f2;color:#fff;border-radius:4px;font-size:10px;padding:1px 4px;margin-left:4px;vertical-align:1px}.time{color:#949ba4;font-size:12px;margin-left:6px}.body{max-width:720px;word-wrap:break-word}.card{margin-top:6px;border-left:4px solid #5865f2;background:#2b2d31;border-radius:4px;padding:8px 12px}.card .t{font-weight:700;color:#fff}.card .f{margin-top:6px}.emoji{width:20px;height:20px;vertical-align:-4px}.mention{background:rgba(88,101,242,.3);color:#c9cdfb;border-radius:3px;padding:0 2px}code{background:#1e1f22;border-radius:3px;padding:1px 4px}.att{margin-top:4px;color:#00a8fc}.foot{position:fixed;left:0;right:0;bottom:0;background:#1e1f22;padding:14px 32px;color:#dbdee1}`;

/** One self-contained HTML file for a room. `messages` are discord.js Message objects, oldest first. */
export function renderHtml(messages, { title, channelName, generatedAt = new Date() }) {
  const rows = messages.map((m) => {
    const a = m.author ?? {}; const name = m.member?.displayName ?? a.globalName ?? a.username ?? 'Unknown';
    const avatar = a.displayAvatarURL?.({ size: 64, extension: 'png' });
    const parts = [];
    if (m.content) parts.push(`<div>${rich(m.content)}</div>`);
    for (const e of m.embeds ?? []) {
      const d = e.data ?? e;
      parts.push(`<div class="card" style="border-color:${d.color != null ? `#${Number(d.color).toString(16).padStart(6, '0')}` : '#5865f2'}">${d.title ? `<div class="t">${rich(d.title)}</div>` : ''}${d.description ? `<div>${rich(d.description)}</div>` : ''}${(d.fields ?? []).map((f) => `<div class="f"><b>${rich(f.name)}</b><br>${rich(f.value)}</div>`).join('')}</div>`);
    }
    const lines = (m.components ?? []).flatMap((c) => componentLines(c));
    if (lines.length) parts.push(`<div class="card">${lines.map((l) => `<div>${rich(l)}</div>`).join('')}</div>`);
    for (const f of m.attachments?.values?.() ?? []) parts.push(`<div class="att">Attachment: ${esc(f.name)}</div>`);
    const at = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    return `<div class="m"><div class="av"${avatar ? ` style="background:url('${esc(avatar)}') center/cover"` : ''}></div><div class="body"><span class="name">${esc(name)}</span>${a.bot ? '<span class="app">APP</span>' : ''}<span class="time">${at} UTC</span>${parts.join('') || '<div>&nbsp;</div>'}</div></div>`;
  }).join('\n');
  const when = generatedAt.toISOString().replace('T', ' ').slice(0, 19);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body><div class="head"><h1>Welcome to #${esc(channelName)}!</h1><p>This is the start of the #${esc(channelName)} channel. ${esc(title)}</p></div><div class="msgs">${rows || '<p>No messages.</p>'}</div><div class="foot">This transcript was generated on ${when} (UTC)</div></body></html>`;
}
