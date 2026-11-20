import test from 'node:test';
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import { openDb } from '../src/db/index.js';
import { DealService } from '../src/core/deals.js';
import { loadConfig, LIVE_ACK } from '../src/config.js';
import { LtcWallet, NETWORKS } from '../src/providers/ltc.js';

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A = '111111111111111111', B = '222222222222222222';
import { ECPairFactory } from 'ecpair'; import * as ecc from 'tiny-secp256k1';
const RECV = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPairFactory(ecc).makeRandom().publicKey), network: NETWORKS.testnet.net }).address;

function setup({ utxos = [], tip = 1000 } = {}) {
  const state = { utxos, tip, broadcasts: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url); const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => (typeof b === 'string' ? b : JSON.stringify(b)) });
    if (u.endsWith('/blocks/tip/height')) return ok(state.tip);
    if (u.includes('/utxo')) return ok(state.utxos);
    if (u.endsWith('/v1/fees/recommended')) return ok({ halfHourFee: 3 });
    if (u.endsWith('/tx') && opts.method === 'POST') { state.broadcasts.push(opts.body); return ok('f'.repeat(64)); }
    if (u.includes('coinbase')) return ok({ data: { amount: '50.00' } });
    throw new Error(`unmocked ${u}`);
  };
  const cfg = loadConfig({ NEXORA_MODE: 'live', LIVE_MODE_ACK: LIVE_ACK, LTC_NETWORK: 'testnet', DATA_DIR: '/tmp/nx-ltc-test' });
  const db = openDb(':memory:'); const svc = new DealService(db, { mode: 'live' });
  const w = new LtcWallet(cfg, db, { fetchImpl, mnemonic: { mnemonic: MN, source: 'env' } });
  const events = []; const emit = (ev) => { events.push(ev); return svc.applyProviderEvent(ev); };
  return { state, cfg, db, svc, w, events, emit };
}
async function newDeal(ctx, { send = '27.00', receive = '25.00' } = {}) {
  const d = ctx.svc.create({ creator: A, partner: B, robloxA: 'Alice_1', robloxB: 'Bob22', item: 'Dominus', amount: '25.00', currency: 'USD', asset: 'LTC', network: 'litecoin' });
  ctx.svc.confirm(d.id, B);
  ctx.db.prepare('UPDATE deals SET send_usd=?, receive_usd=?, sender_id=?, receiver_id=? WHERE id=?').run(send, receive, A, B, d.id);
  const esc = await ctx.w.createEscrow({ id: d.id, send_usd: send });
  ctx.svc.activate(d.id, { provider: ctx.w.name, reference: esc.reference, channelId: '5', address: esc.address, payAmount: esc.payAmount, rateUsd: esc.rateUsd });
  return { id: d.id, esc };
}

test('deposit addresses are deterministic, unique per deal, on the right network', async () => {
  const c = setup(); const a = await newDeal(c); const b = await newDeal(c);
  assert.match(a.esc.address, /^tltc1q/); assert.notEqual(a.esc.address, b.esc.address);
  assert.equal(c.w.treasury.startsWith('tltc1q'), true);
  const c2 = setup(); assert.equal((await newDeal(c2)).esc.address, a.esc.address, 'same seed -> same first address');
  assert.equal(a.esc.rateUsd, '50.00'); assert.equal(a.esc.payAmount, (27 / 50).toFixed(8));
});
test('deal size cap and bad addresses are rejected', async () => {
  const c = setup();
  await assert.rejects(() => c.w.createEscrow({ id: 'NXH-TOOBIG01', send_usd: '5000' }), /limited to \$100/);
  assert.throws(() => c.w.validateAddress('not-an-address'), /valid Litecoin/);
  assert.throws(() => c.w.validateAddress('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9x'), /valid Litecoin/, 'mainnet address on testnet');
  assert.equal(c.w.validateAddress(RECV), RECV);
});
test('scan: unconfirmed = observed only; confirmed but underpaid never funds; enough confirmations funds', async () => {
  const c = setup(); const { id, esc } = await newDeal(c); const sat = Math.round(Number(esc.payAmount) * 1e8);
  c.state.utxos = [{ txid: 'a'.repeat(64), vout: 0, value: sat, status: { confirmed: false } }];
  await c.w.scan(c.emit);
  let d = c.svc.get(id); assert.equal(d.status, 'verification_pending'); assert.equal(d.escrow_status, 'pending'); assert.equal(d.tx_hash, 'a'.repeat(64));
  c.state.utxos = [{ txid: 'a'.repeat(64), vout: 0, value: Math.floor(sat / 2), status: { confirmed: true, block_height: 990 } }];
  await c.w.scan(c.emit); assert.equal(c.svc.get(id).escrow_status, 'pending', 'underpaid is never "secured"');
  c.state.utxos = [{ txid: 'a'.repeat(64), vout: 0, value: sat, status: { confirmed: true, block_height: 1000 } }]; // 1 conf < 2
  await c.w.scan(c.emit); assert.equal(c.svc.get(id).escrow_status, 'pending');
  c.state.tip = 1001; await c.w.scan(c.emit); await c.w.scan(c.emit);
  d = c.svc.get(id); assert.equal(d.escrow_status, 'provider_confirmed'); assert.equal(c.events.filter((e) => e.type === 'escrow.funded').length, 1);
});
test('payout: waits for release + address, pays receiver and fee address once, never twice', async () => {
  const c = setup(); const { id, esc } = await newDeal(c); const sat = Math.round(Number(esc.payAmount) * 1e8);
  c.state.tip = 1005; c.state.utxos = [{ txid: 'b'.repeat(64), vout: 1, value: sat, status: { confirmed: true, block_height: 1000 } }];
  await c.w.scan(c.emit); assert.equal(c.svc.get(id).escrow_status, 'provider_confirmed');
  await c.w.scan(c.emit); assert.equal(c.state.broadcasts.length, 0, 'no payout before release');
  c.db.prepare("UPDATE deals SET released_at=?, payout_address=? WHERE id=?").run(new Date().toISOString(), RECV, id);
  await c.w.scan(c.emit); await c.w.scan(c.emit); await c.w.scan(c.emit);
  assert.equal(c.state.broadcasts.length, 1, 'exactly one payout transaction');
  const tx = bitcoin.Transaction.fromHex(c.state.broadcasts[0]);
  const outs = tx.outs.map((o) => ({ addr: bitcoin.address.fromOutputScript(o.script, NETWORKS.testnet.net), value: o.value }));
  assert.equal(outs.length, 2); assert.equal(outs[0].addr, RECV); assert.equal(outs[1].addr, c.w.treasury);
  const feeSat = Math.round((2 / 50) * 1e8); assert.equal(outs[1].value, feeSat, '$2 fee at the locked rate');
  const minerFee = sat - outs[0].value - outs[1].value; assert.ok(minerFee > 0 && minerFee < 20000, `miner fee sane (${minerFee})`);
  assert.equal(c.svc.get(id).status, 'completed');
  assert.equal(c.db.prepare('SELECT payout_state FROM ltc_wallet WHERE deal_id=?').get(id).payout_state, 'broadcast');
});
test('a failed broadcast is retried, and a crash mid-send never double pays', async () => {
  const c = setup(); const { id, esc } = await newDeal(c); const sat = Math.round(Number(esc.payAmount) * 1e8);
  c.state.tip = 1005; c.state.utxos = [{ txid: 'c'.repeat(64), vout: 0, value: sat, status: { confirmed: true, block_height: 1000 } }];
  await c.w.scan(c.emit);
  c.db.prepare("UPDATE deals SET released_at=?, payout_address=? WHERE id=?").run(new Date().toISOString(), RECV, id);
  const real = c.w.fetch; c.w.fetch = async (u, o) => (o?.method === 'POST' ? { ok: false, status: 400, text: async () => 'min relay fee not met' } : real(u, o));
  await c.w.scan(c.emit); assert.equal(c.svc.get(id).status, 'verification_pending'); assert.equal(c.db.prepare('SELECT payout_state FROM ltc_wallet WHERE deal_id=?').get(id).payout_state, null);
  c.w.fetch = real; await c.w.scan(c.emit); assert.equal(c.svc.get(id).status, 'completed');
  const c2 = setup(); const d2 = await newDeal(c2); c2.db.prepare("UPDATE ltc_wallet SET payout_state='sending' WHERE deal_id=?").run(d2.id);
  assert.equal(c2.db.prepare("UPDATE ltc_wallet SET payout_state='sending' WHERE deal_id=? AND payout_state IS NULL").run(d2.id).changes, 0, 'claim is exclusive');
});
test('owner refund sweeps the deal address once; paid-out deals cannot be swept', async () => {
  const c = setup(); const { id, esc } = await newDeal(c); const sat = Math.round(Number(esc.payAmount) * 1e8);
  c.state.utxos = [{ txid: 'd'.repeat(64), vout: 0, value: sat, status: { confirmed: true, block_height: 1000 } }];
  const txid = await c.w.sweep(id, RECV); assert.equal(txid, 'f'.repeat(64));
  const tx = bitcoin.Transaction.fromHex(c.state.broadcasts[0]); assert.equal(tx.outs.length, 1);
  await assert.rejects(() => c.w.sweep(id, RECV), /already/);
});
test('mainnet: falls back to Blockbook when the primary chain API is down, including broadcast', async () => {
  const sent = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url); const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => String(b) });
    if (u.includes('litecoinspace.org')) return { ok: false, status: 525, json: async () => ({}), text: async () => 'ssl' };
    if (u.endsWith('/api/v2')) return ok({ blockbook: { bestHeight: 2000 } });
    if (u.includes('/utxo/')) return ok([{ txid: 'e'.repeat(64), vout: 0, value: '100000', confirmations: 3 }]);
    if (u.includes('/estimatefee/')) return ok({ result: '0.00000986' });
    if (u.includes('/sendtx/')) { sent.push(u.split('/sendtx/')[1]); return ok({ result: 'a'.repeat(64) }); }
    if (u.includes('coinbase')) return ok({ data: { amount: '50.00' } });
    throw new Error(`unmocked ${u}`);
  };
  const cfg = loadConfig({ NEXORA_MODE: 'live', LIVE_MODE_ACK: LIVE_ACK, LTC_NETWORK: 'mainnet', LTC_TREASURY_ADDRESS: 'LQmitT8afJrMAiRV8XGm1EtCP5TpiKuLnU', LTC_MAX_DEAL_USD: '3' });
  const db = openDb(':memory:'); const svc = new DealService(db, { mode: 'live' });
  const w = new LtcWallet(cfg, db, { fetchImpl, mnemonic: { mnemonic: MN, source: 'env' } });
  assert.equal(w.treasury, 'LQmitT8afJrMAiRV8XGm1EtCP5TpiKuLnU');
  const c = { db, svc, w, emit: (e) => svc.applyProviderEvent(e) };
  const d = await newDeal(c, { send: '2.00', receive: '2.00' }); assert.match(d.esc.address, /^ltc1q/);
  await assert.rejects(() => c.w.createEscrow({ id: 'NXH-BIG00001', send_usd: '10' }), /limited to \$3/);
  const RECV_MAIN = 'ltc1q6rz28mcfaxtmd6v789l9rrlrusdprr9pesrjxk'.replace(/^ltc1q6rz.*/, c.w.treasury);
  await c.w.scan(c.emit); const row = svc.get(d.id); assert.equal(row.confirmations, 3);
  assert.equal(svc.get(d.id).tx_hash, 'e'.repeat(64));
  assert.equal(await c.w.sweep(d.id, RECV_MAIN), 'a'.repeat(64)); assert.equal(sent.length, 1);
  const tx = bitcoin.Transaction.fromHex(sent[0]); assert.equal(tx.outs.length, 1);
  assert.equal(bitcoin.address.fromOutputScript(tx.outs[0].script, NETWORKS.mainnet.net), RECV_MAIN);
});

test('mainnet: falls back to BlockCypher when Esplora and Blockbook are both down', async () => {
  const sent = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url); const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => String(b) });
    if (u.includes('litecoinspace.org')) return { ok: false, status: 525, json: async () => ({}), text: async () => 'ssl' };
    if (u.includes('litecoinblockexplorer.net')) return { ok: false, status: 502, json: async () => ({}), text: async () => 'bad gateway' };
    if (u.endsWith('/v1/ltc/main')) return ok({ height: 2000 });
    if (u.includes('/addrs/')) return ok({ txrefs: [{ tx_hash: 'd'.repeat(64), tx_output_n: 0, value: 100000, confirmations: 3, block_height: 1998, double_spend: false }] });
    if (u.endsWith('/txs/push')) { sent.push(JSON.parse(opts.body).tx); return ok({ tx: { hash: 'b'.repeat(64) } }); }
    if (u.includes('coinbase')) return ok({ data: { amount: '50.00' } });
    throw new Error(`unmocked ${u}`);
  };
  const cfg = loadConfig({ NEXORA_MODE: 'live', LIVE_MODE_ACK: LIVE_ACK, LTC_NETWORK: 'mainnet', LTC_TREASURY_ADDRESS: 'LQmitT8afJrMAiRV8XGm1EtCP5TpiKuLnU', LTC_MAX_DEAL_USD: '3' });
  const db = openDb(':memory:'); const svc = new DealService(db, { mode: 'live' });
  const w = new LtcWallet(cfg, db, { fetchImpl, mnemonic: { mnemonic: MN, source: 'env' } });
  const c = { db, svc, w, emit: (e) => svc.applyProviderEvent(e) };
  const d = await newDeal(c, { send: '2.00', receive: '2.00' });
  await w.scan(c.emit);
  assert.equal(svc.get(d.id).confirmations, 3); assert.equal(svc.get(d.id).tx_hash, 'd'.repeat(64));
  assert.equal(await w.sweep(d.id, w.treasury), 'b'.repeat(64)); assert.equal(sent.length, 1);
});
