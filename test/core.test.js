import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { DealService, DealError } from '../src/core/deals.js';
import { verifyAuditChain, dealHistory } from '../src/core/audit.js';
import { addVouch } from '../src/core/vouches.js';
import * as V from '../src/core/validate.js';
import { staffRole, can, LEVELS } from '../src/core/permissions.js';
import { sign, verify } from '../src/providers/signature.js';
import { RateLimiter } from '../src/core/ratelimit.js';
import { backupNow } from '../src/jobs/backup.js';
import { loadConfig, LIVE_ACK } from '../src/config.js';
import { selectProvider } from '../src/providers/index.js';

const A = '111111111111111111', B = '222222222222222222', S = '333333333333333333', X = '999999999999999999';
const pay = (db, id) => db.prepare("UPDATE deals SET payout_address='ltc1qtestaddress' WHERE id=?").run(id);
const mk = () => { const db = openDb(':memory:'); return { db, svc: new DealService(db, { mode: 'demo' }) }; };
const base = { creator: A, partner: B, robloxA: 'Alice_1', robloxB: 'Bob22', item: 'Dominus', amount: '25.00', currency: 'USD', asset: 'LTC', network: 'litecoin' };
let n = 0;
const ev = (type, reference, extra = {}) => ({ id: `e${++n}`, type, reference, ...extra });
function active(svc) {
  const d = svc.create(base); svc.confirm(d.id, B);
  svc.activate(d.id, { provider: 'Demo', reference: `DEMO-${d.id}`, channelId: '5' });
  return svc.get(d.id);
}

test('status: create -> both confirm -> awaiting provider', () => {
  const { svc } = mk(); const d = svc.create(base);
  assert.equal(d.status, 'waiting_parties'); assert.match(d.id, /^NXH-[0-9A-Z]{8}$/);
  assert.throws(() => svc.activate(d.id, { provider: 'D', reference: 'r', channelId: '1' }), DealError);
  assert.throws(() => svc.confirm(d.id, X), /Only the two parties/);
  const r = svc.confirm(d.id, B); assert.ok(r.both && r.changed);
  assert.equal(svc.confirm(d.id, B).changed, false); // duplicate click
  assert.equal(active(svc).status, 'awaiting_provider');
});
test('cannot deal with yourself', () => assert.throws(() => mk().svc.create({ ...base, partner: A }), /yourself/));

test('full happy path to completed, with observation vs escrow distinction', () => {
  const { svc, db } = mk(); const d = active(svc); const ref = d.provider_ref;
  assert.equal(svc.applyProviderEvent(ev('escrow.completed', ref), { simulated: true }).outcome, 'rejected_not_funded');
  assert.equal(svc.get(d.id).status, 'awaiting_provider');
  svc.applyProviderEvent(ev('funds.observed', ref, { confirmations: 1 }), { simulated: true });
  let c = svc.get(d.id);
  assert.equal(c.status, 'verification_pending'); assert.equal(c.observed_status, 'seen'); assert.equal(c.escrow_status, 'pending');
  assert.equal(svc.applyProviderEvent(ev('escrow.completed', ref), { simulated: true }).outcome, 'rejected_not_funded'); // chain obs != escrow
  svc.applyProviderEvent(ev('funds.confirmed_on_chain', ref, { confirmations: 6 }), { simulated: true });
  assert.equal(svc.get(d.id).escrow_status, 'pending');
  svc.applyProviderEvent(ev('escrow.funded', ref), { simulated: true });
  assert.equal(svc.get(d.id).escrow_status, 'provider_confirmed');
  assert.equal(svc.applyProviderEvent(ev('escrow.completed', ref), { simulated: true }).outcome, 'rejected_no_payout_address');
  pay(db, d.id);
  assert.equal(svc.applyProviderEvent(ev('escrow.completed', ref), { simulated: true }).outcome, 'applied');
  c = svc.get(d.id); assert.equal(c.status, 'completed'); assert.ok(c.completed_at);
  assert.equal(svc.applyProviderEvent(ev('escrow.completed', ref), { simulated: true }).outcome, 'duplicate_completion');
  assert.equal(svc.applyProviderEvent(ev('escrow.cancelled', ref), { simulated: true }).outcome, 'ignored_final');
  assert.equal(svc.get(d.id).status, 'completed');
  assert.ok(dealHistory(db, d.id).length >= 6);
  assert.ok(verifyAuditChain(db).ok);
});
test('webhook replay of same event id is a no-op', () => {
  const { svc } = mk(); const d = active(svc); const e = ev('funds.observed', d.provider_ref);
  assert.equal(svc.applyProviderEvent(e, { simulated: true }).outcome, 'applied');
  assert.equal(svc.applyProviderEvent(e, { simulated: true }).outcome, 'duplicate');
});
test('unknown reference, invalid event, demo/live mismatch', () => {
  const { svc } = mk(); const d = active(svc);
  assert.equal(svc.applyProviderEvent(ev('escrow.funded', 'nope'), { simulated: true }).outcome, 'unknown_reference');
  assert.equal(svc.applyProviderEvent({ id: 1 }).outcome, 'invalid');
  assert.equal(svc.applyProviderEvent(ev('escrow.funded', d.provider_ref), { simulated: false }).outcome, 'mode_mismatch');
  assert.equal(svc.get(d.id).escrow_status, 'pending');
});
test('dispute flow: only parties/staff; provider resolves; bot cannot release', () => {
  const { svc, db } = mk(); const d = active(svc);
  assert.throws(() => svc.dispute(d.id, X, 'x'), /participants/);
  svc.dispute(d.id, A, 'seller silent'); assert.equal(svc.get(d.id).status, 'disputed');
  assert.throws(() => svc.cancel(d.id, A, 'x'), /external provider/);
  svc.applyProviderEvent(ev('escrow.funded', d.provider_ref), { simulated: true }); pay(db, d.id);
  assert.equal(svc.applyProviderEvent(ev('escrow.completed', d.provider_ref), { simulated: true }).outcome, 'applied');
});
test('provider-originated dispute', () => {
  const { svc } = mk(); const d = active(svc);
  svc.applyProviderEvent(ev('escrow.disputed', d.provider_ref), { simulated: true });
  assert.equal(svc.get(d.id).status, 'disputed');
});
test('cancel: allowed before funds, blocked after observation; final state immutable', () => {
  const { svc, db } = mk();
  const w = svc.create(base); svc.cancel(w.id, B, 'changed mind');
  assert.equal(svc.get(w.id).status, 'cancelled');
  assert.throws(() => svc.confirm(w.id, B), /no longer waiting/);
  assert.throws(() => db.prepare("UPDATE deals SET status='waiting_parties' WHERE id=?").run(w.id), /final state/);
  const d = active(svc); svc.applyProviderEvent(ev('funds.observed', d.provider_ref), { simulated: true });
  assert.throws(() => svc.cancel(d.id, A, 'x'), /provider/);
  const e = active(svc); assert.throws(() => svc.cancel(e.id, X, 'x'), /Only participants/);
  assert.equal(svc.cancel(e.id, S, 'staff', { staff: true }).status, 'cancelled');
});
test('claim: single middleman, not a party', () => {
  const { svc } = mk(); const d = active(svc);
  assert.throws(() => svc.claim(d.id, A), /own deal/);
  svc.claim(d.id, S); assert.throws(() => svc.claim(d.id, '444444444444444444'), /Already claimed/);
});
test('vouch only for genuinely completed deals, once, by participants', () => {
  const { svc, db } = mk(); const d = active(svc);
  assert.throws(() => addVouch(db, { dealId: d.id, author: A, rating: 5, text: 'great trader' }), /completed/);
  pay(db, d.id);
  for (const t of ['escrow.funded', 'escrow.completed']) svc.applyProviderEvent(ev(t, d.provider_ref), { simulated: true });
  assert.throws(() => addVouch(db, { dealId: d.id, author: X, rating: 5, text: 'great trader' }), /participants/);
  const r = addVouch(db, { dealId: d.id, author: A, rating: 5, text: 'great trader' });
  assert.equal(r.target, B);
  assert.throws(() => addVouch(db, { dealId: d.id, author: A, rating: 4, text: 'again again' }), /already/);
  assert.throws(() => addVouch(db, { dealId: 'NXH-00000000', author: A, rating: 4, text: 'x' }), /No deal/);
  assert.throws(() => db.prepare('UPDATE vouches SET rating=1').run(), /immutable/);
});
test('audit log is append-only and tamper-evident', () => {
  const { svc, db } = mk(); active(svc);
  assert.throws(() => db.prepare('UPDATE audit_log SET actor=?').run('x'), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM deals').run(), /cannot be deleted/);
  db.exec('DROP TRIGGER audit_no_update'); db.prepare("UPDATE audit_log SET detail='{}' WHERE id=2").run(); // simulate a DB-level attacker
  const r = verifyAuditChain(db); assert.equal(r.ok, false); assert.equal(r.brokenAt, 2);
});
test('evidence is immutable and logged', () => {
  const { svc, db } = mk(); const d = active(svc);
  svc.addEvidence(d.id, A, 'screenshot of chat', 'https://example.com/a.png');
  assert.throws(() => db.prepare('DELETE FROM evidence').run(), /immutable/);
  assert.ok(dealHistory(db, d.id).some((h) => h.action === 'evidence.submitted'));
});
test('validation', () => {
  assert.equal(V.robloxName(' Alice_1 '), 'Alice_1');
  for (const bad of ['ab', '_abc', 'a b c', 'a__b', 'x'.repeat(21), '<script>']) assert.throws(() => V.robloxName(bad), V.ValidationError);
  assert.deepEqual(V.value('25.5 usd'), { amount: '25.5', currency: 'USD' });
  for (const bad of ['0 USD', '25', '25.123 USD', '10 XYZ', '-5 USD']) assert.throws(() => V.value(bad), V.ValidationError);
  assert.deepEqual(V.crypto('usdt trc20'), { asset: 'USDT', network: 'tron' });
  assert.deepEqual(V.crypto('LTC'), { asset: 'LTC', network: 'litecoin' });
  assert.throws(() => V.crypto('USDT'), /networks/); assert.throws(() => V.crypto('DOGE'), /Unsupported/);
  assert.throws(() => V.crypto('LTC tron'), V.ValidationError);
  assert.equal(V.text('hi @everyone <@123456789012345678>', { min: 1 }), 'hi @\u200beveryone [mention]');
  assert.throws(() => V.rating(6)); assert.equal(V.rating('4'), 4);
  assert.throws(() => V.evidenceUrl('http://x.com')); assert.throws(() => V.evidenceUrl('javascript:1'));
  assert.equal(V.evidenceUrl(''), null); assert.throws(() => V.dealId('bad'));
});
test('permissions hierarchy', () => {
  const roles = { owner: ['o'], admin: ['a'], senior: ['s'], middleman: ['m'], support: ['p'], trial: ['t'] };
  assert.equal(staffRole(['m', 'p'], roles), 'middleman'); assert.equal(staffRole(['x'], roles), null);
  assert.equal(staffRole([], roles, { isGuildOwner: true }), 'owner');
  assert.ok(can('admin', 'backup')); assert.ok(!can('senior', 'backup')); assert.ok(!can('trial', 'deal.claim'));
  assert.ok(!can(null, 'ticket.handle')); assert.ok(can('support', 'dispute.review')); assert.ok(!can('support', 'deal.claim'));
  assert.ok(can('trial', 'ticket.handle')); assert.ok(Object.keys(LEVELS).length === 6);
});
test('webhook signature', () => {
  const body = '{"a":1}'; const h = sign('sec', body);
  assert.ok(verify('sec', body, h).ok);
  assert.equal(verify('other', body, h).reason, 'mismatch'); assert.equal(verify('sec', body + ' ', h).reason, 'mismatch');
  assert.equal(verify('sec', body, sign('sec', body, 1000)).reason, 'stale');
  assert.equal(verify('sec', body, 'garbage').reason, 'malformed'); assert.equal(verify('sec', body, undefined).reason, 'missing');
  assert.equal(verify('', body, h).reason, 'missing');
});
test('rate limiter + duplicate lock', async () => {
  const r = new RateLimiter();
  assert.ok(r.check('k', 2, 1000, 0).ok); assert.ok(r.check('k', 2, 1000, 1).ok);
  assert.ok(!r.check('k', 2, 1000, 2).ok); assert.ok(r.check('k', 2, 1000, 1500).ok);
  let inner; const p = r.once('x', async () => { inner = await r.once('x', async () => 1); await new Promise((s) => setTimeout(s, 5)); return 2; });
  assert.equal((await p).value, 2); assert.equal(inner.duplicate, true);
});
test('backup creates a restorable snapshot and prunes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-')); const file = path.join(dir, 'live.sqlite');
  const db = openDb(file); const svc = new DealService(db, { mode: 'demo' }); const d = svc.create(base);
  const bdir = path.join(dir, 'b'); const f = backupNow(db, bdir, 2);
  assert.equal(openDb(f).prepare('SELECT id FROM deals').get().id, d.id);
  fs.writeFileSync(path.join(bdir, 'nexora-0001.sqlite'), ''); fs.writeFileSync(path.join(bdir, 'nexora-0002.sqlite'), '');
  backupNow(db, bdir, 2); assert.equal(fs.readdirSync(bdir).filter((x) => x.endsWith('.sqlite')).length, 2);
});
test('config: demo by default; live needs the self-custody acknowledgement; LTC defaults to testnet', () => {
  assert.equal(loadConfig({}).mode, 'demo');
  const c1 = loadConfig({ NEXORA_MODE: 'live' }); assert.equal(c1.mode, 'demo'); assert.ok(c1.warnings.length);
  const c3 = loadConfig({ NEXORA_MODE: 'live', LIVE_MODE_ACK: LIVE_ACK }); assert.equal(c3.mode, 'live');
  assert.equal(c3.ltc.network, 'testnet'); assert.equal(c3.ltc.maxDealUsd, 100);
  assert.equal(selectProvider(loadConfig({}), openDb(':memory:')).mode, 'demo');
});
test('slash command definitions and modals are valid discord.js payloads', async () => {
  const { definitions } = await import('../src/discord/commands.js');
  assert.deepEqual(definitions.map((d) => d.name).sort(), ['check', 'dealinfo', 'dispute', 'evidence', 'fees', 'giveaway', 'inviteboard', 'invites', 'leaderboard', 'messages', 'mydeals', 'panel', 'poll', 'role', 'rules', 'staff', 'stats', 'status', 'steal', 'supportpanel', 'tag', 'tags', 'ticket', 'totals', 'vouch', 'welcome']);
  const ui = await import('../src/discord/ui.js');
  for (const m of [ui.partnerIdModal('NXH-AAAAAAAA'), ui.descModal('NXH-AAAAAAAA'), ui.amountModal('NXH-AAAAAAAA'), ui.disputeModal(), ui.disputeModal('NXH-AAAAAAAA'), ui.evidenceModal('NXH-AAAAAAAA'), ui.ticketModal(), ui.vouchModal('NXH-AAAAAAAA')]) {
    const j = m.toJSON(); assert.ok(j.components.length >= 1 && j.components.length <= 5 && j.title.length <= 45);
  }
  const d = { id: 'NXH-AAAAAAAA', status: 'waiting_parties', mode: 'demo', party_a: A, party_b: B, roblox_a: 'a_b', roblox_b: 'bob', item: 'x', amount: '1', currency: 'USD', asset: 'LTC', network: 'litecoin', confirmed_a: 1, confirmed_b: 0, escrow_status: 'none', observed_status: 'none', confirmations: 0, created_at: new Date().toISOString() };
  for (const s of ['waiting_parties', 'awaiting_provider', 'verification_pending', 'disputed', 'completed', 'cancelled']) {
    const x = { ...d, status: s, completed_at: new Date().toISOString() };
    assert.ok(ui.dealEmbed({}, x).toJSON().fields.length); ui.roomButtons(x).forEach((r) => r.toJSON());
  }
  ui.ticketButtons('TCK-1').forEach((r) => r.toJSON());
});
test('fee maths', async () => {
  const { calcFee, calcTotals } = await import('../src/core/fees.js');
  assert.equal(calcFee(49.99), 0); assert.equal(calcFee(50), 0); assert.equal(calcFee(50.01), 2); assert.equal(calcFee(250), 2); assert.equal(calcFee(250.01), 5); assert.equal(calcFee(300), 6); assert.equal(calcFee(1234.56), 24.69);
  assert.deepEqual(calcTotals('100.00', '2', 'sender'), { fee: '2.00', send: '102.00', receive: '100.00' });
  assert.deepEqual(calcTotals('100.00', '2', 'receiver'), { fee: '2.00', send: '100.00', receive: '98.00' });
  assert.deepEqual(calcTotals('100.00', '2', 'split'), { fee: '2.00', send: '101.00', receive: '99.00' });
  assert.deepEqual(calcTotals('20.00', '0'), { fee: '0.00', send: '20.00', receive: '20.00' });
});
