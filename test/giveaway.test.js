import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import * as G from '../src/core/giveaways.js';
import { helpLines, SPEC } from '../src/discord/prefix.js';

test('duration and details parsing', () => {
  assert.equal(G.parseDuration('1d'), 86400e3); assert.equal(G.parseDuration('2h30m'), 9000e3);
  assert.throws(() => G.parseDuration('10s'), /at least/); assert.throws(() => G.parseDuration('99d'), /at most/); assert.throws(() => G.parseDuration('soon'), /Duration/);
  assert.deepEqual(G.splitDetails('1 Nitro Giftlink 1 Invite'), { prize: '1 Nitro Giftlink', req: { kind: 'invites', n: 1 } });
  assert.deepEqual(G.splitDetails('Robux 100 messages'), { prize: 'Robux', req: { kind: 'messages', n: 100 } });
  assert.deepEqual(G.splitDetails('$5 PayPal | 3 invites'), { prize: '$5 PayPal', req: { kind: 'invites', n: 3 } });
  assert.deepEqual(G.splitDetails('1 Nitro Giftlink'), { prize: '1 Nitro Giftlink', req: null });
  assert.throws(() => G.splitDetails('Nitro | lots'), /requirement/);
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
  const g2 = G.create(db, { channelId: 'c', hostId: 'h', prize: 'p', req: null, endsAt: 1 });
  const e2 = G.end(db, g2.id, { winner: 'zed', pickedBy: 'staff1' }); assert.equal(e2.winner_id, 'zed'); assert.equal(e2.picked_by, 'staff1');
  const g3 = G.create(db, { channelId: 'c', hostId: 'h', prize: 'p', req: null, endsAt: 1 }); assert.equal(G.end(db, g3.id).winner_id, null);
});
test('giveaway commands are hidden from .help', () => {
  for (const all of [true, false]) assert.ok(!helpLines('.', { all }).join('\n').includes('giveaway'));
  assert.ok(SPEC.giveawaycreate && SPEC.giveawayend);
});
