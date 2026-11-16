import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailDraftStore, serializeMailDraft } from '../src/mail-draft-store.js';

const draft = { to: ['client@example.test'], cc: [], subject: 'Alternativas', message: 'Mensaje inicial',
  relatedDocumentIds: ['quote-two'], idempotencyKey: '11111111-1111-4111-8111-111111111111' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function clock() {
  const timers = new Map(); let next = 0;
  return { setTimer(fn) { const id = ++next; timers.set(id, fn); return id; }, clearTimer(id) { timers.delete(id); },
    fire() { const tasks = [...timers.values()]; timers.clear(); tasks.forEach(fn => fn()); }, count: () => timers.size };
}

test('serialization preserves incomplete message fields and official PDF references without attachment bytes or private metadata', () => {
  const value = serializeMailDraft({ ...draft, to: 'unfinished@', cc: ['copy@example.test', 'other@example.test'],
    attachments: [{ name: 'private.pdf', bytes: new Uint8Array([1, 2]) }], password: 'never-persist', companySnapshot: { private: true } });
  assert.deepEqual(value, { ...draft, to: 'unfinished@', cc: 'copy@example.test, other@example.test' });
  assert.deepEqual(Object.keys(value).sort(), ['cc', 'idempotencyKey', 'message', 'relatedDocumentIds', 'subject', 'to']);
  value.relatedDocumentIds.push('third'); assert.deepEqual(draft.relatedDocumentIds, ['quote-two']);
  assert.throws(() => serializeMailDraft({ ...draft, relatedDocumentIds: 'not-an-array' }), error => error.code === 'INVALID_DRAFT');
  assert.throws(() => serializeMailDraft({ ...draft, to: [{}] }), error => error.code === 'INVALID_DRAFT');
});

test('initial values remain local until explicitly saved; a confirmed unchanged draft does not write again', async () => {
  const timer = clock(), saved = [], states = [];
  const store = createMailDraftStore({ ...timer, initialDraft: draft, save: async (value, version) => { saved.push({ value, version }); return { version: version + 1, updatedAt: 'now' }; }, onState: state => states.push(state) });
  assert.equal(store.getState().status, 'dirty'); assert.equal(timer.count(), 0); assert.equal(saved.length, 0);
  await store.saveNow(); assert.equal(saved.length, 1); assert.equal(saved[0].version, 0);
  assert.equal(store.getState().status, 'saved'); assert.equal(store.getState().version, 1); assert.equal(store.getState().updatedAt, 'now');
  await store.saveNow(); assert.equal(saved.length, 1);
  const value = store.getState(); value.draft.message = 'external mutation'; assert.equal(store.getState().draft.message, draft.message);
  assert.ok(states.some(state => state.status === 'saving')); assert.equal(states.at(-1).status, 'saved'); store.dispose();
});

test('debounce coalesces typing, and manual save cancels the pending timer', async () => {
  const timer = clock(), saved = [];
  const store = createMailDraftStore({ ...timer, initialDraft: draft, version: 4, save: async (value, version) => { saved.push({ value, version }); return { version: version + 1 }; } });
  store.set({ ...draft, message: 'First edit' }); store.set({ ...draft, message: 'Latest edit', relatedDocumentIds: [] });
  assert.equal(timer.count(), 1); assert.equal(saved.length, 0); timer.fire(); await tick();
  assert.equal(saved.length, 1); assert.equal(saved[0].value.message, 'Latest edit'); assert.deepEqual(saved[0].value.relatedDocumentIds, []); assert.equal(saved[0].version, 4);
  store.set({ ...draft, message: 'Manual edit' }); assert.equal(timer.count(), 1); await store.saveNow(); assert.equal(timer.count(), 0); timer.fire(); await tick();
  assert.equal(saved.length, 2); assert.equal(saved[1].version, 5); store.dispose();
});

test('edits made during a save are serialized with the new CAS version and saveNow waits for the latest edit', async () => {
  const timer = clock(), one = deferred(), two = deferred(), writes = [];
  const store = createMailDraftStore({ ...timer, initialDraft: draft, save: (value, version) => { writes.push({ value, version }); return writes.length === 1 ? one.promise : two.promise; } });
  const saving = store.saveNow(); await tick();
  store.set({ ...draft, message: 'Intermediate' }); store.set({ ...draft, message: 'Last edit', relatedDocumentIds: ['quote-three', 'quote-two'] });
  assert.equal(writes.length, 1); assert.equal(timer.count(), 0); const waiting = store.saveNow(); assert.equal(saving, waiting);
  one.resolve({ version: 1 }); await tick();
  assert.equal(writes.length, 2); assert.equal(writes[1].version, 1); assert.equal(writes[1].value.message, 'Last edit');
  assert.equal(store.getState().status, 'saving'); two.resolve({ version: 2 }); const state = await waiting;
  assert.equal(state.version, 2); assert.equal(state.status, 'saved'); assert.equal(state.dirty, false); store.dispose();
});

test('failed saves retain the local draft and do not retry until a new edit or explicit save', async () => {
  const timer = clock(); let calls = 0;
  const store = createMailDraftStore({ ...timer, initialDraft: draft, save: async (_value, version) => { if (++calls === 1) throw Error('offline'); return { version: version + 1 }; } });
  await assert.rejects(store.saveNow(), /offline/); assert.equal(store.getState().status, 'error'); assert.equal(store.getState().dirty, true); assert.equal(timer.count(), 0);
  assert.equal(store.getState().draft.message, draft.message); timer.fire(); await tick(); assert.equal(calls, 1);
  await store.saveNow(); assert.equal(calls, 2); assert.equal(store.getState().status, 'saved'); store.dispose();
});

test('CAS conflicts remain blocked after edits and explicit retries without overwriting another session', async () => {
  const timer = clock(), conflict = Object.assign(Error('changed elsewhere'), { code: 'DRAFT_CONFLICT' }); let calls = 0;
  const store = createMailDraftStore({ ...timer, initialDraft: draft, version: 8, save: async () => { ++calls; throw conflict; } });
  store.set({ ...draft, message: 'Unsaved local text' }); await assert.rejects(store.saveNow(), error => error === conflict);
  store.set({ ...draft, message: 'Still preserve this text' }); timer.fire(); await tick();
  await assert.rejects(store.saveNow(), error => error === conflict); assert.equal(calls, 1); assert.equal(timer.count(), 0);
  assert.equal(store.getState().status, 'conflict'); assert.equal(store.getState().version, 8); assert.equal(store.getState().draft.message, 'Still preserve this text'); store.dispose();
});

test('changed accounts never launch queued writes or receive old save state', async () => {
  const timer = clock(), pending = deferred(), states = [], writes = []; let current = true;
  const store = createMailDraftStore({ ...timer, initialDraft: draft, isCurrent: () => current,
    onState: state => states.push(state), save: (value, version) => { writes.push({ value, version }); return pending.promise; } });
  const saving = store.saveNow(); await tick(); store.set({ ...draft, message: 'Queued text' }); const before = states.length; current = false;
  pending.resolve({ version: 1 }); await assert.rejects(saving, error => error.code === 'AUTH_CHANGED');
  assert.equal(writes.length, 1); assert.equal(states.length, before); assert.equal(timer.count(), 0);
  await assert.rejects(store.saveNow(), error => error.code === 'AUTH_CHANGED'); assert.throws(() => store.set(draft), error => error.code === 'AUTH_CHANGED'); store.dispose();
});

test('disposing cancels debounced writes while an already submitted save is allowed to finish silently', async () => {
  const timer = clock(); let calls = 0;
  const closed = createMailDraftStore({ ...timer, initialDraft: draft, version: 1, save: async () => { ++calls; return { version: 2 }; } });
  closed.set({ ...draft, message: 'Typing' }); closed.dispose(); timer.fire(); await tick(); assert.equal(calls, 0);
  const pending = deferred(), states = [], active = createMailDraftStore({ ...timer, initialDraft: draft, onState: state => states.push(state), save: async () => { ++calls; return pending.promise; } });
  const saving = active.saveNow(); await tick(); active.set({ ...draft, message: 'Later text' }); active.dispose(); const before = states.length;
  pending.resolve({ version: 1 }); await assert.rejects(saving, error => error.code === 'DRAFT_DISPOSED'); assert.equal(calls, 1); assert.equal(states.length, before);
});

test('an invalid server acknowledgement never marks a draft saved or advances its version', async () => {
  const store = createMailDraftStore({ initialDraft: draft, save: async () => ({ version: 9 }) });
  await assert.rejects(store.saveNow(), error => error.code === 'DRAFT_RESPONSE_INVALID'); assert.equal(store.getState().version, 0); assert.equal(store.getState().dirty, true); assert.equal(store.getState().status, 'error'); store.dispose();
});
