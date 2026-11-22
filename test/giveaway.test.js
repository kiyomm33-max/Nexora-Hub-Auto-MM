import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import * as G from '../src/core/giveaways.js';

test('duration and details parsing', () => {
  assert.equal(G.parseDuration('1d'), 86400e3); assert.equal(G.parseDuration('2h30m'), 9000e3);
  assert.throws(() => G.parseDuration('10s'), /at least/); assert.throws(() => G.parseDuration('99d'), /at most/); assert.throws(() => G.parseDuration('soon'), /Duration/);
});
test('entries, random end, staff-picked end, reroll, end once', () => {
  const db = openDb(':memory:'); const g = G.create(db, { channelId: 'c', hostId: 'h', prize: 'p', req: null, endsAt: 1000 });
  assert.equal(G.enter(db, g.id, 'a'), true); assert.equal(G.enter(db, g.id, 'a'), false); G.enter(db, g.id, 'b'); assert.equal(G.entryCount(db, g.id), 2);
  assert.equal(G.due(db, 999).length, 0); assert.equal(G.due(db, 1000).length, 1);
  const e = G.end(db, g.id); assert.ok(['a', 'b'].includes(e.winner_id)); assert.equal(e.picked_by, null);
  assert.throws(() => G.end(db, g.id), /already ended/);
  const r = G.reroll(db, g.id); assert.notEqual(r.winner_id, e.winner_id);
  const g4 = G.create(db, { channelId: 'c', hostId: 'h', prize: 'p', req: null, endsAt: 1 }); G.enter(db, g4.id, 'solo'); G.end(db, g4.id);
  assert.throws(() => G.reroll(db, g4.id), /nobody else/); assert.throws(() => G.reroll(db, g.id + 100), /No giveaway/);
  const g3 = G.create(db, { channelId: 'c', hostId: 'h', prize: 'p', req: null, endsAt: 1 }); assert.equal(G.end(db, g3.id).winner_id, null);
});
test('new invites are counted above the baseline taken at the start', () => {
  const db = openDb(':memory:'); const g = G.create(db, { channelId: 'c', hostId: 'h', prize: 'p', req: { kind: 'invites', n: 1 }, endsAt: 1 });
  G.setBaseline(db, g.id, { a: 5 });
  assert.equal(G.newInvites(db, g.id, 'a', 5), 0); assert.equal(G.newInvites(db, g.id, 'a', 6), 1);
  assert.equal(G.newInvites(db, g.id, 'b', 2), 2); assert.equal(G.newInvites(db, g.id, 'a', 3), 0);
});
test('winner draws are uniform over entrants (no staff pick exists)', () => {
  const db = openDb(':memory:'); const g = G.create(db, { channelId: 'c', hostId: 'h', prize: 'p', req: null, endsAt: 1 });
  for (const u of ['a', 'b', 'c', 'd']) G.enter(db, g.id, u);
  const seen = new Set(); for (let k = 0; k < 200; k++) seen.add(G.randomEntrant(db, g.id));
  assert.equal(seen.size, 4); assert.equal(G.end.length, 2);
});
