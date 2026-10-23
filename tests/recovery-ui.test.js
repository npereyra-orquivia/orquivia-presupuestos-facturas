import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAccess } from '../src/auth-ui.js';

// A small DOM fixture keeps the assertions on actual handlers and transitions,
// without introducing a browser dependency into the production bundle.
function fixture(backend) {
  const nodes = new Map();
  const host = {
    isConnected: true,
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(html) {
      this._html = html; nodes.clear();
      for (const match of html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) {
        const id = /id="([^"]+)"/.exec(match[1])?.[1];
        const node = { disabled: false, textContent: match[2] };
        if (id) nodes.set(`#${id}`, node);
        if (!nodes.has('button')) nodes.set('button', node);
      }
      const formId = /<form id="([^"]+)"/.exec(html)?.[1];
      if (formId) {
        const elements = {};
        for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
          const name = /name="([^"]+)"/.exec(match[1])?.[1];
          if (name) elements[name] = { value: /value="([^"]*)"/.exec(match[1])?.[1] || '' };
        }
        const buttonMarkup = /<form\b[^>]*>[\s\S]*?<button\b[^>]*>([^<]*)<\/button>/.exec(html);
        const button = { disabled: false, textContent: buttonMarkup?.[1] || '' };
        const form = { elements, querySelector: selector => selector === 'button' ? button : null, reset() { Object.values(elements).forEach(input => { input.value = ''; }); } };
        nodes.set('form', form); nodes.set(`#${formId}`, form);
      }
    },
    querySelector(selector) { return nodes.get(selector) || null; },
    append(node) { if (node.role === 'alert') nodes.set('[role="alert"]', node); },
  };
  const page = { classList: { add() {}, remove() {} } };
  const container = { innerHTML: '', querySelector: selector => selector === '#auth-content' ? host : selector === '.access-page' ? page : null };
  const ui = renderAccess(container, { backend, logo: 'logo.svg', recoveryRedirectTo: 'https://example.test/portal/', onAuthenticated() { assert.fail('Recovery must not open the private workspace'); } });
  return { host, container, ui, nodes, submit: () => { const form = host.querySelector('form'); return form.onsubmit({ preventDefault() {}, target: form }); } };
}

function backendFixture(overrides = {}) {
  const forbidden = async () => assert.fail('Recovery must not load documents, enroll MFA, or authenticate normally');
  return {
    currentUser: forbidden, loadState: forbidden, signIn: forbidden,
    mfa: { factors: forbidden, enroll: forbidden, challenge: forbidden, verify: forbidden },
    signOut: async () => {}, ...overrides,
  };
}

async function withDOM(run) {
  const OriginalFormData = globalThis.FormData, originalDocument = globalThis.document;
  globalThis.FormData = class {
    constructor(form) { this.values = Object.fromEntries(Object.entries(form.elements).map(([name, field]) => [name, field.value])); }
    get(name) { return this.values[name]; }
    *[Symbol.iterator]() { yield* Object.entries(this.values); }
  };
  globalThis.document = { createElement: () => ({ textContent: '', setAttribute(name, value) { if (name === 'role') this.role = value; } }) };
  try { await run(); }
  finally { globalThis.FormData = OriginalFormData; globalThis.document = originalDocument; }
}

const user = { id: 'member-uuid', email: 'member@example.test' };
const status = (requiresMfa = true) => ({ user, requiresMfa, currentLevel: requiresMfa ? 'aal1' : 'aal2', factorId: 'verified-totp-id' });

test('recovery request uses the configured redirect and a generic account confirmation', () => withDOM(async () => {
  const requests = [];
  const f = fixture(backendFixture({ requestPasswordRecovery: async (...args) => { requests.push(args); return { userExists: true }; } }));
  f.host.querySelector('form').elements.email.value = 'member@example.test';
  f.host.querySelector('#forgot-password').onclick();
  assert.match(f.host.innerHTML, /Conservarás tu verificación en dos pasos/);
  await f.submit();
  assert.deepEqual(requests, [['member@example.test', { redirectTo: 'https://example.test/portal/' }]]);
  assert.match(f.host.innerHTML, /Si el correo corresponde a una cuenta autorizada/);
  assert.doesNotMatch(f.host.innerHTML, /userExists|member@example|recovery-password-form/);
  f.host.querySelector('#back-to-login').onclick();
  assert.match(f.host.innerHTML, /id="access-form"/);
}));

test('service failure is visible and can be retried without claiming an email was sent', () => withDOM(async () => {
  const f = fixture(backendFixture({ requestPasswordRecovery: async () => { throw new Error('El servicio de recuperación no está disponible.'); } }));
  f.host.querySelector('#forgot-password').onclick();
  f.host.querySelector('form').elements.email.value = 'member@example.test';
  await f.submit();
  assert.match(f.host.querySelector('[role="alert"]').textContent, /no está disponible/);
  assert.equal(f.host.querySelector('form').querySelector('button').disabled, false);
  assert.match(f.host.innerHTML, /id="recovery-request-form"/);
  assert.doesNotMatch(f.host.innerHTML, /Revisa tu correo/);
}));

test('recovery requires the existing TOTP before password entry and returns to login without opening documents', () => withDOM(async () => {
  const calls = [], credentials = { accessToken: 'fictional-recovery-access', refreshToken: 'fictional-recovery-refresh' };
  const f = fixture(backendFixture({
    beginPasswordRecovery: async value => { calls.push(['begin', value]); return status(); },
    recoveryStatus: async () => status(false),
    mfa: { enroll: async () => assert.fail('Never enroll while recovering'), challenge: async factor => { calls.push(['challenge', factor]); return { id: 'challenge-id' }; }, verify: async (...args) => { calls.push(['verify', ...args]); } },
    completePasswordRecovery: async password => { calls.push(['complete', password]); return { completed: true }; },
  }));
  assert.equal(await f.ui.recover(credentials), true);
  assert.match(f.host.innerHTML, /id="recovery-totp-form"/);
  assert.doesNotMatch(f.host.innerHTML, /newPassword|fictional-recovery|Configurar dos pasos/);
  const totpForm = f.host.querySelector('form'); totpForm.elements.code.value = '123456';
  await f.submit();
  assert.equal(totpForm.elements.code.value, '');
  assert.match(f.host.innerHTML, /id="recovery-password-form"/);
  assert.match(f.host.innerHTML, /minlength="12" maxlength="128"/);
  const passwordForm = f.host.querySelector('form');
  passwordForm.elements.newPassword.value = '  a valid new password  ';
  passwordForm.elements.repeatPassword.value = '  a valid new password  ';
  await f.submit();
  assert.deepEqual(calls, [['begin', credentials], ['challenge', 'verified-totp-id'], ['verify', 'verified-totp-id', 'challenge-id', '123456'], ['complete', '  a valid new password  ']]);
  assert.match(f.host.innerHTML, /Contraseña actualizada/);
  assert.match(f.host.innerHTML, /id="access-form"/);
  assert.equal(passwordForm.elements.newPassword.value, '');
  assert.equal(passwordForm.elements.repeatPassword.value, '');
}));

test('invalid confirmation and password length never reach the backend password mutation', () => withDOM(async () => {
  const f = fixture(backendFixture({ recoveryStatus: async () => status(false), completePasswordRecovery: async () => assert.fail('Invalid passwords cannot be submitted') }));
  await f.ui.recover();
  const form = f.host.querySelector('form');
  for (const [password, confirmation, error] of [['short', 'short', /entre 12 y 128/], ['a'.repeat(129), 'a'.repeat(129), /entre 12 y 128/], ['a valid new password', 'different password', /no coincide/]]) {
    form.elements.newPassword.value = password; form.elements.repeatPassword.value = confirmation;
    await f.submit();
    assert.match(f.host.querySelector('[role="alert"]').textContent, error);
    assert.equal(form.querySelector('button').disabled, false);
  }
}));

test('failed TOTP does not expose the password form or enroll a replacement factor', () => withDOM(async () => {
  const f = fixture(backendFixture({ recoveryStatus: async () => status(), mfa: { challenge: async () => ({ id: 'challenge-id' }), verify: async () => { throw new Error('Código incorrecto.'); }, enroll: async () => assert.fail('Cannot replace MFA during recovery') } }));
  await f.ui.recover();
  f.host.querySelector('form').elements.code.value = '654321';
  await f.submit();
  assert.match(f.host.querySelector('[role="alert"]').textContent, /Código incorrecto/);
  assert.match(f.host.innerHTML, /id="recovery-totp-form"/);
  assert.doesNotMatch(f.host.innerHTML, /newPassword|Configurar dos pasos/);
  assert.equal(f.host.querySelector('form').elements.code.value, '');
}));

test('expired recovery and missing verified factor fail closed and cancellation signs out', () => withDOM(async () => {
  for (const recovery of [null, { ...status(), factorId: null }]) {
    let signedOut = 0;
    const f = fixture(backendFixture({ recoveryStatus: async () => recovery, signOut: async () => { signedOut++; } }));
    assert.equal(await f.ui.recover(), false);
    assert.match(f.host.innerHTML, /No se pudo continuar/);
    assert.doesNotMatch(f.host.innerHTML, /id="recovery-password-form"|Configurar dos pasos/);
    await f.host.querySelector('#cancel-recovery').onclick();
    assert.equal(signedOut, 1);
    assert.match(f.host.innerHTML, /id="access-form"/);
  }
}));

test('reload resumes recovery mode rather than the private workspace', () => withDOM(async () => {
  let resumed = 0;
  const f = fixture(backendFixture({ hasPasswordRecovery: () => true, recoveryStatus: async () => { resumed++; return status(); } }));
  await f.ui.resume();
  assert.equal(resumed, 1);
  assert.match(f.host.innerHTML, /id="recovery-totp-form"/);
}));

test('a late request cannot replace a screen after returning to login', () => withDOM(async () => {
  let complete;
  const f = fixture(backendFixture({ requestPasswordRecovery: () => new Promise(resolve => { complete = resolve; }) }));
  f.host.querySelector('#forgot-password').onclick();
  f.host.querySelector('form').elements.email.value = 'member@example.test';
  const request = f.submit();
  f.host.querySelector('#back-to-login').onclick();
  complete(); await request;
  assert.match(f.host.innerHTML, /id="access-form"/);
  assert.doesNotMatch(f.host.innerHTML, /Revisa tu correo/);
}));

test('a recovery callback completing after the view is replaced cannot render secrets or authenticate', () => withDOM(async () => {
  let complete;
  const f = fixture(backendFixture({ beginPasswordRecovery: () => new Promise(resolve => { complete = resolve; }) }));
  const pending = f.ui.recover({ accessToken: 'fictional-token' });
  f.host.isConnected = false;
  complete(status(false));
  assert.equal(await pending, false);
  assert.doesNotMatch(f.host.innerHTML, /newPassword|fictional-token/);
}));
