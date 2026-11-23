import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import * as I from '../src/core/invites.js';

test('invite credit: one per invited member, no self credit, leave and rejoin', () => {
  const db = openDb(':memory:');
  assert.equal(I.recordJoin(db, 'x', 'a', 'c1'), true); assert.equal(I.recordJoin(db, 'y', 'a', 'c1'), true); assert.equal(I.recordJoin(db, 'a', 'a', 'c1'), false);
  assert.deepEqual(I.stats(db, 'a'), { joined: 2, left: 0, here: 2 });
  I.recordLeave(db, 'x'); assert.deepEqual(I.stats(db, 'a'), { joined: 2, left: 1, here: 1 });
  assert.equal(I.recordJoin(db, 'x', 'b', 'c2'), false); // rejoining through someone else does not move or double the credit
  assert.deepEqual(I.stats(db, 'a'), { joined: 2, left: 0, here: 2 }); assert.deepEqual(I.stats(db, 'b'), { joined: 0, left: 0, here: 0 });
});
test('which invite was used', () => {
  const b = { a: { uses: 1, inviter: 'u1' }, b: { uses: 4, inviter: 'u2' } };
  assert.deepEqual(I.usedInvite(b, { a: { uses: 1, inviter: 'u1' }, b: { uses: 5, inviter: 'u2' } }), { code: 'b', inviter: 'u2' });
  assert.deepEqual(I.usedInvite(b, { a: { uses: 1, inviter: 'u1' } }), { code: 'b', inviter: 'u2' }); // single-use invite deleted
  assert.deepEqual(I.usedInvite(b, { ...b, n: { uses: 1, inviter: 'u3' } }), { code: 'n', inviter: 'u3' });
  assert.equal(I.usedInvite(b, b), null);
});
