import { audit } from './audit.js';
import { DealError } from './deals.js';

export function addVouch(db, { dealId, author, rating, text }) {
  const d = db.prepare('SELECT * FROM deals WHERE id=?').get(dealId);
  if (!d) throw new DealError('No deal with that ID.');
  if (d.status !== 'completed' || !d.completed_at) throw new DealError('Vouches can only be left for deals the provider has confirmed as completed.');
  if (d.party_a !== author && d.party_b !== author) throw new DealError('Only participants of that deal can vouch for it.');
  const target = d.party_a === author ? d.party_b : d.party_a;
  const ts = new Date().toISOString();
  try {
    db.tx(() => {
      db.prepare('INSERT INTO vouches(deal_id,author,target,rating,text,created_at) VALUES(?,?,?,?,?,?)').run(dealId, author, target, rating, text, ts);
      audit(db, { actor: author, action: 'vouch.created', dealId, detail: { rating } });
    });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new DealError('You already left a vouch for this deal.');
    throw e;
  }
  return { deal: d, target, createdAt: ts };
}
