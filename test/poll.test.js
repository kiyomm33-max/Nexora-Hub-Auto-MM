import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import * as P from '../src/core/polls.js';

test('poll: validation, one vote per member, change and remove, tally, end once', () => {
  const db = openDb(':memory:');
  assert.throws(() => P.create(db, { channelId: 'c', hostId: 'h', question: 'q', options: ['a'], endsAt: 1 }), /2 to 5/);
  assert.throws(() => P.create(db, { channelId: 'c', hostId: 'h', question: 'q', options: ['a', 'A'], endsAt: 1 }), /different/);
  const p = P.create(db, { channelId: 'c', hostId: 'h', question: 'q', options: ['a', 'b', 'c'], endsAt: 1000 });
  assert.equal(P.vote(db, p.id, 'u1', 0), 'added'); assert.equal(P.vote(db, p.id, 'u2', 0), 'added'); assert.equal(P.vote(db, p.id, 'u3', 2), 'added');
  assert.deepEqual(P.tally(db, p.id), [2, 0, 1]);
  assert.equal(P.vote(db, p.id, 'u1', 1), 'changed'); assert.deepEqual(P.tally(db, p.id), [1, 1, 1]);
  assert.equal(P.vote(db, p.id, 'u1', 1), 'removed'); assert.deepEqual(P.tally(db, p.id), [1, 0, 1]);
  assert.throws(() => P.vote(db, p.id, 'u1', 9), /Unknown/);
  assert.equal(P.due(db, 999).length, 0); assert.equal(P.due(db, 1000).length, 1);
  P.end(db, p.id); assert.throws(() => P.end(db, p.id), /already ended/); assert.throws(() => P.vote(db, p.id, 'u9', 0), /ended/);
});
