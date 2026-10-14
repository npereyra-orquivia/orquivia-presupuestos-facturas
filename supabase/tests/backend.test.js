import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, validateCloudState } from '../../src/backend.js';
import { reminderLines } from '../functions/_shared/reminders.js';
import { build } from 'esbuild';
import { historicalImportDecision, stateDigest } from '../scripts/bootstrap-team.mjs';

const empty = () => ({ company: { name: 'Orquívia' }, clients: [], documents: [], payments: [] });
const token = (role = 'anon', extra = {}) => [
  { alg: 'HS256', typ: 'JWT' }, { role, exp: Math.floor(Date.now() / 1000) + 3600, ...extra },
].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).concat('test-signature').join('.');

test('cloud validation snapshots records and rejects invalid/orphaned financial data', () => {
  const original = empty();
  original.clients.push({ id: 'c1', name: 'Cliente' });
  original.documents.push({ id: 'd1', kind: 'invoice', status: 'issued', number: 'F-2025-001', clientId: 'c1', date: '2025-01-10', dueDate: '2025-02-10', items: [{ description: 'Servicio', quantity: 1, price: 100 }], vat: 21, discount: 0, withholding: 0, total: 121 });
  original.payments.push({ id: 'p1', documentId: 'd1', amount: 50, date: '2025-01-20' });
  const snapshot = validateCloudState(original);
  original.company.name = 'Changed';
  assert.equal(snapshot.company.name, 'Orquívia');
  assert.throws(() => validateCloudState({ ...empty(), company: new Date() }), { code: 'INVALID_STATE' });
  assert.throws(() => validateCloudState({ ...empty(), company: { emailNotifications: 'false' } }), { code: 'INVALID_STATE' });
  assert.throws(() => validateCloudState({ ...empty(), clients: [{ id: 'c1' }, { id: 'c1' }] }), { code: 'INVALID_STATE' });
  assert.throws(() => validateCloudState({ ...empty(), payments: [{ id: 'p1', documentId: 'missing', amount: 50 }] }), { code: 'INVALID_STATE' });
  const invalid = structuredClone(snapshot);
  invalid.documents[0].items[0].price = Infinity;
  assert.throws(() => validateCloudState(invalid), { code: 'INVALID_STATE' });
});

test('email reminder rules match portal cents, snapshots, date validity and document statuses', () => {
  const state = empty();
  state.clients = [{ id: 'c1', name: 'Edited current name' }];
  const document = {
    id: 'd1', kind: 'invoice', number: 'F-2026-001', clientId: 'c1',
    clientSnapshot: { name: 'Original billed name' }, status: 'issued',
    dueDate: '2026-10-13', contractExpectedDate: '2026-10-12', contractReceived: false,
    items: [{ description: 'Decimal rounding', quantity: 1, price: 1.005 }],
    discount: 0, vat: 21, withholding: 0, total: 99999, // Ignore forged/stale cached totals.
  };
  state.documents = [document];
  state.payments = [{ id: 'p1', documentId: 'd1', amount: 0.50 }];
  const lines = reminderLines(state, '2026-10-13');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Original billed name/);
  assert.match(lines[0], /contrato pendiente/); // Portal ordering puts the older date first.
  assert.match(lines[1], /0,72/);
  assert.ok(lines.every((line) => !line.includes('99999') && !line.includes('Edited current name')));
  state.payments[0].amount = 1.22;
  assert.equal(reminderLines(state, '2026-10-13').length, 1); // Paid invoices may still need a contract.
  document.contractReceived = true;
  assert.deepEqual(reminderLines(state, '2026-10-13'), []);
  state.payments = [];
  document.dueDate = '2026-02-30';
  assert.deepEqual(reminderLines(state, '2026-10-13'), []);
  document.dueDate = '2026-10-13';
  document.status = 'sent'; // An invalid invoice status behaves as a draft in the portal.
  assert.deepEqual(reminderLines(state, '2026-10-13'), []);
  document.kind = 'quote';
  document.status = 'rejected';
  document.contractReceived = false;
  assert.deepEqual(reminderLines(state, '2026-10-13'), []);
  document.status = 'accepted';
  assert.equal(reminderLines(state, '2026-10-13').length, 1); // Quotes produce contract alerts only.
});

test('scheduled handler authenticates its caller, requires opt-in and reuses an immutable daily message', async () => {
  const originalFetch = globalThis.fetch;
  const originalDeno = globalThis.Deno;
  const OriginalDate = globalThis.Date;
  const env = {
    ORQUIVIA_CRON_SECRET: 'fictional-32-byte-test-cron-secret',
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fictional-service-key',
    RESEND_API_KEY: 'fictional-resend-key', ORQUIVIA_FROM_EMAIL: 'Orquívia <owner@example.test>',
  };
  const state = empty();
  state.company = { name: 'Orquívia', emailNotifications: true, notificationEmail: 'owner@example.test' };
  state.documents = [{ id: 'd1', number: 'F-2026-001', kind: 'invoice', status: 'issued', dueDate: '2026-10-12', items: [{ quantity: 1, price: 100 }], vat: 21 }];
  const storedPayload = { from: env.ORQUIVIA_FROM_EMAIL, to: ['owner@example.test'], subject: 'Original subject', text: 'Original immutable body' };
  let delivered = false;
  let sendCount = 0;
  let claimCount = 0;
  const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : ['2026-10-13T10:00:00Z'])); }
    static now() { return new OriginalDate('2026-10-13T10:00:00Z').valueOf(); }
  };
  globalThis.Deno = { env: { get: (name) => env[name] } };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/rest/v1/orquivia_team_workspaces')) return json([{ organization_id: 'b1000000-0000-4000-8000-000000000001', state }]);
    if (url.includes('/rest/v1/rpc/claim_orquivia_team_reminder')) {
      claimCount++;
      const request = JSON.parse(init.body);
      assert.equal(request.p_date, '2026-10-13');
      assert.match(request.p_payload.text, /121,00/);
      return json(delivered ? null : storedPayload);
    }
    if (url.includes('/rest/v1/orquivia_team_reminder_deliveries')) {
      const record = JSON.parse(init.body);
      if (record.status === 'sent') delivered = true;
      return json(null);
    }
    if (url === 'https://api.resend.com/emails') {
      sendCount++;
      assert.deepEqual(JSON.parse(init.body), storedPayload);
      assert.match(init.headers['Idempotency-Key'], /2026-10-13$/);
      return json({ id: 'fictional-email-id' });
    }
    throw new Error(`Unexpected scheduled request ${url}`);
  };
  try {
    const compiled = await build({
      entryPoints: ['supabase/functions/daily-reminders/index.ts'], bundle: true, write: false,
      platform: 'neutral', format: 'esm', plugins: [{ name: 'test-supabase-import', setup(builder) {
        builder.onResolve({ filter: /^npm:@supabase\/supabase-js/ }, () => ({ path: import.meta.resolve('@supabase/supabase-js'), external: true }));
      } }],
    });
    const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
    const handler = module.default.fetch;
    assert.equal((await handler(new Request('https://example.test', { method: 'POST' }))).status, 401);
    assert.equal(sendCount, 0);
    const request = () => new Request('https://example.test', { method: 'POST', headers: { 'x-orquivia-cron-secret': env.ORQUIVIA_CRON_SECRET } });
    state.company.emailNotifications = 'false';
    assert.equal((await handler(request())).status, 200);
    assert.equal(claimCount, 0);
    state.company.emailNotifications = true;
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sent, 1);
    assert.equal(sendCount, 1);
    await handler(request());
    assert.equal(sendCount, 1); // A sent day does not create another delivery.
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Date = OriginalDate;
    if (originalDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = originalDeno;
  }
});

test('backend refuses privileged or insecure browser configuration', () => {
  assert.throws(() => createBackend({ url: 'https://example.supabase.co', anonKey: 'sb_secret_test' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => createBackend({ url: 'https://example.supabase.co', anonKey: token('service_role') }), { code: 'INVALID_CONFIG' });
  assert.throws(() => createBackend({ url: 'http://example.com', anonKey: 'sb_publishable_test' }), { code: 'INVALID_CONFIG' });
});

test('versioned cloud writes are serialized and a conflict blocks further saving', async () => {
  const originalFetch = globalThis.fetch;
  const user = { id: 'b1000000-0000-4000-8000-000000000001', aud: 'authenticated', email: 'owner@example.test' };
  let stored = empty();
  let cloudVersion = 1;
  const attemptedVersions = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/auth/v1/token')) return json({
      access_token: token('authenticated', { sub: user.id }), refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, user,
    });
    if (url.includes('/auth/v1/user')) return json(user);
    if (url.includes('/auth/v1/logout')) return json({});
    if (url.includes('/rest/v1/rpc/refresh_orquivia_access')) return json({ organization_id: 'a2000000-0000-4000-8000-000000000001', organization_name: 'Orquívia', role: 'admin', require_mfa: false });
    if (url.includes('/rest/v1/rpc/load_orquivia_workspace')) return json({ organization_id: 'a2000000-0000-4000-8000-000000000001', organization_name: 'Orquívia', role: 'admin', require_mfa: false, state: stored, version: cloudVersion, updated_at: '2026-10-13T10:00:00Z' });
    if (url.includes('/rest/v1/rpc/save_orquivia_team_state')) {
      const { p_state, p_expected_version } = JSON.parse(init.body);
      attemptedVersions.push(p_expected_version);
      if (p_expected_version !== cloudVersion) return json({ code: '40001', message: 'VERSION_CONFLICT', details: null, hint: null }, 409);
      stored = p_state;
      cloudVersion++;
      return json({ version: cloudVersion, updated_at: '2026-10-13T10:00:00Z' });
    }
    throw new Error(`Unexpected mocked request ${url}`);
  };
  let backend;
  try {
    backend = createBackend({ url: 'https://example.supabase.co', anonKey: 'sb_publishable_test' });
    await backend.signIn('owner@example.test', 'fictional-password');
    await assert.rejects(backend.saveState(empty()), { code: 'STATE_NOT_LOADED' });
    assert.deepEqual(await backend.loadState(), empty());
    assert.equal(backend.workspaceInfo().role, 'admin');
    const first = empty();
    const second = empty();
    second.company.name = 'Second';
    const [saved1, saved2] = await Promise.all([backend.saveState(first), backend.saveState(second)]);
    assert.equal(saved1.version, 2);
    assert.equal(saved2.version, 3);
    assert.deepEqual(attemptedVersions, [1, 2]);
    assert.equal(stored.company.name, 'Second');
    cloudVersion++; // Another browser saved after this session's last load/save.
    await assert.rejects(backend.saveState(empty()), { code: 'VERSION_CONFLICT' });
    await assert.rejects(backend.saveState(empty()), { code: 'STATE_NOT_LOADED' });
    assert.equal((await backend.loadState()).company.name, 'Second');
    assert.equal((await backend.saveState(empty())).version, 5);
    await backend.signOut();
    assert.equal(await backend.currentUser(), null);
    await assert.rejects(backend.saveState(empty()), { code: 'AUTH_REQUIRED' });
  } finally {
    backend?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('access refresh checks server MFA and membership and invalidates the loaded workspace', async () => {
  const originalFetch = globalThis.fetch;
  const user = { id: 'b1000000-0000-4000-8000-000000000002', aud: 'authenticated', email: 'editor@example.test' };
  const org = 'a2000000-0000-4000-8000-000000000001';
  const access = { organization_id: org, organization_name: 'Orquívia', role: 'editor', require_mfa: false };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  let denied = null, refreshes = 0, saves = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/auth/v1/token')) return json({ access_token: token('authenticated', { sub: user.id }), refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, user });
    if (url.includes('/auth/v1/user')) return json(user);
    if (url.includes('/rest/v1/rpc/refresh_orquivia_access')) {
      refreshes++;
      if (denied) return json({ code: '42501', message: denied }, 403);
      return json(access);
    }
    if (url.includes('/rest/v1/rpc/load_orquivia_workspace')) return json({ ...access, state: empty(), version: 1 });
    if (url.includes('/rest/v1/rpc/save_orquivia_team_state')) { saves++; return json({ version: 2 }); }
    throw new Error(`Unexpected access request ${url}`);
  };
  let backend;
  const events = [];
  try {
    backend = createBackend({ url: 'https://example.supabase.co', anonKey: 'sb_publishable_test' });
    backend.onAuthStateChange((event) => events.push(event));
    await backend.signIn(user.email, 'fictional-password');
    await backend.loadState();
    denied = 'MFA_REQUIRED';
    await assert.rejects(backend.refreshAccess(), { code: 'MFA_REQUIRED' });
    assert.equal(backend.workspaceInfo(), null);
    assert.equal(refreshes, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(events.includes('MFA_REQUIRED'));
    denied = null; // A second factor was verified. Re-loading is still required.
    access.require_mfa = true;
    await assert.rejects(backend.saveState(empty()), { code: 'STATE_NOT_LOADED' });
    assert.equal(saves, 0);
    await backend.loadState();
    assert.equal(backend.workspaceInfo().requireMfa, true);
    denied = 'MEMBERSHIP_REQUIRED';
    await assert.rejects(backend.refreshAccess(), { code: 'ACCESS_REVOKED' });
    assert.equal(backend.workspaceInfo(), null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(events.includes('ACCESS_REVOKED'));
    denied = null;
    await assert.rejects(backend.saveState(empty()), { code: 'STATE_NOT_LOADED' });
    assert.equal(saves, 0);
  } finally {
    backend?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('password reauthentication preserves the active MFA session and revokes its temporary session', async () => {
  const originalFetch = globalThis.fetch;
  const user = { id: 'b1000000-0000-4000-8000-000000000003', aud: 'authenticated', email: 'owner@example.test' };
  const activeToken = token('authenticated', { sub: user.id, aal: 'aal2', session_id: 'active-mfa-session' });
  const verifierToken = token('authenticated', { sub: user.id, aal: 'aal1', session_id: 'temporary-password-session' });
  const access = { organization_id: 'a2000000-0000-4000-8000-000000000001', organization_name: 'Orquívia', role: 'admin', require_mfa: true };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const authorization = (init) => new Headers(init.headers).get('authorization');
  const logouts = [];
  let passwordUpdates = 0, updateFailure = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/auth/v1/token')) {
      const password = JSON.parse(init.body).password;
      if (password === 'wrong-password') return json({ code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
      return json({ access_token: password === 'initial-mfa-session' ? activeToken : verifierToken, refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, user });
    }
    if (url.includes('/auth/v1/user')) {
      assert.equal(authorization(init), `Bearer ${activeToken}`, 'The portal must retain the AAL2 token for every account request');
      if (init.method === 'PUT') {
        passwordUpdates++;
        assert.equal(JSON.parse(init.body).password, 'new-fictional-password');
        if (updateFailure) return json({ code: 'unexpected_failure', msg: 'Account update failed' }, 500);
      }
      return json(user);
    }
    if (url.includes('/auth/v1/logout')) { logouts.push({ scope: new URL(url).searchParams.get('scope'), authorization: authorization(init) }); return json({}); }
    if (url.includes('/rest/v1/rpc/load_orquivia_workspace')) return json({ ...access, state: empty(), version: 1 });
    if (url.includes('/rest/v1/rpc/refresh_orquivia_access')) {
      assert.equal(authorization(init), `Bearer ${activeToken}`, 'MFA-protected workspace access must still use AAL2 after the password check');
      return json(access);
    }
    throw new Error(`Unexpected password request ${url}`);
  };
  let backend;
  const events = [];
  try {
    backend = createBackend({ url: 'https://example.supabase.co', anonKey: 'sb_publishable_test' });
    backend.onAuthStateChange((event) => events.push(event));
    await backend.signIn(user.email, 'initial-mfa-session');
    await backend.loadState();
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.length = 0;
    await assert.rejects(backend.changePassword('wrong-password', 'new-fictional-password'), { code: 'AUTH_ERROR' });
    assert.equal(passwordUpdates, 0);
    assert.equal((await backend.mfa.assuranceLevel()).currentLevel, 'aal2');
    await backend.changePassword('current-fictional-password', 'new-fictional-password');
    assert.equal(passwordUpdates, 1);
    assert.equal((await backend.mfa.assuranceLevel()).currentLevel, 'aal2');
    assert.equal((await backend.refreshAccess()).requireMfa, true);
    assert.equal(backend.workspaceInfo().role, 'admin');
    assert.deepEqual(logouts, [
      { scope: 'others', authorization: `Bearer ${activeToken}` },
      { scope: 'local', authorization: `Bearer ${verifierToken}` },
    ]);
    updateFailure = true;
    await assert.rejects(backend.changePassword('current-fictional-password', 'new-fictional-password'), { code: 'AUTH_ERROR' });
    assert.deepEqual(logouts.at(-1), { scope: 'local', authorization: `Bearer ${verifierToken}` }, 'A failed password update must also revoke the temporary verification session');
    assert.equal(logouts.filter((entry) => entry.scope === 'others').length, 1, 'Failed updates must not revoke the other active sessions');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!events.includes('SIGNED_IN') && !events.includes('SIGNED_OUT'), 'The isolated password check must not replace or close the portal session');
  } finally {
    backend?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('MFA setup retry removes only unfinished Orquívia TOTP factors', async () => {
  const originalFetch = globalThis.fetch;
  const factors = [
    { id: 'unfinished-orquivia', factor_type: 'totp', status: 'unverified', friendly_name: 'Orquívia' },
    { id: 'verified-orquivia', factor_type: 'totp', status: 'verified', friendly_name: 'Orquívia' },
    { id: 'unfinished-other-app', factor_type: 'totp', status: 'unverified', friendly_name: 'Other app' },
    { id: 'unfinished-phone', factor_type: 'phone', status: 'unverified', friendly_name: 'Orquívia' },
  ];
  const user = { id: 'b1000000-0000-4000-8000-000000000004', aud: 'authenticated', email: 'owner@example.test', factors };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const removed = [];
  let enrollmentRequests = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/auth/v1/token')) return json({ access_token: token('authenticated', { sub: user.id }), refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, user });
    if (url.includes('/auth/v1/user')) return json(user);
    if (url.includes('/auth/v1/factors/') && init.method === 'DELETE') {
      const id = url.split('/').at(-1);
      assert.equal(id, 'unfinished-orquivia', 'Verified and unrelated factors must never be unenrolled');
      removed.push(id);
      return json({ id });
    }
    if (url.endsWith('/auth/v1/factors') && init.method === 'POST') {
      enrollmentRequests++;
      assert.deepEqual(removed, ['unfinished-orquivia'], 'Cleanup must finish before retrying enrollment');
      assert.deepEqual(JSON.parse(init.body), { factor_type: 'totp', friendly_name: 'Orquívia' });
      return json({ id: 'new-orquivia', type: 'totp', totp: { qr_code: '<svg/>', secret: 'fictional-test-secret', uri: 'otpauth://totp/test' } });
    }
    throw new Error(`Unexpected MFA setup request ${url}`);
  };
  let backend;
  try {
    backend = createBackend({ url: 'https://example.supabase.co', anonKey: 'sb_publishable_test' });
    await backend.signIn(user.email, 'fictional-password');
    assert.equal((await backend.mfa.enroll()).id, 'new-orquivia');
    assert.deepEqual(removed, ['unfinished-orquivia']);
    assert.equal(enrollmentRequests, 1);
  } finally {
    backend?.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('bootstrap imports are stable and cannot rewind production edits on a retry', () => {
  const original = empty();
  original.clients = [{ id: 'c1', name: 'Client' }];
  original.documents = [{ id: 'd1', kind: 'invoice', items: [{ quantity: 1, price: 100 }], vat: 21, discount: 0, withholding: 0 }];
  const pristine = { state: empty(), version: 1 };
  assert.equal(historicalImportDecision(pristine, original).action, 'import');
  const stored = structuredClone(original);
  stored.documents[0].total = 121;
  stored.company = { name: 'Orquívia' };
  const result = historicalImportDecision({ state: stored, version: 2 }, original);
  assert.equal(result.action, 'already-imported');
  assert.match(result.importHash, /^[a-f0-9]{64}$/);
  const reordered = { payments: [], documents: stored.documents.map(({ id, ...rest }) => ({ ...rest, id })), clients: stored.clients, company: stored.company };
  assert.equal(stateDigest(reordered), stateDigest(original));
  const edited = structuredClone(stored);
  edited.documents[0].po = 'ORDER-12';
  const workspace = { state: edited, version: 3 };
  assert.throws(() => historicalImportDecision(workspace, original), /HISTORICAL_IMPORT_NONEMPTY_WORKSPACE/);
  assert.throws(() => historicalImportDecision(workspace, original, { overwrite: true, expectedVersion: 2, expectedHash: stateDigest(edited) }), /EXPECTED_VERSION_AND_HASH/);
  assert.throws(() => historicalImportDecision(workspace, original, { overwrite: true, expectedVersion: 3, expectedHash: stateDigest(original) }), /EXPECTED_VERSION_AND_HASH/);
  assert.equal(historicalImportDecision(workspace, original, { overwrite: true, expectedVersion: 3, expectedHash: stateDigest(edited) }).expectedVersion, 3);
  assert.throws(() => historicalImportDecision({ state: empty(), version: 2 }, original), /NONEMPTY_WORKSPACE/);
});
