// Self-custody wallet for EVM chains (Ethereum, BNB Smart Chain): native coin and ERC-20/BEP-20 tokens.
// One HD wallet; every deal gets its own address (m/44'/60'/0'/0/idx). Same recovery phrase as LTC.
import crypto from 'node:crypto';
import { HDNodeWallet, Mnemonic, JsonRpcProvider, Network, Interface, isAddress, getAddress, formatUnits, zeroPadValue, id as keccakId } from 'ethers';
import { log } from '../logger.js';
import { audit } from '../core/audit.js';

export const CHAINS = {
  ethereum: { id: 1, native: 'ETH', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'], explorer: 'https://etherscan.io', explorerName: 'Etherscan', conf: 6 },
  bsc: { id: 56, native: 'BNB', rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'], explorer: 'https://bscscan.com', explorerName: 'BscScan', conf: 15 },
};
export const ASSETS = {
  'ETH:ethereum': { chain: 'ethereum', symbol: 'ETH', decimals: 18, price: 'ETH-USD' },
  'USDT:ethereum': { chain: 'ethereum', symbol: 'USDT', decimals: 6, token: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  'USDC:ethereum': { chain: 'ethereum', symbol: 'USDC', decimals: 6, token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  'USDT:bsc': { chain: 'bsc', symbol: 'USDT', decimals: 18, token: '0x55d398326f99059fF775485246999027B3197955' },
};
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const TRANSFER_TOPIC = keccakId('Transfer(address,address,uint256)');
const TOKEN_GAS = 100000n; const NATIVE_GAS = 21000n;
const eid = (...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex').slice(0, 40);
const pow10 = (n) => 10n ** BigInt(n);
/** Units to a short decimal string (max 8 decimals, rounded down) that fits the event amount format. */
export const fmt = (units, dec, max = 8) => { const [i, f = ''] = formatUnits(units, dec).split('.'); const fr = f.slice(0, max).replace(/0+$/, ''); return fr ? `${i}.${fr}` : i; };

/** Thin JSON-RPC client with failover across several endpoints. Tests replace this with a mock of the same shape. */
export function makeRpc(urls, chainId) {
  const net = Network.from(chainId);
  const provs = urls.map((u) => new JsonRpcProvider(u, net, { staticNetwork: net, batchMaxCount: 1 }));
  const any = async (fn) => {
    const errs = [];
    for (const [i, p] of provs.entries()) { try { return await fn(p); } catch (e) { errs.push(`${urls[i]} ${e.shortMessage ?? e.message}`); } }
    throw new Error(errs.join(' | '));
  };
  return {
    blockNumber: () => any((p) => p.getBlockNumber()),
    balance: (a, tag = 'latest') => any((p) => p.getBalance(a, tag)),
    tokenBalance: (t, a, tag = 'latest') => any(async (p) => BigInt(await p.call({ to: t, data: ERC20.encodeFunctionData('balanceOf', [a]), blockTag: tag }))),
    gasPrice: () => any(async (p) => (await p.getFeeData()).gasPrice),
    nonce: (a) => any((p) => p.getTransactionCount(a, 'pending')),
    code: (a) => any((p) => p.getCode(a)),
    broadcast: (hex) => any(async (p) => (await p.broadcastTransaction(hex)).hash),
    status: (h) => any(async (p) => { const r = await p.getTransactionReceipt(h); return r ? { mined: true, success: r.status === 1 } : { mined: false }; }),
    findTransfer: async (token, addr, fromBlock) => { try { const logs = await any((p) => p.getLogs({ address: token, topics: [TRANSFER_TOPIC, null, zeroPadValue(addr, 32)], fromBlock, toBlock: 'latest' })); return logs.at(-1)?.transactionHash ?? null; } catch { return null; } },
  };
}

export class EvmWallet {
  name = 'Nexora EVM Wallet';
  live = true;
  constructor(cfg, db, { mnemonic, rpcFor, fetchImpl = fetch } = {}) {
    this.cfg = cfg; this.db = db; this.fetch = fetchImpl;
    this.mnemonic = mnemonic.mnemonic; this.source = mnemonic.source;
    this.rpcs = {}; this.rpcFor = rpcFor ?? ((chain) => (this.rpcs[chain] ??= makeRpc(cfg.evm.rpcs?.[chain] ?? CHAINS[chain].rpcs, CHAINS[chain].id)));
    this.root = Mnemonic.fromPhrase(this.mnemonic);
    db.exec(`CREATE TABLE IF NOT EXISTS xwallet(family TEXT NOT NULL, idx INTEGER NOT NULL, deal_id TEXT UNIQUE NOT NULL, address TEXT NOT NULL, expected TEXT NOT NULL,
      required_conf INTEGER NOT NULL, rate_usd TEXT, funded INTEGER NOT NULL DEFAULT 0, payout_state TEXT, payout_txid TEXT, payout_extra TEXT, payout_amount TEXT, payout_error TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY(family, idx))`);
    this.gas = this.#node(1, 0); this.gasAddress = this.gas.address;
    this.treasury = cfg.evm.treasury || this.#node(2, 0).address;
    this.validateAddress(this.treasury);
  }
  #node(account, index) { return HDNodeWallet.fromMnemonic(this.root, `m/44'/60'/${account}'/0/${index}`); }
  supports(asset, network) { return !!ASSETS[`${asset}:${network}`]; }
  validateAddress(a) {
    if (!isAddress(a)) throw new Error('That is not a valid EVM address (0x…, 42 characters, correct checksum).');
    return getAddress(a);
  }
  #meta(d) { const a = ASSETS[`${d.asset}:${d.network}`]; if (!a) throw new Error(`Unsupported asset ${d.asset} on ${d.network}`); return { ...a, ...CHAINS[a.chain], confirmations: this.cfg.evm.conf?.[a.chain] ?? CHAINS[a.chain].conf }; }
  explorerTx(txid, d) { const c = d ? this.#meta(d) : CHAINS.ethereum; return `${c.explorer}/tx/${txid}`; }
  payoutInfo(dealId) {
    const w = this.db.prepare("SELECT * FROM xwallet WHERE family='evm' AND deal_id=?").get(dealId); if (!w?.payout_txid) return null;
    const d = this.db.prepare('SELECT asset, network FROM deals WHERE id=?').get(dealId); const m = this.#meta(d);
    return { txid: w.payout_txid, url: `${m.explorer}/tx/${w.payout_txid}`, explorerName: m.explorerName, amount: w.payout_amount };
  }

  async rate(m) {
    if (!m.price) return 1; // stablecoins are quoted 1:1
    const sources = [
      async () => (await (await this.fetch(`https://api.coinbase.com/v2/prices/${m.price}/spot`, { signal: AbortSignal.timeout(8000) })).json()).data.amount,
      async () => (await (await this.fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { signal: AbortSignal.timeout(8000) })).json()).ethereum.usd,
    ];
    for (const s of sources) { try { const v = Number(await s()); if (v > 1 && v < 1e7) return v; } catch { /* next source */ } }
    const e = new Error(`Could not fetch the ${m.symbol} price right now. Try again in a minute.`); e.userFacing = true; throw e;
  }
  async usdRate(d) { return this.rate(this.#meta(d)); }
  async createEscrow(deal) {
    const m = this.#meta(deal); const usd = Number(deal.send_usd);
    if (usd > this.cfg.maxDealUsd) { const e = new Error(`Deals are limited to $${this.cfg.maxDealUsd} for now.`); e.userFacing = true; throw e; }
    const rate = await this.rate(m);
    let expected; let payAmount;
    if (m.token) { expected = BigInt(Math.round(usd * 100)) * pow10(m.decimals - 2); payAmount = usd.toFixed(2); }
    else { const e8 = BigInt(Math.ceil((usd / rate) * 1e8)); expected = e8 * pow10(m.decimals - 8); payAmount = (Number(e8) / 1e8).toFixed(8); }
    const idx = Number(this.db.prepare("SELECT COALESCE(MAX(idx),-1)+1 AS n FROM xwallet WHERE family='evm'").get().n);
    const address = this.#node(0, idx).address;
    this.db.prepare("INSERT INTO xwallet(family,idx,deal_id,address,expected,required_conf,rate_usd,created_at) VALUES('evm',?,?,?,?,?,?,?)").run(idx, deal.id, address, expected.toString(), m.confirmations, String(rate), new Date().toISOString());
    return { reference: address, address, payAmount, rateUsd: Number(rate).toFixed(2), instructions: `Send the exact amount in ONE transaction on ${m.chain === 'bsc' ? 'BNB Smart Chain (BEP-20)' : 'Ethereum (ERC-20)'}.` };
  }
  async cancelEscrow() { return { ok: true }; }
  async referDispute() { return { ok: true, note: 'Funds stay in the escrow wallet. Staff review the evidence and the owner decides any refund or payout.' }; }
  async requestRelease() { return { accepted: true }; }
  async requestPayout() { return { accepted: true }; }

  #rows() {
    return this.db.prepare(`SELECT d.*, w.idx AS widx, w.expected, w.required_conf AS wreq, w.rate_usd AS wrate, w.funded, w.payout_state, w.payout_txid, w.payout_extra
      FROM deals d JOIN xwallet w ON w.deal_id=d.id AND w.family='evm' WHERE d.mode='live' AND d.status IN ('awaiting_provider','verification_pending')`).all();
  }
  async scan(emit) {
    const deals = this.#rows();
    for (const d of deals) { try { await this.#scanDeal(d, emit); } catch (e) { log.error(`evm scan failed for ${d.id}: ${e?.message ?? e}`); } }
    return { scanned: deals.length };
  }
  async #bal(rpc, m, addr, tag) { return m.token ? rpc.tokenBalance(m.token, addr, tag) : rpc.balance(addr, tag); }
  async #scanDeal(d, emit) {
    const m = this.#meta(d); const rpc = this.rpcFor(m.chain); const exp = BigInt(d.expected);
    if (d.payout_state === 'broadcast') return this.#confirmPayout(d, rpc, emit);
    const tip = await rpc.blockNumber();
    const total = await this.#bal(rpc, m, d.pay_address, 'latest');
    const need = d.wreq ?? m.confirmations;
    const minOk = (exp * (1000n - BigInt(Math.round((this.cfg.evm.tolerance ?? 0.005) * 1000)))) / 1000n;
    if (total > 0n && d.payout_state == null) {
      const old = await this.#bal(rpc, m, d.pay_address, tip - (need - 1));
      const matured = old >= total; const conf = matured ? need : 1;
      const txid = m.token ? await rpc.findTransfer(m.token, d.pay_address, Math.max(0, tip - 5000)) : null;
      const base = { reference: d.pay_address, amount: fmt(total, m.decimals), required_confirmations: need, ...(txid ? { txid } : {}) };
      if (total < minOk) emit({ id: eid('short', d.pay_address, total), type: 'funds.underpaid', confirmations: conf, ...base });
      emit({ id: eid('obs', d.pay_address, total), type: 'funds.observed', confirmations: conf, ...base });
      emit({ id: eid('conf', d.pay_address, total, conf), type: 'funds.confirmed_on_chain', confirmations: conf, ...base });
      if (matured && total >= minOk && !d.funded) {
        this.db.prepare("UPDATE xwallet SET funded=1 WHERE family='evm' AND deal_id=?").run(d.id);
        emit({ id: eid('fund', d.pay_address), type: 'escrow.funded', confirmations: need, ...base });
      } else if (matured && total < minOk) {
        const k = `underpaid:${d.id}:${total}`;
        if (!this.db.prepare('SELECT 1 FROM audit_log WHERE action=? AND deal_id=?').get(k, d.id)) audit(this.db, { category: 'provider', actor: 'evm-wallet', action: k, dealId: d.id, detail: { expected: fmt(exp, m.decimals), received: fmt(total, m.decimals) } });
      }
    }
    if (d.funded && d.released_at && d.payout_address && d.status === 'verification_pending' && (d.payout_state == null || d.payout_state === 'gas_pending')) await this.#payout(d, m, rpc, total);
  }
  /** The sender chose to continue with a smaller payment: the balance now on the address becomes the expected amount. */
  async acceptShort(dealId) {
    const d = this.#rows().find((x) => x.id === dealId); if (!d) throw new Error('Deal not found.');
    const m = this.#meta(d); const total = await this.#bal(this.rpcFor(m.chain), m, d.pay_address, 'latest');
    if (total <= 0n) throw new Error('No payment found on the address.');
    this.db.prepare("UPDATE xwallet SET expected=? WHERE family='evm' AND deal_id=? AND funded=0 AND payout_state IS NULL").run(total.toString(), dealId);
    return { amount: fmt(total, m.decimals) };
  }
  async #confirmPayout(d, rpc, emit) {
    const hashes = [d.payout_txid, ...(d.payout_extra ? JSON.parse(d.payout_extra) : [])];
    const st = await Promise.all(hashes.map((h) => rpc.status(h)));
    if (st.some((s) => s.mined && !s.success)) {
      this.db.prepare("UPDATE xwallet SET payout_state='failed' WHERE family='evm' AND deal_id=?").run(d.id);
      audit(this.db, { category: 'provider', actor: 'evm-wallet', action: 'payout.reverted', dealId: d.id, detail: { hashes } });
      log.error('evm payout transaction reverted', { deal: d.id, hashes });
      return;
    }
    if (st.every((s) => s.mined)) emit({ id: eid('done', d.pay_address), type: 'escrow.completed', reference: d.pay_address });
  }

  async #signSend(node, rpc, chainId, { to, value = 0n, data = '0x', gasLimit, gasPrice, nonce }) {
    const raw = await node.signTransaction({ type: 0, chainId, to, value, data, gasLimit, gasPrice, nonce });
    return rpc.broadcast(raw);
  }
  /** Top up the deal address with native coin so it can pay gas for token transfers. Returns the gas tx hash. */
  async #topUp(d, m, rpc, need, have, gasPrice) {
    const gasBal = await rpc.balance(this.gasAddress, 'latest');
    const send = need - have;
    if (gasBal < send + gasPrice * NATIVE_GAS) throw new Error(`The gas wallet is out of ${m.native}. Send some ${m.native} (${m.chain}) to ${this.gasAddress} and the payout continues by itself.`);
    return this.#signSend(this.gas, rpc, m.id, { to: d.pay_address, value: send, gasLimit: NATIVE_GAS, gasPrice, nonce: await rpc.nonce(this.gasAddress) });
  }

  /** Pays the receiver and the fee address from the deal address. Guarded by a DB state so a deal is never paid twice. */
  async #payout(d, m, rpc, total) {
    const prev = d.payout_state;
    const claim = this.db.prepare("UPDATE xwallet SET payout_state='sending' WHERE family='evm' AND deal_id=? AND payout_state IS ?").run(d.id, prev);
    if (!claim.changes) return;
    const setState = (s, x = {}) => this.db.prepare("UPDATE xwallet SET payout_state=?, payout_txid=COALESCE(?,payout_txid), payout_extra=COALESCE(?,payout_extra), payout_amount=COALESCE(?,payout_amount) WHERE family='evm' AND deal_id=?").run(s, x.txid ?? null, x.extra ?? null, x.amount ?? null, d.id);
    try {
      const rate = Number(d.wrate); const gasPrice = ((await rpc.gasPrice()) * 12n) / 10n;
      const feeUsd = Number(d.send_usd) - Number(d.receive_usd);
      const feeUnits = feeUsd > 0 ? (m.token ? BigInt(Math.round(feeUsd * 100)) * pow10(m.decimals - 2) : BigInt(Math.round((feeUsd / rate) * 1e8)) * pow10(m.decimals - 8)) : 0n;
      const node = this.#node(0, d.widx); if (node.address !== d.pay_address) throw new Error('derived address mismatch — refusing to sign');
      if (!m.token && (await rpc.code(d.payout_address)) !== '0x') throw new Error('The payout address is a smart contract. Ask the receiver for a normal wallet address.');
      const txs = feeUnits > 0n ? 2n : 1n;
      let nonce = await rpc.nonce(d.pay_address); const sent = [];
      let toReceiver;
      if (m.token) {
        const need = txs * TOKEN_GAS * gasPrice; const have = await rpc.balance(d.pay_address, 'latest');
        if (have < need) {
          if (prev === 'gas_pending' && d.payout_extra) { const st = await rpc.status(JSON.parse(d.payout_extra)[0]); if (!st.mined) { setState('gas_pending'); return; } }
          const h = await this.#topUp(d, m, rpc, need + gasPrice * 5000n, have, gasPrice);
          setState('gas_pending', { extra: JSON.stringify([h]) }); return;
        }
        toReceiver = total - feeUnits; if (toReceiver <= 0n) throw new Error('amount too small after fees');
        sent.push(await this.#signSend(node, rpc, m.id, { to: m.token, data: ERC20.encodeFunctionData('transfer', [d.payout_address, toReceiver]), gasLimit: TOKEN_GAS, gasPrice, nonce: nonce++ }));
        if (feeUnits > 0n) sent.push(await this.#signSend(node, rpc, m.id, { to: m.token, data: ERC20.encodeFunctionData('transfer', [this.treasury, feeUnits]), gasLimit: TOKEN_GAS, gasPrice, nonce: nonce++ }));
      } else {
        toReceiver = total - feeUnits - txs * NATIVE_GAS * gasPrice; if (toReceiver <= 0n) throw new Error('amount too small after fees');
        sent.push(await this.#signSend(node, rpc, m.id, { to: d.payout_address, value: toReceiver, gasLimit: NATIVE_GAS, gasPrice, nonce: nonce++ }));
        if (feeUnits > 0n) sent.push(await this.#signSend(node, rpc, m.id, { to: this.treasury, value: feeUnits, gasLimit: NATIVE_GAS, gasPrice, nonce: nonce++ }));
      }
      setState('broadcast', { txid: sent[0], extra: JSON.stringify(sent.slice(1)), amount: fmt(toReceiver, m.decimals) });
      audit(this.db, { category: 'provider', actor: 'evm-wallet', action: 'payout.broadcast', dealId: d.id, detail: { txids: sent, to: d.payout_address } });
    } catch (e) {
      this.db.prepare("UPDATE xwallet SET payout_state=?, payout_error=? WHERE family='evm' AND deal_id=?").run(prev, String(e.message ?? e).slice(0, 300), d.id);
      audit(this.db, { category: 'provider', actor: 'evm-wallet', action: 'payout.failed', dealId: d.id, detail: { error: String(e.message ?? e).slice(0, 300) } });
      log.error('evm payout failed (will retry)', { deal: d.id, err: String(e.message ?? e) });
    }
  }

  /** Owner-only refund: send everything at a deal's address to `to` (no fee). Tokens need a gas top-up first; run it again once that lands. */
  async sweep(dealId, to) {
    const d = this.db.prepare("SELECT d.*, w.idx AS widx, w.payout_state FROM deals d JOIN xwallet w ON w.deal_id=d.id AND w.family='evm' WHERE d.id=?").get(dealId);
    if (!d) throw new Error('No EVM wallet entry for that deal.');
    if (d.payout_state === 'broadcast') throw new Error('This deal was already paid out.');
    this.validateAddress(to);
    const m = this.#meta(d); const rpc = this.rpcFor(m.chain); const node = this.#node(0, d.widx);
    if (node.address !== d.pay_address) throw new Error('derived address mismatch — refusing to sign');
    const gasPrice = ((await rpc.gasPrice()) * 12n) / 10n; const total = await this.#bal(rpc, m, d.pay_address, 'latest');
    if (total <= 0n) throw new Error('no funds at the deal address');
    const claim = this.db.prepare("UPDATE xwallet SET payout_state='sweeping' WHERE family='evm' AND deal_id=? AND payout_state IS NULL").run(dealId);
    if (!claim.changes) throw new Error('A payout or refund is already in progress for this deal.');
    try {
      let hash;
      if (m.token) {
        const need = TOKEN_GAS * gasPrice; const have = await rpc.balance(d.pay_address, 'latest');
        if (have < need) { await this.#topUp(d, m, rpc, need + gasPrice * 5000n, have, gasPrice); throw new Error(`A ${m.native} gas top-up was sent to the deal address. Run the refund again in about a minute.`); }
        hash = await this.#signSend(node, rpc, m.id, { to: m.token, data: ERC20.encodeFunctionData('transfer', [to, total]), gasLimit: TOKEN_GAS, gasPrice, nonce: await rpc.nonce(d.pay_address) });
      } else {
        const value = total - NATIVE_GAS * gasPrice; if (value <= 0n) throw new Error('amount too small after fees');
        hash = await this.#signSend(node, rpc, m.id, { to, value, gasLimit: NATIVE_GAS, gasPrice, nonce: await rpc.nonce(d.pay_address) });
      }
      this.db.prepare("UPDATE xwallet SET payout_state='swept', payout_txid=? WHERE family='evm' AND deal_id=?").run(hash, dealId);
      return hash;
    } catch (e) { this.db.prepare("UPDATE xwallet SET payout_state=NULL WHERE family='evm' AND deal_id=? AND payout_state='sweeping'").run(dealId); throw e; }
  }

  start(emit, everyMs = 20000) {
    const tick = () => this.scan(emit).catch((e) => log.error(`evm scan error: ${e?.message ?? e}`));
    this.timer = setInterval(tick, everyMs); this.timer.unref?.(); tick();
  }
}
