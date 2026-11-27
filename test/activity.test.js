import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import * as act from '../src/core/activity.js';
import { memberState, syncMember, onMessage } from '../src/discord/activity.js';

const DAY = 86400e3;
test('message counts: per day, leaderboard by period, rank', () => {
  const db = openDb(':memory:'); const now = Date.parse('2026-11-22T12:00:00Z');
  const add = (u, n, daysAgo) => { for (let k = 0; k < n; k++) act.countMessage(db, u, now - daysAgo * DAY); };
  add('a', 5, 0); add('a', 10, 3); add('b', 8, 0); add('b', 40, 20); add('c', 1, 100);
  const lb = (p) => act.leaderboard(db, p, { at: now }).rows.map((r) => `${r.user_id}:${r.n}`).join(',');
  assert.equal(lb('today'), 'b:8,a:5'); assert.equal(lb('week'), 'a:15,b:8'); assert.equal(lb('month'), 'b:48,a:15'); assert.equal(lb('all'), 'b:48,a:15,c:1');
  assert.deepEqual(act.leaderboard(db, 'all', { at: now }), { rows: act.leaderboard(db, 'all', { at: now }).rows, total: 64, people: 3 });
  const m = act.userMessages(db, 'a', now); assert.deepEqual([m.today, m.week, m.month, m.all, m.rank], [5, 15, 15, 15, 2]);
  assert.equal(act.userRank(db, 'c', 'all', now), 3); assert.equal(act.userRank(db, 'zzz', 'all', now), null);
  assert.equal(act.leaderboard(db, 'all', { limit: 1, at: now }).rows.length, 1);
});
test('perk sessions: start once, end once, totals and longest', () => {
  const db = openDb(':memory:'); const t0 = Date.parse('2026-11-01T00:00:00Z');
  assert.equal(act.setPerk(db, 'u', 'tag', true, { at: t0 }), 'started'); assert.equal(act.setPerk(db, 'u', 'tag', true, { at: t0 + 1e3 }), null);
  assert.equal(act.setPerk(db, 'u', 'tag', false, { at: t0 + 2 * 3600e3 }), 'ended'); assert.equal(act.setPerk(db, 'u', 'tag', false), null);
  act.setPerk(db, 'u', 'tag', true, { at: t0 + 5 * 3600e3 });
  const s = act.perkSummary(db, 'u', 'tag', t0 + 6 * 3600e3);
  assert.equal(s.times, 2); assert.equal(s.totalMs, 3 * 3600e3); assert.equal(s.longestMs, 2 * 3600e3); assert.ok(s.active); assert.equal(s.first, new Date(t0).toISOString());
  assert.equal(act.perkSummary(db, 'u', 'status').times, 0, 'kinds are separate');
  act.setPerk(db, 'v', 'tag', true, { at: t0 + 5 * 3600e3 });
  const b = act.perkBoard(db, 'tag', { at: t0 + 6 * 3600e3 }); assert.deepEqual(b.rows.map((r) => r.user_id), ['u', 'v']); assert.equal(b.activeNow, 2); assert.equal(b.everyone, 2);
  assert.equal(act.duration(93784000), '1d 2h 3m'); assert.equal(act.duration(5000), '5s');
});
test('discord side: tag needs this server and enabled; status needs the phrase and a visible presence; bots and webhooks are not counted', () => {
  const cfg = { guildId: 'G', statusPhrase: 'gg/nexora' };
  const mem = (pg, presence, bot = false) => ({ user: { id: 'u1', bot, primaryGuild: pg }, presence });
  const on = { identityGuildId: 'G', identityEnabled: true };
  assert.equal(memberState(mem(on, null), cfg).tag, true);
  assert.equal(memberState(mem({ ...on, identityEnabled: false }, null), cfg).tag, false);
  assert.equal(memberState(mem({ ...on, identityGuildId: 'other' }, null), cfg).tag, false);
  assert.equal(memberState(mem(null, null), cfg).tag, false);
  const pres = (status, state) => ({ status, activities: [{ type: 4, state }] });
  assert.equal(memberState(mem(null, pres('online', '.gg/Nexora | best mm')), cfg).status, true);
  assert.equal(memberState(mem(null, pres('idle', 'discord.gg/nexora')), cfg).status, true);
  assert.equal(memberState(mem(null, pres('online', 'hello')), cfg).status, false);
  assert.equal(memberState(mem(null, { status: 'online', activities: [{ type: 0, name: '.gg/nexora' }] }), cfg).status, false, 'only the custom status counts');
  assert.equal(memberState(mem(null, pres('offline', '')), cfg).status, null, 'offline hides the status: unknown');
  assert.equal(memberState(mem(null, null), cfg).status, null);
  // syncing: an offline member does not end a status session
  const db = openDb(':memory:'); const ctx = { db, cfg };
  assert.deepEqual(syncMember(ctx, mem(on, pres('online', '.gg/nexora'))).map((x) => x[1]), ['started', 'started']);
  assert.deepEqual(syncMember(ctx, mem(on, pres('offline', ''))), [], 'offline changes nothing');
  assert.deepEqual(syncMember(ctx, mem(null, pres('online', 'bye'))).map((x) => `${x[0]}:${x[1]}`), ['tag:ended', 'status:ended']);
  assert.deepEqual(syncMember(ctx, mem(on, null, true)), [], 'bots are ignored');
  assert.ok(onMessage({ guild: {}, author: { id: '1' } }));
  assert.ok(!onMessage({ guild: {}, author: { id: '1', bot: true } })); assert.ok(!onMessage({ guild: {}, author: { id: '1' }, webhookId: 'w' })); assert.ok(!onMessage({ author: { id: '1' } })); assert.ok(!onMessage({ guild: {}, author: { id: '1' }, system: true }));
});
