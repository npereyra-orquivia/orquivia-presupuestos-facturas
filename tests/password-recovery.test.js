import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePasswordRecoveryURL, validRecoveryCredentials } from '../src/password-recovery.js';
import { createBackend } from '../src/backend.js';

const jwt = (id, aal = 'aal1') => [
  { alg: 'HS256', typ: 'JWT' }, { sub: id, role: 'authenticated', aal, amr: [], exp: Math.floor(Date.now() / 1000) + 3600 },
].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).concat('fictional-signature').join('.');
const member = { id: 'b1000000-0000-4000-8000-000000000006', aud: 'authenticated', email: 'member@example.test',
  factors: [{ id: 'verified-totp', factor_type: 'totp', status: 'verified' }] };
const credentials = { accessToken: jwt(member.id), refreshToken: 'fictional-refresh-token' };
const callback = (extra = '') => `https://example.test/portal/?recuperar=1#access_token=${credentials.accessToken}&refresh_token=${credentials.refreshToken}&type=recovery&token_type=bearer${extra}`;

test('recovery callback accepts only explicit recovery credentials and supplies a URL without secrets', () => {
  assert.equal(parsePasswordRecoveryURL('https://example.test/portal/#presupuestos?estado=all'), null);
  const result = parsePasswordRecoveryURL(callback());
  assert.deepEqual(result.credentials, credentials);
  assert.equal(result.error, null);
  assert.equal(result.cleanURL, 'https://example.test/portal/');
  assert.equal(validRecoveryCredentials({ accessToken: 'not-a-jwt', refreshToken: 'fictional-token' }), false);
  assert.equal(validRecoveryCredentials({ accessToken: credentials.accessToken, refreshToken: '<script>' }), false);
  assert.equal(validRecoveryCredentials({ accessToken: credentials.accessToken, refreshToken: 'a'.repeat(4097) }), false);
});

test('bad, duplicate, query-form, expired and non-recovery callbacks fail without retaining or reflecting secrets', () => {
  const urls = [
    callback('&type=recovery'), callback('&access_token=private-second-token'),
    callback().replace('type=recovery', 'type=magiclink'), callback().replace('token_type=bearer', 'token_type=other'),
    callback().replace(`refresh_token=${credentials.refreshToken}`, 'refresh_token='),
    'https://example.test/portal/?recuperar=1',
    'https://example.test/portal/#error=access_denied&error_code=otp_expired&error_description=private-detail',
    `https://example.test/portal/?access_token=${credentials.accessToken}&refresh_token=private-token&type=recovery`,
  ];
  for (const url of urls) {
    const result = parsePasswordRecoveryURL(url);
    assert.equal(result.credentials, null);
    assert.match(result.error, /enlace.*no es válido o ha caducado/);
    assert.doesNotMatch(result.error + result.cleanURL, /private|access_token|refresh_token|recuperar|magiclink/);
    assert.equal(result.cleanURL, 'https://example.test/portal/');
  }
});

function fixture({ verifiedFactor = true, failOtherLogout = false, failUserReadAfter = Infinity } = {}) {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.sessionStorage;
  const data = new Map(), requests = [], passwordUpdates = [], logouts = [];
  const user = structuredClone(member);
  if (!verifiedFactor) user.factors = [];
  const tokenAal2 = jwt(user.id, 'aal2');
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' } });
  let recoveryError = null;
  let userReads = 0;
  globalThis.sessionStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path: url.pathname, method: init.method || 'GET', body });
    if (url.pathname === '/auth/v1/recover') return recoveryError ? json({ code: recoveryError, msg: 'private-account-detail' }, recoveryError === 'over_request_rate_limit' ? 429 : 400) : json({});
    if (url.pathname === '/auth/v1/user') {
      if ((!init.method || init.method === 'GET') && ++userReads > failUserReadAfter) return json({ code: 'bad_jwt', msg: 'Invalid session' }, 401);
      if (init.method === 'PUT') {
        passwordUpdates.push(body);
        assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${tokenAal2}`);
        assert.equal(Object.hasOwn(body, 'current_password'), false);
      }
      return json(user);
    }
    if (url.pathname === '/auth/v1/token') return json({ access_token: credentials.accessToken, refresh_token: 'fictional-login-refresh', token_type: 'bearer', expires_in: 3600, user });
    if (url.pathname === '/auth/v1/factors/verified-totp/challenge') return json({ id: 'challenge', expires_at: Math.floor(Date.now() / 1000) + 60 });
    if (url.pathname === '/auth/v1/factors/verified-totp/verify') {
      if (body.code !== '123456') return json({ code: 'mfa_verification_failed', msg: 'Invalid verification code' }, 400);
      return json({ access_token: tokenAal2, refresh_token: 'fictional-refreshed-token', token_type: 'bearer', expires_in: 3600, user });
    }
    if (url.pathname === '/auth/v1/logout') {
      const scope = url.searchParams.get('scope');
      logouts.push(scope);
      return scope === 'others' && failOtherLogout ? json({ code: 'unexpected_failure', msg: 'private failure' }, 500) : json({});
    }
    throw new Error(`Unexpected recovery transport ${url.pathname}`);
  };
  const instances = [];
  function backend() { const value = createBackend({ url: 'https://example.supabase.co', anonKey: 'sb_publishable_test' }); instances.push(value); return value; }
  return { backend, data, requests, passwordUpdates, logouts, user,
    setRecoveryError(value) { recoveryError = value; },
    cleanup() { for (const instance of instances) instance.dispose(); globalThis.fetch = originalFetch; if (originalStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = originalStorage; },
  };
}

test('recovery email requests do not expose unknown accounts or access company data', async () => {
  const f = fixture();
  try {
    const backend = f.backend();
    assert.deepEqual(await backend.requestPasswordRecovery(' member@example.test ', { redirectTo: 'https://example.test/portal/?recuperar=1' }), { requested: true });
    f.setRecoveryError('user_not_found');
    assert.deepEqual(await backend.requestPasswordRecovery('unknown@example.test', { redirectTo: 'https://example.test/portal/?recuperar=1' }), { requested: true });
    f.setRecoveryError('over_request_rate_limit');
    await assert.rejects(backend.requestPasswordRecovery('member@example.test', { redirectTo: 'https://example.test/' }), /demasiados enlaces/);
    await assert.rejects(backend.requestPasswordRecovery('bad-email', { redirectTo: 'https://example.test/' }), { code: 'INVALID_EMAIL' });
    await assert.rejects(backend.requestPasswordRecovery('member@example.test', { redirectTo: 'javascript:alert(1)' }), { code: 'INVALID_CONFIG' });
    assert.ok(f.requests.every(request => request.path === '/auth/v1/recover'));
    assert.equal(backend.hasPasswordRecovery(), false);
  } finally { f.cleanup(); }
});

test('recovery requires the existing verified TOTP before password update and never opens company data', async () => {
  const f = fixture();
  try {
    const backend = f.backend();
    await assert.rejects(backend.beginPasswordRecovery({ accessToken: 'bad', refreshToken: 'bad' }), { code: 'RECOVERY_REQUIRED' });
    assert.equal(f.requests.length, 0);
    const status = await backend.beginPasswordRecovery(credentials);
    assert.equal(status.user.id, member.id);
    assert.equal(status.factorId, 'verified-totp');
    assert.equal(status.requiresMfa, true);
    assert.equal(backend.hasPasswordRecovery(), true);
    await assert.rejects(backend.completePasswordRecovery('fictional-new-password'), { code: 'MFA_REQUIRED' });
    await assert.rejects(backend.loadState(), { code: 'PASSWORD_RECOVERY_REQUIRED' });
    assert.equal(f.passwordUpdates.length, 0);
    const marker = JSON.parse([...f.data].find(([key]) => key.startsWith('orquivia.password-recovery.'))[1]);
    assert.deepEqual(Object.keys(marker).sort(), ['startedAt', 'userId']);
    assert.ok(!JSON.stringify(marker).includes(credentials.refreshToken));
    const challenge = await backend.mfa.challenge(status.factorId);
    await assert.rejects(backend.mfa.verify(status.factorId, challenge.id, '000000'), /Invalid verification code/);
    await assert.rejects(backend.completePasswordRecovery('fictional-new-password'), { code: 'MFA_REQUIRED' });
    assert.equal(f.passwordUpdates.length, 0);
    await backend.mfa.verify(status.factorId, challenge.id, '123456');
    const password = '  🔑 nueva clave segura  ';
    assert.deepEqual(await backend.completePasswordRecovery(password), { completed: true, warning: null });
    assert.equal(f.passwordUpdates[0].password, password);
    assert.deepEqual(f.logouts, ['others', 'local']);
    assert.equal(backend.hasPasswordRecovery(), false);
    assert.equal(await backend.currentUser(), null);
    assert.ok(f.requests.every(request => !request.path.startsWith('/rest/') && !request.path.endsWith('/unenroll')));
  } finally { f.cleanup(); }
});

test('expired and corrupt recovery markers cannot restore an already verified session as a normal login', async () => {
  for (const corrupt of [false, true]) {
    const f = fixture();
    try {
      const first = f.backend(), status = await first.beginPasswordRecovery(credentials);
      const challenge = await first.mfa.challenge(status.factorId);
      await first.mfa.verify(status.factorId, challenge.id, '123456');
      first.dispose();
      const markerKey = [...f.data.keys()].find(key => key.startsWith('orquivia.password-recovery.'));
      f.data.set(markerKey, corrupt ? '{broken' : JSON.stringify({ userId: member.id, startedAt: Date.now() - 31 * 60 * 1000 }));
      const restored = f.backend();
      assert.equal(restored.hasPasswordRecovery(), true);
      await assert.rejects(restored.recoveryStatus(), { code: 'RECOVERY_REQUIRED' });
      await assert.rejects(restored.loadState(), { code: 'PASSWORD_RECOVERY_REQUIRED' });
      await assert.rejects(restored.refreshAccess(), { code: 'PASSWORD_RECOVERY_REQUIRED' });
      assert.equal(f.passwordUpdates.length, 0);
      assert.ok(f.requests.every(request => !request.path.startsWith('/rest/')));
      await restored.signOut();
      assert.equal(restored.hasPasswordRecovery(), false);
    } finally { f.cleanup(); }
  }
});

test('failed callback verification clears partial sessions, and later verification failures preserve recovery lock', async () => {
  for (const failUserReadAfter of [0, 1]) {
    const f = fixture({ failUserReadAfter });
    try {
      const backend = f.backend();
      await assert.rejects(backend.beginPasswordRecovery(credentials));
      assert.equal(backend.hasPasswordRecovery(), failUserReadAfter === 1);
      if (failUserReadAfter === 0) assert.equal(await backend.currentUser(), null);
      else await assert.rejects(backend.loadState(), { code: 'PASSWORD_RECOVERY_REQUIRED' });
      assert.equal(f.passwordUpdates.length, 0);
      assert.ok(f.requests.every(request => !request.path.startsWith('/rest/')));
    } finally { f.cleanup(); }
  }
});

test('a new login invalidates an earlier recovery context before any password update', async () => {
  const f = fixture();
  try {
    const backend = f.backend();
    await backend.beginPasswordRecovery(credentials);
    await backend.signIn(member.email, 'fictional-password');
    assert.equal(backend.hasPasswordRecovery(), false);
    await assert.rejects(backend.completePasswordRecovery('fictional-new-password'), { code: 'RECOVERY_REQUIRED' });
    assert.equal(f.passwordUpdates.length, 0);
  } finally { f.cleanup(); }
});

test('missing verified factor fails closed without enrolling a replacement', async () => {
  const f = fixture({ verifiedFactor: false });
  try {
    const backend = f.backend(), status = await backend.beginPasswordRecovery(credentials);
    assert.equal(status.factorId, null);
    assert.equal(status.requiresMfa, true);
    await assert.rejects(backend.completePasswordRecovery('fictional-new-password'), { code: 'MFA_REQUIRED' });
    assert.equal(f.passwordUpdates.length, 0);
    assert.ok(f.requests.every(request => request.path === '/auth/v1/user'));
  } finally { f.cleanup(); }
});

test('recovery reload restores only an identity marker and cancellation removes authorization to reset', async () => {
  const f = fixture();
  try {
    const first = f.backend();
    await first.beginPasswordRecovery(credentials);
    first.dispose();
    const restored = f.backend();
    assert.equal(restored.hasPasswordRecovery(), true);
    const status = await restored.recoveryStatus();
    assert.equal(status.user.id, member.id);
    assert.equal(status.requiresMfa, true);
    await restored.signOut();
    assert.equal(restored.hasPasswordRecovery(), false);
    await assert.rejects(restored.completePasswordRecovery('fictional-new-password'), { code: 'RECOVERY_REQUIRED' });
    assert.equal(f.passwordUpdates.length, 0);
  } finally { f.cleanup(); }
});

test('recovery password length counts Unicode characters and successful reset reports cleanup failure honestly', async () => {
  const f = fixture({ failOtherLogout: true });
  try {
    const backend = f.backend(), status = await backend.beginPasswordRecovery(credentials);
    for (const password of ['🔑'.repeat(11), '🔑'.repeat(129)]) await assert.rejects(backend.completePasswordRecovery(password), { code: 'INVALID_PASSWORD' });
    const challenge = await backend.mfa.challenge(status.factorId);
    await backend.mfa.verify(status.factorId, challenge.id, '123456');
    const result = await backend.completePasswordRecovery('🔑'.repeat(12));
    assert.equal(result.completed, true);
    assert.match(result.warning, /contraseña se ha cambiado.*demás sesiones/);
    assert.equal(f.passwordUpdates.length, 1);
    assert.equal(await backend.currentUser(), null);
    assert.equal(backend.hasPasswordRecovery(), false);
  } finally { f.cleanup(); }
});
