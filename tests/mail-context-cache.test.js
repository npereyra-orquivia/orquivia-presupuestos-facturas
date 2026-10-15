import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailContextCache, mergeMailJob } from '../src/mail-context-cache.js';

test('mail context coalesces in-flight opens, reuses a fresh result and explicitly refreshes it', async () => {
  let time = 1000, calls = 0, release;
  const first = new Promise(resolve => { release = resolve; });
  const cache = createMailContextCache({ getIdentity: () => 'nicole', now: () => time, load: async id => { ++calls; return calls === 1 ? first : { id, calls }; } });
  const one = cache.get('quote'), two = cache.get('quote', { force: true });
  await Promise.resolve(); assert.equal(calls, 1);
  release({ profile: { connected: true }, history: [] });
  assert.deepEqual(await one, await two);
  await cache.get('quote'); assert.equal(calls, 1);
  await cache.get('quote', { force: true }); assert.equal(calls, 2);
  time += 30_000; await cache.get('quote'); assert.equal(calls, 3);
  await cache.get('other-quote'); assert.equal(calls, 4);
});

test('late data from a changed account or reset never enters a new mail context', async () => {
  for (const reset of [false, true]) {
    let owner = 'nicole', release;
    const response = new Promise(resolve => { release = resolve; });
    const cache = createMailContextCache({ getIdentity: () => owner, load: () => response });
    const old = cache.get('quote'); await Promise.resolve();
    if (reset) cache.clear(); else owner = 'liliana';
    cache.remember('quote', { owner: reset ? 'new-session' : owner });
    release({ owner: 'old-session' });
    await assert.rejects(old, error => error.code === 'AUTH_CHANGED');
    assert.deepEqual(await cache.get('quote'), { owner: reset ? 'new-session' : owner });
  }
});

test('failed refreshes invalidate old data and a completed send updates its history without another read', async () => {
  let calls = 0, fail = false;
  const cache = createMailContextCache({ getIdentity: () => 'nicole', load: async () => { ++calls; if (fail) throw Error('access revoked'); return { history: [] }; } });
  await cache.get('quote'); fail = true;
  await assert.rejects(cache.get('quote', { force: true }), /access revoked/);
  await assert.rejects(cache.get('quote'), /access revoked/); assert.equal(calls, 3);
  const history = mergeMailJob([{ id: 'same', status: 'sending' }, { id: 'older', status: 'sent' }], { id: 'same', status: 'sent' });
  cache.remember('quote', { history });
  assert.deepEqual((await cache.get('quote')).history, [{ id: 'same', status: 'sent' }, { id: 'older', status: 'sent' }]);
  assert.equal(calls, 3);
});
