import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { audit } from './audit.js';
import { calcFee } from './fees.js';

export const STATUS = {
  waiting_parties: 'Waiting for both parties',
  awaiting_provider: 'Awaiting external provider verification',
  verification_pending: 'Verification pending',
  disputed: 'Disputed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
const ALLOWED = {
  waiting_parties: ['awaiting_provider', 'cancelled'],
  awaiting_provider: ['verification_pending', 'disputed', 'cancelled'],
  verification_pending: ['disputed', 'completed', 'cancelled'],
  disputed: ['completed', 'cancelled'],
  completed: [], cancelled: [],
};
const now = () => new Date().toISOString();
const newId = () => {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; const b = crypto.randomBytes(8);
  return 'NXH-' + [...b].map((x) => A[x % 32]).join('');
};

export class DealError extends Error {}

export class DealService extends EventEmitter {
  constructor(db, { mode }) { super(); this.db = db; this.mode = mode; }
  get(id) { return this.db.prepare('SELECT * FROM deals WHERE id=?').get(id); }
  byChannel(ch) { return this.db.prepare('SELECT * FROM deals WHERE channel_id=? OR dispute_channel_id=?').get(ch, ch); }
  forUser(u, limit = 10) {
    return this.db.prepare('SELECT * FROM deals WHERE party_a=? OR party_b=? ORDER BY created_at DESC LIMIT ?').all(u, u, limit);
  }
  isParty(d, u) { return d.party_a === u || d.party_b === u; }
  #emit(id, change) { this.emit('update', this.get(id), change); }

  create({ creator, partner, robloxA, robloxB, item, amount, currency, asset, network }) {
    if (creator === partner) throw new DealError('You cannot open a deal with yourself.');
    const id = newId(); const t = now();
    this.db.tx(() => {
      this.db.prepare(`INSERT INTO deals(id,status,mode,party_a,party_b,roblox_a,roblox_b,item,amount,currency,asset,network,confirmed_a,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
        .run(id, 'waiting_parties', this.mode, creator, partner, robloxA, robloxB, item, amount, currency, asset, network, t, t);
      audit(this.db, { actor: creator, action: 'deal.created', dealId: id, detail: { mode: this.mode, asset, network, amount, currency } });
      audit(this.db, { actor: creator, action: 'deal.confirmed_by_party', dealId: id, detail: { side: 'a' } });
    });
    return this.get(id);
  }

  /** Auto-MM flow: a ticket is opened first, details are collected step by step. */
  createAuto({ creator, asset, network, channelId }) {
    const id = newId(); const t = now();
    this.db.tx(() => {
      this.db.prepare(`INSERT INTO deals(id,status,mode,party_a,asset,network,channel_id,setup,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(id, 'waiting_parties', this.mode, creator, asset, network, channelId, JSON.stringify({ step: 'partner', votes: {} }), t, t);
      audit(this.db, { actor: creator, action: 'deal.created', dealId: id, detail: { mode: this.mode, asset, network } });
    });
    return this.get(id);
  }
  openCount(user) {
    return this.db.prepare("SELECT COUNT(*) n FROM deals WHERE party_a=? AND status NOT IN ('completed','cancelled')").get(user).n;
  }
  setup(d) { try { return JSON.parse(d.setup || '{}'); } catch { return {}; } }
  /** Update setup-phase fields. Only allowed before the escrow exists; every change is audited. */
  patch(id, actor, fields, action, { silent = false } = {}) {
    const ok = ['party_b', 'deal_type', 'sender_id', 'receiver_id', 'desc_by', 'item', 'amount', 'fee_usd', 'fee_payer', 'send_usd', 'receive_usd', 'confirmed_a', 'confirmed_b', 'setup'];
    const keys = Object.keys(fields);
    if (keys.some((k) => !ok.includes(k))) throw new Error('field not patchable');
    const v = keys.map((k) => (k === 'setup' ? JSON.stringify(fields[k]) : fields[k]));
    this.db.tx(() => {
      const r = this.db.prepare(`UPDATE deals SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=? AND status='waiting_parties'`).run(...v, now(), id);
      if (r.changes !== 1) throw new DealError('This deal can no longer be edited.');
      if (!silent) audit(this.db, { actor, action, dealId: id, detail: Object.fromEntries(keys.filter((k) => k !== 'setup').map((k) => [k, fields[k]])) });
    });
    return this.get(id);
  }

  /** Sender asks for release; starts a visible countdown. Idempotent. */
  scheduleRelease(id, user, seconds = 60) {
    const d = this.get(id);
    if (!d) throw new DealError('Deal not found.');
    if (d.sender_id !== user) throw new DealError('Only the sender can release the payment.');
    if (d.status !== 'verification_pending' || d.escrow_status !== 'provider_confirmed') throw new DealError('Payment has not been confirmed by the provider yet.');
    if (d.release_at) return { deal: d, started: false };
    if (this.db.prepare('SELECT 1 FROM cancel_req WHERE deal_id=?').get(id)) throw new DealError('A cancel request is open. Finish or decline it before releasing.');
    const at = new Date(Date.now() + seconds * 1000).toISOString();
    this.db.tx(() => {
      const r = this.db.prepare('UPDATE deals SET release_at=?, release_by=?, updated_at=? WHERE id=? AND release_at IS NULL').run(at, user, now(), id);
      if (r.changes) audit(this.db, { actor: user, action: 'release.requested', dealId: id, detail: { releaseAt: at } });
    });
    return { deal: this.get(id), started: true };
  }
  cancelRelease(id, user) {
    const d = this.get(id);
    if (!d?.release_at) throw new DealError('No release is pending.');
    if (d.release_by !== user) throw new DealError('Only the person who started the release can cancel it.');
    this.db.tx(() => { this.db.prepare('UPDATE deals SET release_at=NULL, release_by=NULL, updated_at=? WHERE id=?').run(now(), id); audit(this.db, { actor: user, action: 'release.cancelled', dealId: id }); });
    this.#emit(id, 'release_cancelled'); return this.get(id);
  }
  /** Countdown elapsed: the sender's release is approved. The receiver must now supply a payout address. */
  markReleased(id) {
    const d = this.releaseDue(id); if (!d) return null;
    this.db.tx(() => {
      this.db.prepare('UPDATE deals SET released_at=?, release_at=NULL, updated_at=? WHERE id=? AND released_at IS NULL').run(now(), now(), id);
      audit(this.db, { actor: d.release_by, action: 'release.approved', dealId: id, detail: {} });
    });
    this.#emit(id, 'released'); return this.get(id);
  }
  /** Receiver supplies the payout address once; it cannot be changed afterwards. */
  setPayout(id, user, address) {
    const d = this.get(id);
    if (!d) throw new DealError('Deal not found.');
    if (d.receiver_id !== user) throw new DealError('Only the receiver can provide the payout address.');
    if (d.status !== 'verification_pending' || !d.released_at) throw new DealError('The sender has not released the payment yet.');
    if (d.payout_address) throw new DealError('A payout address was already submitted for this deal.');
    this.db.tx(() => {
      const r = this.db.prepare('UPDATE deals SET payout_address=?, payout_requested_at=?, updated_at=? WHERE id=? AND payout_address IS NULL').run(address, now(), now(), id);
      if (r.changes !== 1) throw new DealError('A payout address was already submitted for this deal.');
      audit(this.db, { actor: user, action: 'payout.address_submitted', dealId: id, detail: { addressTail: address.slice(-6) } });
    });
    return this.get(id);
  }
  /** Returns the deal if its countdown has elapsed and the release is still valid. */
  releaseDue(id) {
    const d = this.get(id);
    if (!d?.release_at || d.released_at || d.status !== 'verification_pending' || d.escrow_status !== 'provider_confirmed') return null;
    return Date.parse(d.release_at) <= Date.now() + 250 ? d : null;
  }

  /** Idempotent: confirming twice changes nothing. Returns {deal, both, changed}. */
  confirm(id, user) {
    const d = this.get(id);
    if (!d) throw new DealError('Deal not found.');
    if (!this.isParty(d, user)) throw new DealError('Only the two parties can confirm this deal.');
    if (d.status !== 'waiting_parties') throw new DealError('This deal is no longer waiting for confirmation.');
    const col = d.party_a === user ? 'confirmed_a' : 'confirmed_b';
    if (d[col]) return { deal: d, both: !!(d.confirmed_a && d.confirmed_b), changed: false };
    this.db.tx(() => {
      this.db.prepare(`UPDATE deals SET ${col}=1, updated_at=? WHERE id=?`).run(now(), id);
      audit(this.db, { actor: user, action: 'deal.confirmed_by_party', dealId: id, detail: { side: col === 'confirmed_a' ? 'a' : 'b' } });
    });
    const nd = this.get(id);
    this.#emit(id, 'confirmed');
    return { deal: nd, both: !!(nd.confirmed_a && nd.confirmed_b), changed: true };
  }

  #transition(id, to, actor, action, detail = {}, extra = {}) {
    return this.db.tx(() => {
      const d = this.get(id);
      if (!d) throw new DealError('Deal not found.');
      if (!ALLOWED[d.status].includes(to)) throw new DealError(`Cannot move a deal from "${STATUS[d.status]}" to "${STATUS[to]}".`);
      const sets = ['status=?', 'updated_at=?']; const vals = [to, now()];
      for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); vals.push(v); }
      const r = this.db.prepare(`UPDATE deals SET ${sets.join(',')} WHERE id=? AND status=?`).run(...vals, id, d.status);
      if (r.changes !== 1) throw new DealError('Deal changed concurrently; try again.');
      audit(this.db, { category: detail.staff ? 'staff' : 'deal', actor, action, dealId: id, detail: { from: d.status, to, ...detail } });
      return this.get(id);
    });
  }

  /** Both parties confirmed and an escrow reference was created by the provider. */
  activate(id, { provider, reference, channelId, address = null, payAmount = null, rateUsd = null }) {
    const d = this.get(id);
    if (!(d.confirmed_a && d.confirmed_b)) throw new DealError('Both parties must confirm first.');
    const nd = this.#transition(id, 'awaiting_provider', 'system', 'deal.escrow_created', { provider, reference },
      { provider, provider_ref: reference, escrow_status: 'pending', channel_id: channelId, confirmed_at: now(), pay_address: address, pay_amount: payAmount, rate_usd: rateUsd });
    this.#emit(id, 'activated'); return nd;
  }
  setChannel(id, col, channelId) {
    if (!['channel_id', 'dispute_channel_id', 'status_message_id', 'completed_message_id'].includes(col)) throw new Error('bad column');
    this.db.prepare(`UPDATE deals SET ${col}=? WHERE id=?`).run(channelId, id);
  }

  cancel(id, actor, reason, { staff = false } = {}) {
    const d = this.get(id);
    if (!d) throw new DealError('Deal not found.');
    if (!staff && !this.isParty(d, actor)) throw new DealError('Only participants or authorised staff can cancel.');
    if (d.status === 'disputed') throw new DealError('Disputed deals can only be resolved by the external provider.');
    if (d.escrow_status === 'provider_confirmed' || d.observed_status !== 'none')
      throw new DealError('Funds have been observed or secured by the provider. Cancellation must go through the provider; open a dispute or contact staff.');
    const nd = this.#transition(id, 'cancelled', actor, 'deal.cancelled', { reason, staff }, { cancelled_at: now() });
    this.#emit(id, 'cancelled'); return nd;
  }

  /** The sender accepted a smaller payment than quoted: the deal continues with what was actually received. `usdValue` is the USD worth of the received coins. */
  acceptShort(id, actor, receivedCrypto, usdValue, feeCfg) {
    const d = this.get(id);
    if (!d || d.short_state !== 'pending') throw new DealError('There is no short payment to accept.');
    if (d.sender_id !== actor) throw new DealError('Only the sender can accept a smaller payment.');
    const send = Math.floor(usdValue * 100) / 100;
    const fee = calcFee(send, feeCfg);
    const receive = Math.round((send - fee) * 100) / 100;
    if (!(receive > 0)) throw new DealError('That amount is too small to continue with. Cancel and get it refunded.');
    this.db.tx(() => {
      this.db.prepare("UPDATE deals SET short_state='accepted', received_crypto=?, amount=?, send_usd=?, fee_usd=?, receive_usd=?, updated_at=? WHERE id=? AND short_state='pending'")
        .run(receivedCrypto, receive.toFixed(2), send.toFixed(2), fee.toFixed(2), receive.toFixed(2), now(), id);
      audit(this.db, { actor, action: 'payment.short_accepted', dealId: id, detail: { quoted: d.send_usd, received: receivedCrypto, send_usd: send.toFixed(2), fee_usd: fee.toFixed(2), receive_usd: receive.toFixed(2) } });
    });
    this.#emit(id, 'observed'); return this.get(id);
  }

  /** Both traders agreed to cancel and the funds were returned to the sender on-chain. Only possible before any release. */
  refundCancel(id, actor, { txid, address, short = false }) {
    const d = this.get(id);
    if (!d) throw new DealError('Deal not found.');
    if (d.status !== 'verification_pending' || d.release_at || d.released_at) throw new DealError('This deal can no longer be cancelled with a refund.');
    const nd = this.#transition(id, 'cancelled', actor, 'deal.refunded', { reason: short ? 'sender cancelled after a short payment' : 'both traders agreed to cancel', refundTx: txid, refundTo: address }, { cancelled_at: now() });
    this.#emit(id, 'cancelled'); return nd;
  }

  dispute(id, actor, reason, { staff = false } = {}) {
    const d = this.get(id);
    if (!d) throw new DealError('Deal not found.');
    if (!staff && !this.isParty(d, actor)) throw new DealError('Only participants or staff can open a dispute.');
    const nd = this.#transition(id, 'disputed', actor, 'deal.disputed', { reason, staff, referred_to_provider: true }, { disputed_at: now(), release_at: null, release_by: null });
    this.#emit(id, 'disputed'); return nd;
  }

  claim(id, staffId) {
    const d = this.get(id);
    if (!d) throw new DealError('Deal not found.');
    if (['completed', 'cancelled'].includes(d.status)) throw new DealError('This deal is closed.');
    if (this.isParty(d, staffId)) throw new DealError('You cannot act as middleman on your own deal.');
    const r = this.db.tx(() => {
      const u = this.db.prepare('UPDATE deals SET middleman_id=?, updated_at=? WHERE id=? AND middleman_id IS NULL').run(staffId, now(), id);
      if (u.changes) audit(this.db, { category: 'staff', actor: staffId, action: 'deal.claimed', dealId: id, detail: { staff: true } });
      return u.changes;
    });
    if (!r) throw new DealError(`Already claimed by <@${this.get(id).middleman_id}>.`);
    this.#emit(id, 'claimed'); return this.get(id);
  }

  addEvidence(id, author, note, url) {
    const d = this.get(id);
    if (!d) throw new DealError('Deal not found.');
    this.db.tx(() => {
      this.db.prepare('INSERT INTO evidence(deal_id,author,note,url,created_at) VALUES(?,?,?,?,?)').run(id, author, note, url, now());
      audit(this.db, { actor: author, action: 'evidence.submitted', dealId: id, detail: { hasUrl: !!url, noteLen: note.length } });
    });
    this.#emit(id, 'evidence');
  }

  /**
   * Apply a signature-verified, normalized provider event.
   * type: funds.observed | funds.confirmed_on_chain | escrow.funded | escrow.completed | escrow.disputed | escrow.cancelled
   * Idempotent on event.id. Returns {outcome}.
   */
  applyProviderEvent(ev, { simulated = false } = {}) {
    const known = ['funds.underpaid', 'funds.observed', 'funds.confirmed_on_chain', 'escrow.funded', 'escrow.completed', 'escrow.disputed', 'escrow.cancelled'];
    if (!ev || typeof ev.id !== 'string' || ev.id.length > 100 || !known.includes(ev.type) || typeof ev.reference !== 'string')
      return { outcome: 'invalid' };
    let outcome = 'applied'; let dealId = null; let change = null;
    try {
      this.db.tx(() => {
        if (this.db.prepare('SELECT 1 FROM webhook_events WHERE event_id=?').get(ev.id)) { outcome = 'duplicate'; throw new Error('__dup'); }
        const d = this.db.prepare('SELECT * FROM deals WHERE provider_ref=?').get(ev.reference);
        dealId = d?.id ?? null;
        const rec = (o) => this.db.prepare('INSERT INTO webhook_events(event_id,deal_id,type,simulated,outcome,received_at) VALUES(?,?,?,?,?,?)')
          .run(ev.id, dealId, ev.type, simulated ? 1 : 0, o, now());
        if (!d) { outcome = 'unknown_reference'; rec(outcome); return; }
        if (!!simulated !== (d.mode === 'demo')) { outcome = 'mode_mismatch'; rec(outcome); return; }
        const act = (action, detail) => audit(this.db, { category: 'provider', actor: `provider:${d.provider}`, action, dealId, detail: { eventId: ev.id, simulated, ...detail } });
        const set = (sql, ...v) => this.db.prepare(`UPDATE deals SET ${sql}, updated_at=? WHERE id=?`).run(...v, now(), dealId);
        const terminal = ['completed', 'cancelled'].includes(d.status);
        const txd = {};
        if (typeof ev.txid === 'string' && /^[A-Za-z0-9_.:-]{6,128}$/.test(ev.txid)) txd.tx_hash = ev.txid;
        if (typeof ev.amount === 'string' && /^\d{1,12}(\.\d{1,12})?$/.test(ev.amount)) txd.received_crypto = ev.amount;
        if (Number.isInteger(ev.required_confirmations) && ev.required_confirmations >= 1 && ev.required_confirmations <= 1000) txd.required_conf = ev.required_confirmations;
        const setTx = () => { const k = Object.keys(txd); if (k.length) this.db.prepare(`UPDATE deals SET ${k.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...k.map((c) => txd[c]), dealId); };
        switch (ev.type) {
          case 'funds.underpaid':
            if (terminal || d.escrow_status === 'provider_confirmed' || d.released_at) { outcome = 'ignored_state'; break; }
            if (typeof ev.amount !== 'string' || !txd.received_crypto) { outcome = 'invalid'; break; }
            setTx();
            if (d.status === 'awaiting_provider') this.#move(d, 'verification_pending', ev, simulated);
            set('short_state=?, short_crypto=?', 'pending', ev.amount);
            act('payment.underpaid', { received: ev.amount, note: 'Less than the quoted amount; waiting for the sender to continue or cancel' });
            change = 'short'; break;
          case 'funds.observed':
            if (terminal) { outcome = 'ignored_final'; break; }
            setTx();
            set('observed_status=?, confirmations=?', d.observed_status === 'none' ? 'seen' : d.observed_status, Math.max(d.confirmations, Number(ev.confirmations) || 0));
            if (d.status === 'awaiting_provider') this.#move(d, 'verification_pending', ev, simulated);
            act('payment.observed', { confirmations: ev.confirmations ?? 0, note: 'Blockchain observation only - NOT escrow confirmation' });
            change = 'observed'; break;
          case 'funds.confirmed_on_chain':
            if (terminal) { outcome = 'ignored_final'; break; }
            setTx();
            set('observed_status=?, confirmations=?', 'confirmed_on_chain', Math.max(d.confirmations, Number(ev.confirmations) || 0));
            if (d.status === 'awaiting_provider') this.#move(d, 'verification_pending', ev, simulated);
            act('payment.confirmed_on_chain', { confirmations: ev.confirmations ?? 0, note: 'Blockchain observation only - NOT escrow confirmation' });
            change = 'observed'; break;
          case 'escrow.funded':
            if (terminal) { outcome = 'ignored_final'; break; }
            set('escrow_status=?, short_state=NULL', 'provider_confirmed');
            if (d.status === 'awaiting_provider') this.#move(d, 'verification_pending', ev, simulated);
            act('escrow.provider_confirmed', { note: 'Escrow funds confirmed by provider' });
            change = 'escrow'; break;
          case 'escrow.completed':
            if (d.status === 'completed') { outcome = 'duplicate_completion'; break; }
            if (d.status === 'cancelled') { outcome = 'ignored_final'; break; }
            if (d.escrow_status !== 'provider_confirmed') { outcome = 'rejected_not_funded'; break; }
            if (!d.payout_address) { outcome = 'rejected_no_payout_address'; break; }
            this.#move(d, 'completed', ev, simulated, { completed_at: now() });
            change = 'completed'; break;
          case 'escrow.disputed':
            if (['awaiting_provider', 'verification_pending'].includes(d.status)) { this.#move(d, 'disputed', ev, simulated, { disputed_at: now(), release_at: null, release_by: null }); change = 'disputed'; }
            else outcome = 'ignored_state';
            break;
          case 'escrow.cancelled':
            if (d.status === 'completed') { outcome = 'ignored_final'; break; }
            if (d.status === 'cancelled') { outcome = 'duplicate'; break; }
            this.#move(d, 'cancelled', ev, simulated, { cancelled_at: now() });
            change = 'cancelled'; break;
        }
        rec(outcome);
        if (outcome !== 'applied') audit(this.db, { category: 'provider', actor: `provider:${d.provider}`, action: `provider_event.${outcome}`, dealId, detail: { eventId: ev.id, type: ev.type } });
      });
    } catch (e) {
      if (e.message !== '__dup') throw e;
    }
    if (outcome === 'applied' && change && dealId) this.#emit(dealId, change);
    return { outcome, dealId };
  }
  #move(d, to, ev, simulated, extra = {}) {
    const sets = ['status=?']; const vals = [to];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); vals.push(v); }
    const r = this.db.prepare(`UPDATE deals SET ${sets.join(',')} WHERE id=? AND status=?`).run(...vals, d.id, d.status);
    if (r.changes !== 1) throw new DealError('concurrent');
    audit(this.db, { category: 'provider', actor: `provider:${d.provider}`, action: `deal.status.${to}`, dealId: d.id, detail: { from: d.status, to, eventId: ev.id, simulated } });
  }
}
