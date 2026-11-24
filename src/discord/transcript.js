
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
