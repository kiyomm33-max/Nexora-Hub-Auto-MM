// Self-custody Litecoin escrow wallet (HD, P2WPKH). The bot generates one deposit address per deal, watches the
// chain through the public litecoinspace.org API (Esplora), and signs + broadcasts the payout itself.
// RISK: the seed controls every deposit. Keep it out of logs/code, back it up offline, and cap deal size.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { BIP32Factory } from 'bip32';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as bip39 from 'bip39';
import { log } from '../logger.js';
import { audit } from '../core/audit.js';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

export const NETWORKS = {
  mainnet: {
    net: { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 },
    coin: 2, api: 'https://litecoinspace.org/api', explorer: 'https://litecoinspace.org',
    blockbook: 'https://litecoinblockexplorer.net/api/v2', // fallback when the primary is down
    blockcypher: 'https://api.blockcypher.com/v1/ltc/main', // second fallback (free tier: ~200 calls/hour, so it is cached)
  },
  testnet: {
    net: { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'tltc', bip32: { public: 0x043587cf, private: 0x04358394 }, pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
    coin: 1, api: 'https://litecoinspace.org/testnet/api', explorer: 'https://litecoinspace.org/testnet',
  },
};
const SAT = 1e8; const DUST = 546;
const eid = (...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex').slice(0, 40); // event ids must be <= 100 chars
export const toSat = (s) => Math.round(Number(s) * SAT);
export const fromSat = (n) => (n / SAT).toFixed(8);

/** Load the wallet mnemonic: env var first, otherwise a file on the volume (created on first live start). */
export function loadMnemonic(cfg) {
  if (cfg.ltc.mnemonic) { if (!bip39.validateMnemonic(cfg.ltc.mnemonic)) throw new Error('LTC_MNEMONIC is not a valid BIP39 phrase'); return { mnemonic: cfg.ltc.mnemonic, source: 'env' }; }
  const file = path.join(cfg.dataDir, 'wallet.json');
  if (fs.existsSync(file)) return { mnemonic: JSON.parse(fs.readFileSync(file, 'utf8')).mnemonic, source: 'file' };
  const mnemonic = bip39.generateMnemonic(256);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mnemonic, created: new Date().toISOString() }), { mode: 0o600 });
  log.warn('New LTC wallet generated on the data volume. Owner must run /staff wallet-backup and store the phrase offline.');
  return { mnemonic, source: 'generated' };
}

export class LtcWallet {
  name = 'Nexora LTC Wallet';
  live = true;
  constructor(cfg, db, { fetchImpl = fetch, mnemonic } = {}) {
    this.cfg = cfg; this.db = db; this.fetch = fetchImpl;
    const base = NETWORKS[cfg.ltc.network]; if (!base) throw new Error(`LTC_NETWORK must be mainnet or testnet`);
    this.n = { ...base, api: cfg.ltc.apiUrl || base.api }; // LTC_API_URL: any Esplora-compatible endpoint
    const m = mnemonic ?? loadMnemonic(cfg); this.mnemonic = m.mnemonic; this.source = m.source;
    this.root = bip32.fromSeed(bip39.mnemonicToSeedSync(this.mnemonic), this.n.net);
    db.exec(`CREATE TABLE IF NOT EXISTS ltc_wallet(idx INTEGER PRIMARY KEY, deal_id TEXT UNIQUE NOT NULL, address TEXT UNIQUE NOT NULL,
      expected_sat INTEGER, required_conf INTEGER, rate_usd TEXT, funded INTEGER NOT NULL DEFAULT 0, seen_txids TEXT NOT NULL DEFAULT '[]',
      payout_state TEXT, payout_txid TEXT, payout_error TEXT, created_at TEXT NOT NULL)`);
    try { db.exec('ALTER TABLE ltc_wallet ADD COLUMN payout_sat INTEGER'); } catch { /* column already exists */ }
    this.treasury = cfg.ltc.treasury || this.#addr(this.#key(1, 0));
    this.validateAddress(this.treasury);
  }
  // m/84'/coin'/account'/0/index  — account 0 = deal deposits, account 1 = fee treasury (unless overridden)
  #key(account, index) { return this.root.derivePath(`m/84'/${this.n.coin}'/${account}'/0/${index}`); }
  #addr(node) { return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(node.publicKey), network: this.n.net }).address; }
  validateAddress(a) {
    try { bitcoin.address.toOutputScript(a, this.n.net); } catch { throw new Error(`That is not a valid Litecoin ${this.cfg.ltc.network} address.`); }
    return a;
  }
  explorerTx(txid) { return this.cfg.ltc.network === 'mainnet' ? `https://live.blockcypher.com/ltc/tx/${txid}/` : `${this.n.explorer}/tx/${txid}`; }
  /** What the completed-deals post shows: the payout transaction and what the receiver got. */
  payoutInfo(dealId) {
    const w = this.db.prepare('SELECT payout_txid, payout_sat FROM ltc_wallet WHERE deal_id=?').get(dealId);
    if (!w?.payout_txid) return null;
    return { txid: w.payout_txid, url: this.explorerTx(w.payout_txid), explorerName: this.cfg.ltc.network === 'mainnet' ? 'BlockCypher' : 'Explorer', amount: w.payout_sat ? fromSat(w.payout_sat) : null };
  }

  async #get(base, p) { const r = await this.fetch(`${base}${p}`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`chain api ${base}${p} -> ${r.status}`); return r.json(); }
  /** Run the same call against each configured backend (Esplora, then Blockbook, then BlockCypher) until one answers. */
  async #chain(esplora, blockbook, cypher) {
    const errs = [];
    try { return await esplora(this.n.api); } catch (e) { errs.push(e.message); }
    if (this.n.blockbook && blockbook) { try { return await blockbook(this.n.blockbook); } catch (e) { errs.push(e.message); } }
    if (this.n.blockcypher && cypher) { try { return await cypher(this.n.blockcypher); } catch (e) { errs.push(e.message); } }
    throw new Error(errs.join(' | '));
  }
  #cache = new Map();
  async #cached(key, ttlMs, fn) { const c = this.#cache.get(key); if (c && Date.now() - c.at < ttlMs) return c.v; const v = await fn(); this.#cache.set(key, { at: Date.now(), v }); return v; }
  #tip() {
    return this.#chain((b) => this.#get(b, '/blocks/tip/height'), async (b) => Number((await this.#get(b, '')).blockbook.bestHeight),
      (b) => this.#cached('cy-tip', 60e3, async () => Number((await this.#get(b, '')).height)));
  }
  async #utxos(addr) {
    return this.#chain((b) => this.#get(b, `/address/${addr}/utxo`), async (b) => {
      const best = Number((await this.#get(b, '')).blockbook.bestHeight);
      return (await this.#get(b, `/utxo/${addr}`)).map((u) => ({ txid: u.txid, vout: u.vout, value: Number(u.value),
        status: Number(u.confirmations) > 0 ? { confirmed: true, block_height: best - Number(u.confirmations) + 1 } : { confirmed: false } }));
    }, (b) => this.#cached(`cy-utxo-${addr}`, 40e3, async () => {
      const j = await this.#get(b, `/addrs/${addr}?unspentOnly=true&limit=200`);
      return [...(j.txrefs ?? []), ...(j.unconfirmed_txrefs ?? [])].filter((u) => !u.double_spend).map((u) => ({ txid: u.tx_hash, vout: u.tx_output_n, value: Number(u.value),
        status: Number(u.confirmations) > 0 ? { confirmed: true, block_height: Number(u.block_height) } : { confirmed: false } }));
    }));
  }
  async #broadcast(hex) {
    return this.#chain(async (b) => {
      const r = await this.fetch(`${b}/tx`, { method: 'POST', body: hex, headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(20000) });
      const body = await r.text(); if (!r.ok) throw new Error(`broadcast rejected: ${body.slice(0, 160)}`); return body.trim();
    }, async (b) => { const j = await this.#get(b, `/sendtx/${hex}`); if (!j.result) throw new Error(`broadcast rejected: ${JSON.stringify(j).slice(0, 160)}`); return j.result; },
    async (b) => {
      const r = await this.fetch(`${b}/txs/push`, { method: 'POST', body: JSON.stringify({ tx: hex }), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({})); if (!r.ok || !j.tx?.hash) throw new Error(`broadcast rejected: ${JSON.stringify(j).slice(0, 160)}`); return j.tx.hash;
    });
  }
  async rate() {
    const sources = [
      async () => (await (await this.fetch('https://api.coinbase.com/v2/prices/LTC-USD/spot', { signal: AbortSignal.timeout(8000) })).json()).data.amount,
      async () => (await (await this.fetch('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd', { signal: AbortSignal.timeout(8000) })).json()).litecoin.usd,
    ];
    for (const s of sources) { try { const v = Number(await s()); if (v > 1 && v < 100000) return v; } catch {} }
    const e = new Error('Could not fetch the LTC price right now. Try again in a minute.'); e.userFacing = true; throw e;
  }

  async createEscrow(deal) {
    const usd = Number(deal.send_usd);
    if (usd > this.cfg.ltc.maxDealUsd) { const e = new Error(`Deals are limited to $${this.cfg.ltc.maxDealUsd} for now.`); e.userFacing = true; throw e; }
    const rate = await this.rate();
    const sat = Math.ceil((usd / rate) * SAT);
    const row = this.db.prepare('INSERT INTO ltc_wallet(idx,deal_id,address,created_at,expected_sat,required_conf,rate_usd) VALUES(?,?,?,?,?,?,?)');
    // reserve the index first so the address is bound to exactly one deal
    const idx = Number(this.db.prepare('SELECT COALESCE(MAX(idx),-1)+1 AS n FROM ltc_wallet').get().n);
    const address = this.#addr(this.#key(0, idx));
    row.run(idx, deal.id, address, new Date().toISOString(), sat, this.cfg.ltc.confirmations, String(rate));
    return { reference: address, address, payAmount: fromSat(sat), rateUsd: rate.toFixed(2), instructions: 'Send the exact amount in ONE transaction.' };
  }
  async cancelEscrow() { return { ok: true }; }
  async referDispute() { return { ok: true, note: 'Funds stay in the escrow wallet. Staff review the evidence and the owner decides any refund or payout.' }; }
  async requestRelease() { return { accepted: true }; }
  async requestPayout() { return { accepted: true }; } // the watcher performs it (and retries on failure)

  /** One scan of every active deal. emit(event) feeds deals.applyProviderEvent. Returns a summary for tests/logs. */
  async scan(emit) {
    const tip = await this.#tip();
    const deals = this.db.prepare(`SELECT d.*, w.expected_sat, w.required_conf AS wreq, w.rate_usd AS wrate, w.payout_state, w.payout_txid, w.funded
      FROM deals d JOIN ltc_wallet w ON w.deal_id=d.id WHERE d.mode='live' AND d.status IN ('awaiting_provider','verification_pending')`).all();
    for (const d of deals) {
      try { await this.#scanDeal(d, tip, emit); } catch (e) { log.error(`ltc scan failed for ${d.id}: ${e?.message ?? e}`); }
    }
    return { scanned: deals.length };
  }
  async #scanDeal(d, tip, emit) {
    const utxos = await this.#utxos(d.pay_address);
    const confOf = (u) => (u.status?.confirmed ? tip - u.status.block_height + 1 : 0);
    const total = utxos.reduce((s, u) => s + u.value, 0);
    const minConf = utxos.length ? Math.min(...utxos.map(confOf)) : 0;
    const need = d.wreq ?? this.cfg.ltc.confirmations;
    if (utxos.length && d.payout_state == null) {
      const first = utxos[0];
      emit({ id: eid('obs', d.pay_address, first.txid), type: 'funds.observed', reference: d.pay_address, txid: first.txid, amount: fromSat(total), confirmations: minConf, required_confirmations: need });
      if (minConf >= 1) emit({ id: eid('conf', d.pay_address, total, Math.min(minConf, need)), type: 'funds.confirmed_on_chain', reference: d.pay_address, txid: first.txid, amount: fromSat(total), confirmations: minConf, required_confirmations: need });
      const enough = total >= Math.floor(d.expected_sat * (1 - this.cfg.ltc.tolerance));
      if (minConf >= need && enough && !d.funded) {
        this.db.prepare('UPDATE ltc_wallet SET funded=1 WHERE deal_id=?').run(d.id);
        emit({ id: eid('fund', d.pay_address), type: 'escrow.funded', reference: d.pay_address, txid: first.txid, amount: fromSat(total), confirmations: minConf, required_confirmations: need });
      } else if (minConf >= need && !enough) {
        const k = `underpaid:${d.id}:${total}`;
        if (!this.db.prepare('SELECT 1 FROM audit_log WHERE action=? AND deal_id=?').get(k, d.id)) audit(this.db, { category: 'provider', actor: 'ltc-wallet', action: k, dealId: d.id, detail: { expected: fromSat(d.expected_sat), received: fromSat(total) } });
      }
    }
    // payout once the sender released and the receiver gave an address
    if (d.funded && d.released_at && d.payout_address && d.payout_state == null && d.status === 'verification_pending') {
      await this.#payout(d, utxos, emit);
    }
  }
  /** Build, sign and broadcast the payout. Guarded by a DB flag so a deal can never be paid out twice. */
  async #payout(d, utxos, emit) {
    const claim = this.db.prepare("UPDATE ltc_wallet SET payout_state='sending' WHERE deal_id=? AND payout_state IS NULL").run(d.id);
    if (!claim.changes) return;
    try {
      const rate = Number(d.wrate);
      const feeSat = Math.max(0, Math.round(((Number(d.send_usd) - Number(d.receive_usd)) / rate) * SAT));
      const outs = [{ address: d.payout_address, key: 'receiver' }];
      const treasurySat = feeSat >= DUST ? feeSat : 0;
      const txid = await this.#sendAll(d, utxos, treasurySat);
      this.db.prepare("UPDATE ltc_wallet SET payout_state='broadcast', payout_txid=? WHERE deal_id=?").run(txid, d.id);
      audit(this.db, { category: 'provider', actor: 'ltc-wallet', action: 'payout.broadcast', dealId: d.id, detail: { txid, to: d.payout_address, treasurySat, outs: outs.length } });
      emit({ id: eid('done', d.pay_address), type: 'escrow.completed', reference: d.pay_address });
    } catch (e) {
      this.db.prepare("UPDATE ltc_wallet SET payout_state=NULL, payout_error=? WHERE deal_id=?").run(String(e.message ?? e).slice(0, 300), d.id);
      audit(this.db, { category: 'provider', actor: 'ltc-wallet', action: 'payout.failed', dealId: d.id, detail: { error: String(e.message ?? e).slice(0, 300) } });
      log.error('ltc payout failed (will retry)', { deal: d.id, err: String(e) });
    }
  }
  async #feeRate() {
    try { return Math.max(2, Number(await this.#chain(async (b) => (await this.#get(b, '/v1/fees/recommended')).halfHourFee, async (b) => Math.ceil(Number((await this.#get(b, '/estimatefee/2')).result) * 1e5))) || 2); } catch { return 5; }
  }

  /** Spend every confirmed UTXO of the deal address: treasurySat to the treasury, the rest minus miner fee to `to`. */
  async #sendAll(d, utxos, treasurySat, to = d.payout_address) {
    const idx = this.db.prepare('SELECT idx FROM ltc_wallet WHERE deal_id=?').get(d.id).idx;
    const key = this.#key(0, idx);
    const kp = ECPair.fromPrivateKey(Buffer.from(key.privateKey), { network: this.n.net });
    const pay = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKey), network: this.n.net });
    if (pay.address !== d.pay_address) throw new Error('derived address mismatch — refusing to sign');
    if (!utxos.length) throw new Error('no funds at the deal address');
    const total = utxos.reduce((s, u) => s + u.value, 0);
    const outputsN = treasurySat ? 2 : 1;
    const vsize = Math.ceil(10.5 + 68 * utxos.length + 31 * outputsN);
    const miner = Math.ceil(vsize * (await this.#feeRate()));
    const toSat = total - treasurySat - miner;
    if (toSat < DUST) throw new Error('amount too small after fees');
    const psbt = new bitcoin.Psbt({ network: this.n.net });
    for (const u of utxos) psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: pay.output, value: u.value } });
    psbt.addOutput({ address: this.validateAddress(to), value: toSat });
    if (treasurySat) psbt.addOutput({ address: this.treasury, value: treasurySat });
    psbt.signAllInputs(kp); psbt.finalizeAllInputs();
    const hex = psbt.extractTransaction().toHex();
    const txid = await this.#broadcast(hex);
    this.db.prepare('UPDATE ltc_wallet SET payout_sat=? WHERE deal_id=?').run(toSat, d.id);
    return txid;
  }

  /** Owner-only refund/override: send everything at a deal's address (minus miner fee) to `to`. No treasury cut. */
  async sweep(dealId, to) {
    const d = this.db.prepare('SELECT d.*, w.payout_state FROM deals d JOIN ltc_wallet w ON w.deal_id=d.id WHERE d.id=?').get(dealId);
    if (!d) throw new Error('Not an LTC wallet deal.');
    if (d.payout_state === 'broadcast') throw new Error('This deal was already paid out.');
    const claim = this.db.prepare("UPDATE ltc_wallet SET payout_state='sweeping' WHERE deal_id=? AND (payout_state IS NULL)").run(dealId);
    if (!claim.changes) throw new Error('A payout is already in progress for this deal.');
    try {
      const utxos = await this.#utxos(d.pay_address);
      const txid = await this.#sendAll(d, utxos, 0, to);
      this.db.prepare("UPDATE ltc_wallet SET payout_state='swept', payout_txid=? WHERE deal_id=?").run(txid, dealId);
      return txid;
    } catch (e) { this.db.prepare('UPDATE ltc_wallet SET payout_state=NULL WHERE deal_id=?').run(dealId); throw e; }
  }

  start(emit, everyMs = 20000) {
    const tick = () => this.scan(emit).catch((e) => log.error(`ltc scan error: ${e?.cause?.code ?? ''} ${e?.message ?? e}`));
    this.timer = setInterval(tick, everyMs); this.timer.unref?.(); tick();
  }
}
