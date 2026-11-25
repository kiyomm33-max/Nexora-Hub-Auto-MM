import test from 'node:test';
import assert from 'node:assert/strict';
import { Transaction as EthTx, Interface, getAddress } from 'ethers';
import { Transaction as SolTx, SystemInstruction, PublicKey } from '@solana/web3.js';
import { openDb } from '../src/db/index.js';
import { DealService } from '../src/core/deals.js';
import { loadConfig, LIVE_ACK } from '../src/config.js';
import { EvmWallet } from '../src/providers/evm.js';
import { SolWallet, slip10 } from '../src/providers/sol.js';
import { MultiProvider } from '../src/providers/multi.js';
import { LtcWallet } from '../src/providers/ltc.js';

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A = '111111111111111111', B = '222222222222222222';
const RECV_EVM = getAddress('0x' + 'ab'.repeat(20)); const RECV_SOL = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const ERC20 = new Interface(['function transfer(address,uint256) returns (bool)']);
const cfgOf = () => loadConfig({ NEXORA_MODE: 'live', LIVE_MODE_ACK: LIVE_ACK, LTC_NETWORK: 'mainnet', MAX_DEAL_USD: '50', DATA_DIR: '/tmp/nx-multi-test' });
const price = (usd) => async (u) => ({ ok: true, status: 200, json: async () => ({ data: { amount: String(usd) } }) });

function evmRpc() {
  const s = { tip: 1000, bal: new Map(), tok: new Map(), old: new Set(), gasPrice: 10n ** 9n, sent: [], mined: new Set(), autoMine: false, nonces: new Map() };
  const get = (m, k) => m.get(k) ?? 0n;
  const rpc = {
    blockNumber: async () => s.tip,
    balance: async (a, tag) => (tag !== 'latest' && s.old.has(a) ? 0n : get(s.bal, a)),
    tokenBalance: async (t, a, tag) => (tag !== 'latest' && s.old.has(a) ? 0n : get(s.tok, a)),
    gasPrice: async () => s.gasPrice, code: async () => '0x', findTransfer: async () => null,
    nonce: async (a) => s.nonces.get(a) ?? 0,
    broadcast: async (hex) => {
      const tx = EthTx.from(hex); const gas = tx.gasLimit * tx.gasPrice; const from = tx.from;
      s.nonces.set(from, tx.nonce + 1); s.bal.set(from, get(s.bal, from) - gas);
      if (tx.data === '0x') { s.bal.set(from, get(s.bal, from) - tx.value); s.bal.set(tx.to, get(s.bal, tx.to) + tx.value); }
      else { const [to, amt] = ERC20.decodeFunctionData('transfer', tx.data); s.tok.set(from, get(s.tok, from) - amt); s.tok.set(to, get(s.tok, to) + amt); }
      s.sent.push({ from, to: tx.to, value: tx.value, data: tx.data, nonce: tx.nonce, hash: tx.hash }); if (s.autoMine) s.mined.add(tx.hash); return tx.hash;
    },
    status: async (h) => (s.mined.has(h) ? { mined: true, success: true } : { mined: false }),
  };
  return { s, rpc };
}
function setup(asset, network, { send = '27.00', receive = '25.00', ethPrice = 2000 } = {}) {
  const cfg = cfgOf(); const db = openDb(':memory:'); const svc = new DealService(db, { mode: 'live' });
  const { s, rpc } = evmRpc();
  const w = new EvmWallet(cfg, db, { mnemonic: { mnemonic: MN, source: 'env' }, rpcFor: () => rpc, fetchImpl: price(ethPrice) });
  const emit = (ev) => svc.applyProviderEvent(ev);
  const d = svc.create({ creator: A, partner: B, robloxA: 'Alice_1', robloxB: 'Bob22', item: 'Dominus', amount: '25.00', currency: 'USD', asset, network });
  svc.confirm(d.id, B);
  db.prepare('UPDATE deals SET send_usd=?, receive_usd=?, sender_id=?, receiver_id=? WHERE id=?').run(send, receive, A, B, d.id);
  return { cfg, db, svc, w, s, emit, id: d.id, deal: { id: d.id, asset, network, send_usd: send } };
}
const activate = async (c) => { const esc = await c.w.createEscrow(c.deal); c.svc.activate(c.id, { provider: c.w.name, reference: esc.reference, channelId: '5', address: esc.address, payAmount: esc.payAmount, rateUsd: esc.rateUsd }); return esc; };
const release = (c, addr) => c.db.prepare('UPDATE deals SET released_at=?, payout_address=? WHERE id=?').run(new Date().toISOString(), addr, c.id);

test('ETH: unique deal address, waits for confirmations, pays receiver and fee address once, completes only after the chain confirms', async () => {
  const c = setup('ETH', 'ethereum'); const esc = await activate(c);
  assert.match(esc.address, /^0x[0-9a-fA-F]{40}$/); assert.equal(esc.rateUsd, '2000.00'); assert.equal(esc.payAmount, '0.01350000');
  const expected = 13500000000000000n; assert.equal(BigInt(c.db.prepare("SELECT expected FROM xwallet WHERE deal_id=?").get(c.id).expected), expected);
  c.s.bal.set(esc.address, expected); c.s.old.add(esc.address);
  await c.w.scan(c.emit); assert.notEqual(c.svc.get(c.id).escrow_status, 'provider_confirmed', 'immature funds never fund');
  c.s.old.clear(); await c.w.scan(c.emit); assert.equal(c.svc.get(c.id).escrow_status, 'provider_confirmed');
  await c.w.scan(c.emit); assert.equal(c.s.sent.length, 0, 'no payout before release');
  release(c, RECV_EVM); await c.w.scan(c.emit); await c.w.scan(c.emit);
  assert.equal(c.s.sent.length, 2, 'receiver tx + fee tx, once'); assert.equal(c.s.sent[0].to, RECV_EVM); assert.equal(c.s.sent[1].to, c.w.treasury);
  assert.equal(c.s.sent[1].value, 1000000000000000n, '$2 fee at the locked rate'); assert.equal(c.s.sent[0].nonce + 1, c.s.sent[1].nonce);
  assert.equal(c.svc.get(c.id).status, 'verification_pending', 'not complete until the transactions are mined');
  c.s.sent.forEach((t) => c.s.mined.add(t.hash)); await c.w.scan(c.emit);
  assert.equal(c.svc.get(c.id).status, 'completed'); const info = c.w.payoutInfo(c.id); assert.equal(info.txid, c.s.sent[0].hash); assert.match(info.url, /etherscan\.io\/tx\/0x/); assert.ok(Number(info.amount) > 0.0124 && Number(info.amount) < 0.0125);
  await c.w.scan(c.emit); assert.equal(c.s.sent.length, 2, 'never paid twice');
});

test('ETH: underpayment never funds, and bad or contract payout addresses are refused', async () => {
  const c = setup('ETH', 'ethereum'); const esc = await activate(c);
  c.s.bal.set(esc.address, 13000000000000000n); await c.w.scan(c.emit); await c.w.scan(c.emit);
  assert.notEqual(c.svc.get(c.id).escrow_status, 'provider_confirmed');
  assert.throws(() => c.w.validateAddress('0x123'), /valid EVM address/); assert.throws(() => c.w.validateAddress(RECV_EVM.replace(/[a-f]/i, (m) => (m === m.toUpperCase() ? m.toLowerCase() : m.toUpperCase()))), /valid EVM address/);
  assert.equal(c.w.validateAddress(RECV_EVM.toLowerCase()), RECV_EVM);
});

test('USDT on BSC: the gas wallet tops up the deal address, then receiver and fee address are paid in tokens', async () => {
  const c = setup('USDT', 'bsc'); const esc = await activate(c); assert.equal(esc.payAmount, '27.00');
  const units = 27n * 10n ** 18n; c.s.tok.set(esc.address, units); c.s.autoMine = true;
  await c.w.scan(c.emit); assert.equal(c.svc.get(c.id).escrow_status, 'provider_confirmed');
  release(c, RECV_EVM);
  await c.w.scan(c.emit); assert.equal(c.s.sent.length, 0, 'no gas wallet funds: nothing sent, error kept for retry');
  assert.match(c.db.prepare('SELECT payout_error FROM xwallet WHERE deal_id=?').get(c.id).payout_error, /gas wallet is out of BNB/);
  c.s.bal.set(c.w.gasAddress, 10n ** 18n);
  await c.w.scan(c.emit); assert.equal(c.s.sent.length, 1, 'gas top-up'); assert.equal(c.s.sent[0].from, c.w.gasAddress); assert.equal(c.s.sent[0].to, esc.address);
  await c.w.scan(c.emit);
  assert.equal(c.s.sent.length, 3, 'top-up + 2 token transfers'); const [t1, t2] = c.s.sent.slice(1);
  assert.equal(t1.to, '0x55d398326f99059fF775485246999027B3197955'); const [r1, a1] = ERC20.decodeFunctionData('transfer', t1.data); const [r2, a2] = ERC20.decodeFunctionData('transfer', t2.data);
  assert.equal(r1, RECV_EVM); assert.equal(a1, 25n * 10n ** 18n); assert.equal(r2, c.w.treasury); assert.equal(a2, 2n * 10n ** 18n);
  await c.w.scan(c.emit); assert.equal(c.svc.get(c.id).status, 'completed'); assert.equal(c.w.payoutInfo(c.id).amount, '25'); assert.match(c.w.payoutInfo(c.id).url, /bscscan\.com/);
  await c.w.scan(c.emit); assert.equal(c.s.sent.length, 3, 'never paid twice');
});

test('USDC on Ethereum uses 6 decimals; owner refund sweeps tokens once', async () => {
  const c = setup('USDC', 'ethereum', { send: '10.00', receive: '10.00' }); const esc = await activate(c);
  assert.equal(BigInt(c.db.prepare('SELECT expected FROM xwallet WHERE deal_id=?').get(c.id).expected), 10000000n);
  c.s.tok.set(esc.address, 10000000n); c.s.bal.set(c.w.gasAddress, 10n ** 18n); c.s.autoMine = true;
  await assert.rejects(() => c.w.sweep(c.id, RECV_EVM), /gas top-up was sent/);
  const hash = await c.w.sweep(c.id, RECV_EVM); assert.match(hash, /^0x/);
  const last = c.s.sent.at(-1); const [to, amt] = ERC20.decodeFunctionData('transfer', last.data); assert.equal(to, RECV_EVM); assert.equal(amt, 10000000n);
  await assert.rejects(() => c.w.sweep(c.id, RECV_EVM), /no funds|already/);
});

function solRpc() {
  const s = { bal: new Map(), fin: new Map(), sent: [], confirmed: new Set(), height: 10 };
  return { s, rpc: {
    balance: async (a, commit) => (commit === 'finalized' ? (s.fin.get(a) ?? 0n) : (s.bal.get(a) ?? 0n)),
    latestSig: async () => 'depositsig', blockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 }), blockHeight: async () => s.height,
    send: async (raw) => { const tx = SolTx.from(raw); const sig = `sig${s.sent.length}`; s.sent.push({ sig, outs: tx.instructions.map((i) => { const t = SystemInstruction.decodeTransfer(i); return { to: t.toPubkey.toBase58(), lamports: t.lamports, from: t.fromPubkey.toBase58() }; }) }); return sig; },
    status: async (sig) => (s.confirmed.has(sig) ? { confirmed: true, err: false } : null),
  } };
}
test('SOL: deal address, finalized funding, one transaction pays receiver and fee address, completes after confirmation', async () => {
  const cfg = cfgOf(); const db = openDb(':memory:'); const svc = new DealService(db, { mode: 'live' }); const { s, rpc } = solRpc();
  const w = new SolWallet(cfg, db, { mnemonic: { mnemonic: MN, source: 'env' }, rpc, fetchImpl: price(100) });
  const emit = (ev) => svc.applyProviderEvent(ev);
  const d = svc.create({ creator: A, partner: B, robloxA: 'Alice_1', robloxB: 'Bob22', item: 'Dominus', amount: '25.00', currency: 'USD', asset: 'SOL', network: 'solana' });
  svc.confirm(d.id, B); db.prepare('UPDATE deals SET send_usd=?, receive_usd=?, sender_id=?, receiver_id=? WHERE id=?').run('27.00', '25.00', A, B, d.id);
  const esc = await w.createEscrow({ id: d.id, send_usd: '27.00' }); svc.activate(d.id, { provider: w.name, reference: esc.reference, channelId: '5', address: esc.address, payAmount: esc.payAmount, rateUsd: esc.rateUsd });
  assert.equal(esc.payAmount, '0.270000'); assert.equal(new PublicKey(esc.address).toBase58(), esc.address);
  s.bal.set(esc.address, 270000000n); await w.scan(emit); assert.notEqual(svc.get(d.id).escrow_status, 'provider_confirmed', 'confirmed but not finalized yet');
  s.fin.set(esc.address, 270000000n); await w.scan(emit); assert.equal(svc.get(d.id).escrow_status, 'provider_confirmed');
  db.prepare('UPDATE deals SET released_at=?, payout_address=? WHERE id=?').run(new Date().toISOString(), RECV_SOL, d.id);
  await w.scan(emit); await w.scan(emit); assert.equal(s.sent.length, 1, 'one transaction');
  const [o1, o2] = s.sent[0].outs; assert.equal(o1.to, RECV_SOL); assert.equal(o2.to, w.treasury); assert.equal(o2.lamports, 20000000n); assert.equal(o1.lamports, 270000000n - 20000000n - 5000n);
  s.confirmed.add('sig0'); await w.scan(emit); assert.equal(svc.get(d.id).status, 'completed'); assert.match(w.payoutInfo(d.id).url, /solscan\.io\/tx\/sig0/);
  assert.throws(() => w.validateAddress('nope'), /valid Solana/);
});
test('SOL: derivation is deterministic and a dropped transaction is retried only after the blockhash expires', async () => {
  assert.equal(slip10(Buffer.alloc(64, 1), [44, 501, 0, 0]).toString('hex'), slip10(Buffer.alloc(64, 1), [44, 501, 0, 0]).toString('hex'));
  assert.notEqual(slip10(Buffer.alloc(64, 1), [44, 501, 0, 0]).toString('hex'), slip10(Buffer.alloc(64, 1), [44, 501, 1, 0]).toString('hex'));
  const cfg = cfgOf(); const db = openDb(':memory:'); const svc = new DealService(db, { mode: 'live' }); const { s, rpc } = solRpc();
  const w = new SolWallet(cfg, db, { mnemonic: { mnemonic: MN, source: 'env' }, rpc, fetchImpl: price(100) }); const emit = (ev) => svc.applyProviderEvent(ev);
  const d = svc.create({ creator: A, partner: B, robloxA: 'Alice_1', robloxB: 'Bob22', item: 'Dominus', amount: '25.00', currency: 'USD', asset: 'SOL', network: 'solana' });
  svc.confirm(d.id, B); db.prepare('UPDATE deals SET send_usd=?, receive_usd=?, sender_id=?, receiver_id=? WHERE id=?').run('25.00', '25.00', A, B, d.id);
  const esc = await w.createEscrow({ id: d.id, send_usd: '25.00' }); svc.activate(d.id, { provider: w.name, reference: esc.reference, channelId: '5', address: esc.address, payAmount: esc.payAmount, rateUsd: esc.rateUsd });
  s.bal.set(esc.address, 250000000n); s.fin.set(esc.address, 250000000n); await w.scan(emit);
  db.prepare('UPDATE deals SET released_at=?, payout_address=? WHERE id=?').run(new Date().toISOString(), RECV_SOL, d.id);
  await w.scan(emit); assert.equal(s.sent.length, 1); await w.scan(emit); assert.equal(s.sent.length, 1, 'still waiting, not resent'); s.height = 50; await w.scan(emit); assert.equal(s.sent.length, 1);
  s.height = 200; await w.scan(emit); await w.scan(emit); assert.equal(s.sent.length, 2, 'resent after expiry');
});

test('MultiProvider routes by coin, and describe() lists the addresses the owner must know', async () => {
  const cfg = cfgOf(); const db = openDb(':memory:'); const m = { mnemonic: MN, source: 'env' };
  const ltc = new LtcWallet(cfg, db, { mnemonic: m }); const evm = new EvmWallet(cfg, db, { mnemonic: m, rpcFor: () => evmRpc().rpc }); const sol = new SolWallet(cfg, db, { mnemonic: m, rpc: solRpc().rpc });
  const p = new MultiProvider(cfg, db, { ltc, evm, sol });
  assert.ok(p.supports('LTC', 'litecoin') && p.supports('USDT', 'bsc') && p.supports('USDC', 'ethereum') && p.supports('SOL', 'solana') && !p.supports('BTC', 'bitcoin'));
  assert.equal(p.validateAddress(RECV_EVM, { asset: 'USDT', network: 'bsc' }), RECV_EVM); assert.equal(p.validateAddress(RECV_SOL, { asset: 'SOL', network: 'solana' }), RECV_SOL);
  assert.throws(() => p.validateAddress(RECV_EVM, { asset: 'SOL', network: 'solana' }), /Solana/); assert.throws(() => p.validateAddress(RECV_SOL, { asset: 'ETH', network: 'ethereum' }), /EVM/);
  assert.equal(p.describe().length, 5); assert.equal(p.describe()[2].value, ltc.rewardsAddress()); assert.equal(p.describe()[3].value, evm.gasAddress); assert.notEqual(ltc.rewardsAddress(), ltc.treasury);
  assert.equal(evm.validateAddress(evm.gasAddress), evm.gasAddress); assert.notEqual(evm.gasAddress, evm.treasury);
});
