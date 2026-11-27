import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import * as earn from '../src/core/earn.js';
import { qualifies } from '../src/discord/status.js';

const pay = { dailyCents: 20, weekBonusCents: 120, minPayoutCents: 20 };
const T0 = Date.parse('2026-11-01T00:00:00Z'); const H = 3600e3;

test('time accrues only while qualifying; days and week bonus', () => {
  const db = openDb(':memory:');
  assert.equal(earn.setQualifying(db, 'u', true, T0), null);
  earn.enroll(db, 'u', T0);
  assert.equal(earn.setQualifying(db, 'u', true, T0), 'started');
  assert.equal(earn.setQualifying(db, 'u', false, T0 + 30 * H), 'stopped');
  let s = earn.summary(db, 'u', pay, T0 + 100 * H);
  assert.equal(s.seconds, 30 * 3600); assert.equal(s.earned, 20); assert.equal(s.counting, false);
  earn.setQualifying(db, 'u', true, T0 + 100 * H);
  s = earn.summary(db, 'u', pay, T0 + 100 * H + 7 * 24 * H);
  assert.equal(s.days, 8); assert.equal(s.weeks, 1); assert.equal(s.earned, 8 * 20 + 120);
  assert.equal(earn.earnedCents(7 * 86400, pay), 260);
});
test('stale intervals end at the last heartbeat', () => {
  const db = openDb(':memory:'); earn.enroll(db, 'u', T0); earn.setQualifying(db, 'u', true, T0);
  earn.heartbeat(db, T0 + 5 * H); earn.closeStale(db);
  const s = earn.summary(db, 'u', pay, T0 + 50 * H);
  assert.equal(s.seconds, 5 * 3600); assert.equal(s.counting, false);
});
test('payout reserves the balance once; reject returns it; handled once', () => {
  const db = openDb(':memory:'); earn.enroll(db, 'u', T0); earn.setQualifying(db, 'u', true, T0); earn.setQualifying(db, 'u', false, T0 + 49 * H);
  const now = T0 + 50 * H;
  const r = earn.requestPayout(db, 'u', { method: 'paypal', details: 'a@b.co', pay, at: now });
  assert.equal(r.cents, 40);
  assert.throws(() => earn.requestPayout(db, 'u', { method: 'paypal', details: 'a@b.co', pay, at: now }), /at least/);
  assert.equal(earn.summary(db, 'u', pay, now).available, 0);
  earn.handlePayout(db, r.id, 'rejected', 's');
  assert.throws(() => earn.handlePayout(db, r.id, 'paid', 's'), /already handled/);
  assert.equal(earn.summary(db, 'u', pay, now).available, 40);
  const r2 = earn.requestPayout(db, 'u', { method: 'ltc', details: 'x', pay, at: now });
  earn.handlePayout(db, r2.id, 'paid', 's', { ref: 'tx1' });
  const s = earn.summary(db, 'u', pay, now); assert.equal(s.paid, 40); assert.equal(s.available, 0);
  assert.throws(() => earn.requestPayout(db, 'nobody', { method: 'paypal', details: 'x', pay }), /Start Earning/);
});
test('qualifies: online or dnd with the phrase in a custom status', () => {
  const cfg = { statusPhrase: 'gg/nexora', statusRoleId: 'R' };
  const m = (status, state, type = 4) => ({ roles: { cache: new Map([['R', 1]]) }, presence: { status, activities: [{ type, state }] } });
  assert.equal(qualifies(m('online', '.gg/Nexorra'), cfg), true);
  assert.equal(qualifies(m('dnd', 'join .gg/nexora now'), cfg), true);
  assert.equal(qualifies(m('idle', '.gg/nexora'), cfg), false);
  assert.equal(qualifies(m('offline', '.gg/nexora'), cfg), false);
  assert.equal(qualifies(m('online', 'hello'), cfg), false);
  assert.equal(qualifies(m('online', '.gg/nexora', 0), cfg), false);
  assert.equal(qualifies({}, cfg), false);
  assert.equal(qualifies({ ...m('online', '.gg/nexora'), roles: { cache: new Map() } }, cfg), false, 'no role, no earning');
});
