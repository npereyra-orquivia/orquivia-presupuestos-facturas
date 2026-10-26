import test from 'node:test';
import assert from 'node:assert/strict';
import { publicConfigIsValid, prepareRestore, sessionShouldLock, validatePasswordChange } from '../src/security.js';

const TODAY = '2026-10-14';
const url = 'https://abcdefghijklmnopqrst.supabase.co';
const publicKey = 'sb_publishable_example-KEY_123';
const jwt = (role = 'anon', header = { alg: 'HS256', typ: 'JWT' }) =>
  `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.c2lnbmF0dXJl`;
const validState = () => ({
  company: { name: 'Orquivia', vat: 21, withholding: 0, paymentTerms: 30 },
  clients: [{ id: 'client-1', name: 'Cliente' }],
  documents: [{ id: 'doc-1', kind: 'invoice', status: 'issued', number: '2026-002', clientId: 'client-1',
    date: '2026-09-15', dueDate: null, items: [{ description: 'Servicio', quantity: 1, price: 100 }],
    vat: 21, withholding: 0, discount: 0, po: '45008412', paymentReviewNeeded: true,
    sourceMetadata: { originalFile: '2026-002_VR.pdf', page: 1, notes: ['Fecha de pago sin confirmar'] },
    originalNumber: '2026-002', importWarnings: ['Confirmar cobro'], clientSnapshot: { name: 'Cliente original' } }],
  payments: [],
});

test('public configuration accepts both public key formats on a Supabase project URL', () => {
  assert.equal(publicConfigIsValid({ url, anonKey: publicKey }), true);
  assert.equal(publicConfigIsValid({ url: `${url}/`, anonKey: jwt() }), true);
});

test('public configuration rejects privileged, malformed or untyped keys', () => {
  for (const anonKey of ['sb_secret_example', jwt('service_role'), jwt('authenticated'), jwt(null),
    jwt('anon', { alg: 'none' }), 'sb_publishable_', 'not-a-key', jwt().replace(/\..*?\./, '.bad.'),
    ` ${publicKey}`, `${publicKey}\n`, 'sb_publishable_ab\u0000cd', 'sb_publishable_a b', 123, null]) {
    assert.equal(publicConfigIsValid({ url, anonKey }), false, String(anonKey));
  }
  assert.equal(publicConfigIsValid(null), false);
});

test('public configuration rejects URL credentials, paths, query, fragments and alternate hosts', () => {
  for (const unsafeURL of ['http://abcdefghijklmnopqrst.supabase.co', `${url}:443`, `${url}:8443`,
    'https://user:password@abcdefghijklmnopqrst.supabase.co', `${url}/rest/v1`, `${url}?project=x`,
    `${url}#x`, `${url}.evil.test`, 'https://supabase.co', 'https://127.0.0.1', `${url}\n`,
    'https://another.project.supabase.co', 'https://project.supabase.co@evil.test']) {
    assert.equal(publicConfigIsValid({ url: unsafeURL, anonKey: publicKey }), false, unsafeURL);
  }
});

test('restore accepts raw, text and wrapped backups and preserves evidence without shared references', () => {
  const original = validState();
  for (const input of [original, JSON.stringify(original), { version: 2, exportedAt: TODAY, state: original }]) {
    const restored = prepareRestore(input, { today: TODAY });
    assert.deepEqual(restored, original);
    assert.notEqual(restored, original);
    assert.notEqual(restored.documents[0].sourceMetadata, original.documents[0].sourceMetadata);
    restored.documents[0].sourceMetadata.notes.push('Nueva nota');
    assert.equal(original.documents[0].sourceMetadata.notes.length, 1);
  }
});

test('restore rejects prototype pollution recursively, including wrapper metadata', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const state = validState();
    state.documents[0].sourceMetadata = JSON.parse(`{"nested":{"${key}":{"polluted":true}}}`);
    assert.throws(() => prepareRestore(state, { today: TODAY }), /propiedad no permitida/);
    const wrapped = { state: validState(), metadata: JSON.parse(`{"${key}":true}`) };
    assert.throws(() => prepareRestore(JSON.stringify(wrapped), { today: TODAY }), /propiedad no permitida/);
  }
  assert.equal({}.polluted, undefined);
});

test('restore rejects non-JSON values, custom prototypes, cycles and accessor properties without running them', () => {
  for (const value of [undefined, Infinity, NaN, 1n, () => {}, Symbol('x'), new Date(), new Map()]) {
    const state = validState();
    state.company.extra = value;
    assert.throws(() => prepareRestore(state, { today: TODAY }), /datos JSON/);
  }
  const cyclic = validState(); cyclic.company.extra = cyclic;
  assert.throws(() => prepareRestore(cyclic, { today: TODAY }), /circular/);
  const accessor = validState(); let called = false;
  Object.defineProperty(accessor.company, 'extra', { enumerable: true, get() { called = true; return 'x'; } });
  assert.throws(() => prepareRestore(accessor, { today: TODAY }), /datos JSON/);
  assert.equal(called, false);
  const custom = validState(); custom.company = Object.assign(Object.create({ inherited: true }), custom.company);
  assert.throws(() => prepareRestore(custom, { today: TODAY }), /datos JSON/);
});

test('restore rejects array holes, attached properties, symbols and hidden properties instead of silently dropping them', () => {
  const sparse = validState(); sparse.company.extra = [1, , 3];
  assert.throws(() => prepareRestore(sparse, { today: TODAY }), /listas/);
  const extra = validState(); extra.company.extra = ['x']; extra.company.extra.note = 'lost';
  assert.throws(() => prepareRestore(extra, { today: TODAY }), /listas/);
  const symbol = validState(); symbol.company[Symbol('hidden')] = 'value';
  assert.throws(() => prepareRestore(symbol, { today: TODAY }), /propiedad no permitida/);
  const hidden = validState(); Object.defineProperty(hidden.company, 'hidden', { value: 'value' });
  assert.throws(() => prepareRestore(hidden, { today: TODAY }), /datos JSON/);
});

test('restore enforces UTF-8 size, a fixed size ceiling and nesting limits', () => {
  const minimal = validState(), exactBytes = Buffer.byteLength(JSON.stringify(minimal), 'utf8');
  assert.deepEqual(prepareRestore(minimal, { today: TODAY, maxBytes: exactBytes }), minimal);
  assert.throws(() => prepareRestore(minimal, { today: TODAY, maxBytes: exactBytes - 1 }), /tamaño/);
  assert.throws(() => prepareRestore(validState(), { today: TODAY, maxBytes: 50 }), /tamaño/);
  assert.throws(() => prepareRestore(' '.repeat(5 * 1024 * 1024 + 1), { today: TODAY }), /tamaño/);
  const state = validState(); state.company.extra = 'ñ'.repeat(500);
  assert.throws(() => prepareRestore(state, { today: TODAY, maxBytes: 1200 }), /tamaño/);
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, 5 * 1024 * 1024 + 1]) {
    assert.throws(() => prepareRestore(validState(), { today: TODAY, maxBytes }), /límite/);
  }
  let deep = 'value'; for (let i = 0; i < 45; i++) deep = { nested: deep };
  const nested = validState(); nested.company.extra = deep;
  assert.throws(() => prepareRestore(nested, { today: TODAY }), /niveles/);
});

test('restore rejects invalid relationships, future payments and duplicate annual numbers before replacing data', () => {
  const missing = validState(); missing.documents[0].clientId = 'missing';
  assert.throws(() => prepareRestore(missing, { today: TODAY }), /cliente no existe/);
  const future = validState(); future.payments.push({ id: 'payment-1', documentId: 'doc-1', amount: 10, date: '2026-10-15' });
  assert.throws(() => prepareRestore(future, { today: TODAY }), /futuro/);
  const duplicate = validState(); duplicate.documents.push({ ...duplicate.documents[0], id: 'doc-2', number: 'F-2026-002' });
  assert.throws(() => prepareRestore(duplicate, { today: TODAY }), /secuencia anual/);
  assert.throws(() => prepareRestore('not JSON', { today: TODAY }), /JSON válida/);
  assert.throws(() => prepareRestore(validState(), { today: '2026-02-30' }), /fecha/);
});

test('restore permits separate quote and invoice counters with the same original number', () => {
  const state = validState();
  state.documents.push({ ...state.documents[0], id: 'quote-1', kind: 'quote', status: 'accepted', paymentReviewNeeded: false });
  assert.equal(prepareRestore(state, { today: TODAY }).documents.length, 2);
});

test('idle session expires at the boundary and cannot be extended past 30 minutes', () => {
  const start = 1_000_000, timeout = 30 * 60 * 1000;
  assert.equal(sessionShouldLock({ lastActivityAt: start, now: start + timeout - 1 }), false);
  assert.equal(sessionShouldLock({ lastActivityAt: start, now: start + timeout }), true);
  assert.equal(sessionShouldLock({ lastActivityAt: start, now: start + timeout, timeoutMs: timeout * 2 }), true);
  assert.equal(sessionShouldLock({ lastActivityAt: start, now: start + 1000, timeoutMs: 1000 }), true);
});

test('idle session fails closed for invalid and future timestamps', () => {
  for (const lastActivityAt of [undefined, null, '100', NaN, Infinity, -1, 1001]) {
    assert.equal(sessionShouldLock({ lastActivityAt, now: 1000 }), true);
  }
  assert.equal(sessionShouldLock({ lastActivityAt: 100, now: NaN }), true);
  assert.equal(sessionShouldLock({ lastActivityAt: 100, now: 100, timeoutMs: 0 }), true);
});

test('password validation requires an exact confirmation, a new value and the current password', () => {
  const valid = { currentPassword: 'old password', newPassword: 'new password 123', repeatPassword: 'new password 123' };
  assert.deepEqual(validatePasswordChange(valid), []);
  assert.match(validatePasswordChange({ ...valid, currentPassword: '' }).join(' '), /actual/);
  assert.match(validatePasswordChange({ ...valid, repeatPassword: 'new password 123 ' }).join(' '), /confirmación/);
  assert.match(validatePasswordChange({ ...valid, currentPassword: valid.newPassword }).join(' '), /distinta/);
  assert.match(validatePasswordChange({ ...valid, newPassword: 'short', repeatPassword: 'short' }).join(' '), /12 y 128/);
  assert.match(validatePasswordChange({ ...valid, newPassword: 'x'.repeat(129), repeatPassword: 'x'.repeat(129) }).join(' '), /12 y 128/);
});

test('password validation counts Unicode characters and preserves significant spaces and normalization', () => {
  const currentPassword = 'old';
  const unicode = '🔐'.repeat(12);
  assert.deepEqual(validatePasswordChange({ currentPassword, newPassword: unicode, repeatPassword: unicode }), []);
  const short = '🔐'.repeat(6);
  assert.match(validatePasswordChange({ currentPassword, newPassword: short, repeatPassword: short }).join(' '), /12 y 128/);
  const spaced = '  new password  ';
  assert.deepEqual(validatePasswordChange({ currentPassword, newPassword: spaced, repeatPassword: spaced }), []);
  const composed = 'é'.repeat(12), decomposed = 'e\u0301'.repeat(12);
  assert.match(validatePasswordChange({ currentPassword, newPassword: composed, repeatPassword: decomposed }).join(' '), /confirmación/);
});
