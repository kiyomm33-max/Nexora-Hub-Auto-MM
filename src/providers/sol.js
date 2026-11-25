// Self-custody Solana wallet (native SOL). One deal = one address derived from the shared recovery phrase (SLIP-10 ed25519, m/44'/501'/idx'/0').
import crypto from 'node:crypto';
import * as bip39 from 'bip39';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { log } from '../logger.js';
import { audit } from '../core/audit.js';

const LAMPORTS = 1_000_000_000n; const TX_FEE = 5000n;
export const RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
const eid = (...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex').slice(0, 40);
export const fmtSol = (l) => { const [i, f = ''] = (Number(l) / 1e9).toFixed(9).split('.'); const fr = f.replace(/0+$/, ''); return fr ? `${i}.${fr}` : i; };

/** SLIP-10 ed25519 derivation (hardened only). Returns the 32-byte private seed. */
export function slip10(seed, indexes) {
  let I = crypto.createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let k = I.subarray(0, 32); let c = I.subarray(32);
  for (const i of indexes) {
    const idx = Buffer.alloc(4); idx.writeUInt32BE((i | 0x80000000) >>> 0);
    I = crypto.createHmac('sha512', c).update(Buffer.concat([Buffer.from([0]), k, idx])).digest();
    k = I.subarray(0, 32); c = I.subarray(32);
  }
  return Buffer.from(k);
}

/** Thin RPC with failover. Tests replace it with a mock of the same shape. */
export function makeRpc(urls) {
  const conns = urls.map((u) => new Connection(u, 'confirmed'));
  const any = async (fn) => { const errs = []; for (const [i, c] of conns.entries()) { try { return await fn(c); } catch (e) { errs.push(`${urls[i]} ${e.message}`); } } throw new Error(errs.join(' | ')); };
  return {
    balance: (addr, commitment = 'confirmed') => any(async (c) => BigInt(await c.getBalance(new PublicKey(addr), commitment))),
    latestSig: (addr) => any(async (c) => (await c.getSignaturesForAddress(new PublicKey(addr), { limit: 1 }))[0]?.signature ?? null),
    blockhash: () => any((c) => c.getLatestBlockhash('confirmed')),
    blockHeight: () => any((c) => c.getBlockHeight('confirmed')),
    send: (raw) => any((c) => c.sendRawTransaction(raw, { preflightCommitment: 'confirmed' })),
    status: (sig) => any(async (c) => { const s = (await c.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0]; return !s ? null : { confirmed: ['confirmed', 'finalized'].includes(s.confirmationStatus), err: !!s.err }; }),
  };
}

export class SolWallet {
  name = 'Nexora SOL Wallet';
  live = true;
  constructor(cfg, db, { mnemonic, rpc, fetchImpl = fetch } = {}) {
    this.cfg = cfg; this.db = db; this.fetch = fetchImpl;
    this.mnemonic = mnemonic.mnemonic; this.source = mnemonic.source;
    this.seed = bip39.mnemonicToSeedSync(this.mnemonic);
    this.rpc = rpc ?? makeRpc(cfg.sol?.rpcs ?? RPCS);
    db.exec(`CREATE TABLE IF NOT EXISTS xwallet(family TEXT NOT NULL, idx INTEGER NOT NULL, deal_id TEXT UNIQUE NOT NULL, address TEXT NOT NULL, expected TEXT NOT NULL,
      required_conf INTEGER NOT NULL, rate_usd TEXT, funded INTEGER NOT NULL DEFAULT 0, payout_state TEXT, payout_txid TEXT, payout_extra TEXT, payout_amount TEXT, payout_error TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY(family, idx))`);
    this.treasury = cfg.sol?.treasury || this.#kp(1000000).publicKey.toBase58();
    this.validateAddress(this.treasury);
  }
  #kp(idx) { return Keypair.fromSeed(slip10(this.seed, [44, 501, idx, 0])); }
  supports(asset, network) { return asset === 'SOL' && network === 'solana'; }
  validateAddress(a) {
    try { const pk = new PublicKey(a); if (pk.toBase58() !== a) throw new Error('bad'); return a; } catch { throw new Error('That is not a valid Solana address.'); }
  }
  explorerTx(txid) { return `https://solscan.io/tx/${txid}`; }
  payoutInfo(dealId) {
    const w = this.db.prepare("SELECT payout_txid, payout_amount FROM xwallet WHERE family='sol' AND deal_id=?").get(dealId); if (!w?.payout_txid) return null;
    return { txid: w.payout_txid, url: this.explorerTx(w.payout_txid), explorerName: 'Solscan', amount: w.payout_amount };
  }
  async rate() {
    const sources = [
      async () => (await (await this.fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(8000) })).json()).data.amount,
      async () => (await (await this.fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(8000) })).json()).solana.usd,
    ];
    for (const s of sources) { try { const v = Number(await s()); if (v > 1 && v < 1e6) return v; } catch { /* next */ } }
    const e = new Error('Could not fetch the SOL price right now. Try again in a minute.'); e.userFacing = true; throw e;
  }
  async usdRate(d) { return ['USDT', 'USDC'].includes(d.asset) ? 1 : this.rate(); }
  async createEscrow(deal) {
    const usd = Number(deal.send_usd);
    if (usd > this.cfg.maxDealUsd) { const e = new Error(`Deals are limited to $${this.cfg.maxDealUsd} for now.`); e.userFacing = true; throw e; }
    const rate = await this.rate(); const e6 = BigInt(Math.ceil((usd / rate) * 1e6)); const expected = e6 * 1000n;
    const idx = Number(this.db.prepare("SELECT COALESCE(MAX(idx),-1)+1 AS n FROM xwallet WHERE family='sol'").get().n);
    const address = this.#kp(idx).publicKey.toBase58();
    this.db.prepare("INSERT INTO xwallet(family,idx,deal_id,address,expected,required_conf,rate_usd,created_at) VALUES('sol',?,?,?,?,1,?,?)").run(idx, deal.id, address, expected.toString(), String(rate), new Date().toISOString());
    return { reference: address, address, payAmount: (Number(e6) / 1e6).toFixed(6), rateUsd: rate.toFixed(2), instructions: 'Send the exact amount in ONE transaction on Solana.' };
  }
  async cancelEscrow() { return { ok: true }; }
  async referDispute() { return { ok: true, note: 'Funds stay in the escrow wallet. Staff review the evidence and the owner decides any refund or payout.' }; }
  async requestRelease() { return { accepted: true }; }
  async requestPayout() { return { accepted: true }; }

  async scan(emit) {
    const deals = this.db.prepare(`SELECT d.*, w.idx AS widx, w.expected, w.rate_usd AS wrate, w.funded, w.payout_state, w.payout_txid, w.payout_extra
      FROM deals d JOIN xwallet w ON w.deal_id=d.id AND w.family='sol' WHERE d.mode='live' AND d.status IN ('awaiting_provider','verification_pending')`).all();
    for (const d of deals) { try { await this.#scanDeal(d, emit); } catch (e) { log.error(`sol scan failed for ${d.id}: ${e?.message ?? e}`); } }
    return { scanned: deals.length };
  }
  async #scanDeal(d, emit) {
    if (d.payout_state === 'broadcast') return this.#confirmPayout(d, emit);
    const exp = BigInt(d.expected); const seen = await this.rpc.balance(d.pay_address, 'confirmed');
    const minOk = (exp * (1000n - BigInt(Math.round((this.cfg.evm?.tolerance ?? 0.005) * 1000)))) / 1000n;
    if (seen > 0n && d.payout_state == null) {
      const fin = await this.rpc.balance(d.pay_address, 'finalized'); const final = fin >= seen;
      const txid = await this.rpc.latestSig(d.pay_address).catch(() => null);
      const base = { reference: d.pay_address, amount: fmtSol(seen), required_confirmations: 1, ...(txid ? { txid } : {}) };
      if (seen < minOk) emit({ id: eid('short', d.pay_address, seen), type: 'funds.underpaid', confirmations: final ? 1 : 0, ...base });
      emit({ id: eid('obs', d.pay_address, seen), type: 'funds.observed', confirmations: final ? 1 : 0, ...base });
      if (final) emit({ id: eid('conf', d.pay_address, seen), type: 'funds.confirmed_on_chain', confirmations: 1, ...base });
      if (final && seen >= minOk && !d.funded) {
        this.db.prepare("UPDATE xwallet SET funded=1 WHERE family='sol' AND deal_id=?").run(d.id);
        emit({ id: eid('fund', d.pay_address), type: 'escrow.funded', confirmations: 1, ...base });
      } else if (final && seen < minOk) {
        const k = `underpaid:${d.id}:${seen}`;
        if (!this.db.prepare('SELECT 1 FROM audit_log WHERE action=? AND deal_id=?').get(k, d.id)) audit(this.db, { category: 'provider', actor: 'sol-wallet', action: k, dealId: d.id, detail: { expected: fmtSol(exp), received: fmtSol(seen) } });
      }
    }
    if (d.funded && d.released_at && d.payout_address && d.status === 'verification_pending' && d.payout_state == null) await this.#payout(d, seen);
  }
  /** The sender chose to continue with a smaller payment: the balance now on the address becomes the expected amount. */
  async acceptShort(dealId) {
    const d = this.db.prepare('SELECT pay_address FROM deals WHERE id=?').get(dealId);
    const seen = await this.rpc.balance(d.pay_address, 'confirmed');
    if (seen <= 0n) throw new Error('No payment found on the address.');
    this.db.prepare("UPDATE xwallet SET expected=? WHERE family='sol' AND deal_id=? AND funded=0 AND payout_state IS NULL").run(seen.toString(), dealId);
    return { amount: fmtSol(seen) };
  }
  async #confirmPayout(d, emit) {
    const st = await this.rpc.status(d.payout_txid);
    if (st?.err) { this.db.prepare("UPDATE xwallet SET payout_state='failed' WHERE family='sol' AND deal_id=?").run(d.id); audit(this.db, { category: 'provider', actor: 'sol-wallet', action: 'payout.reverted', dealId: d.id, detail: { sig: d.payout_txid } }); log.error('sol payout transaction failed', { deal: d.id }); return; }
    if (st?.confirmed) { emit({ id: eid('done', d.pay_address), type: 'escrow.completed', reference: d.pay_address }); return; }
    // never landed and the blockhash has expired: safe to rebuild and send again
    const last = Number(JSON.parse(d.payout_extra ?? '{}').lastValid ?? 0);
    if (last && (await this.rpc.blockHeight()) > last + 5) { this.db.prepare("UPDATE xwallet SET payout_state=NULL, payout_txid=NULL WHERE family='sol' AND deal_id=?").run(d.id); log.warn('sol payout expired before landing; retrying', { deal: d.id }); }
  }
  async #send(kp, outs) {
    const { blockhash, lastValidBlockHeight } = await this.rpc.blockhash();
    const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash });
    for (const o of outs) tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(o.to), lamports: o.lamports }));
    tx.sign(kp);
    return { sig: await this.rpc.send(tx.serialize()), lastValidBlockHeight };
  }
  async #payout(d, total) {
    const claim = this.db.prepare("UPDATE xwallet SET payout_state='sending' WHERE family='sol' AND deal_id=? AND payout_state IS NULL").run(d.id);
    if (!claim.changes) return;
    try {
      const kp = this.#kp(d.widx); if (kp.publicKey.toBase58() !== d.pay_address) throw new Error('derived address mismatch — refusing to sign');
      const rate = Number(d.wrate); const feeUsd = Number(d.send_usd) - Number(d.receive_usd);
      const fee = feeUsd > 0 ? BigInt(Math.round((feeUsd / rate) * 1e9)) : 0n;
      const toReceiver = total - fee - TX_FEE; if (toReceiver <= 0n) throw new Error('amount too small after fees');
      const outs = [{ to: d.payout_address, lamports: toReceiver }, ...(fee > 0n ? [{ to: this.treasury, lamports: fee }] : [])];
      const { sig, lastValidBlockHeight } = await this.#send(kp, outs);
      this.db.prepare("UPDATE xwallet SET payout_state='broadcast', payout_txid=?, payout_amount=?, payout_extra=? WHERE family='sol' AND deal_id=?").run(sig, fmtSol(toReceiver), JSON.stringify({ lastValid: lastValidBlockHeight }), d.id);
      audit(this.db, { category: 'provider', actor: 'sol-wallet', action: 'payout.broadcast', dealId: d.id, detail: { sig, to: d.payout_address, feeLamports: fee.toString() } });
    } catch (e) {
      this.db.prepare("UPDATE xwallet SET payout_state=NULL, payout_error=? WHERE family='sol' AND deal_id=?").run(String(e.message ?? e).slice(0, 300), d.id);
      audit(this.db, { category: 'provider', actor: 'sol-wallet', action: 'payout.failed', dealId: d.id, detail: { error: String(e.message ?? e).slice(0, 300) } });
      log.error('sol payout failed (will retry)', { deal: d.id, err: String(e.message ?? e) });
    }
  }
  /** Owner-only refund: everything at the deal address (minus the network fee) to `to`. */
  async sweep(dealId, to) {
    const d = this.db.prepare("SELECT d.*, w.idx AS widx, w.payout_state FROM deals d JOIN xwallet w ON w.deal_id=d.id AND w.family='sol' WHERE d.id=?").get(dealId);
    if (!d) throw new Error('No SOL wallet entry for that deal.');
    if (d.payout_state === 'broadcast') throw new Error('This deal was already paid out.');
    this.validateAddress(to);
    const kp = this.#kp(d.widx); if (kp.publicKey.toBase58() !== d.pay_address) throw new Error('derived address mismatch — refusing to sign');
    const total = await this.rpc.balance(d.pay_address, 'confirmed'); if (total <= TX_FEE) throw new Error('no funds at the deal address');
    const claim = this.db.prepare("UPDATE xwallet SET payout_state='sweeping' WHERE family='sol' AND deal_id=? AND payout_state IS NULL").run(dealId);
    if (!claim.changes) throw new Error('A payout or refund is already in progress for this deal.');
    try {
      const { sig } = await this.#send(kp, [{ to, lamports: total - TX_FEE }]);
      this.db.prepare("UPDATE xwallet SET payout_state='swept', payout_txid=? WHERE family='sol' AND deal_id=?").run(sig, dealId);
      return sig;
    } catch (e) { this.db.prepare("UPDATE xwallet SET payout_state=NULL WHERE family='sol' AND deal_id=? AND payout_state='sweeping'").run(dealId); throw e; }
  }
  start(emit, everyMs = 20000) {
    const tick = () => this.scan(emit).catch((e) => log.error(`sol scan error: ${e?.message ?? e}`));
    this.timer = setInterval(tick, everyMs); this.timer.unref?.(); tick();
  }
}
