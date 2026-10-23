import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/backend.js';
import { renderAccess } from '../src/auth-ui.js';

function loginFixture() {
  const button = { disabled: false, textContent: 'Iniciar sesión' }, alert = { textContent: '' };
  const form = { elements: { password: { value: 'fictional-password' } }, querySelector: () => button };
  const host = { innerHTML: '', querySelector: selector => selector === 'form' ? form : selector === '[role="alert"]' ? alert : null };
  const page = { classList: { remove() {} } };
  const container = { innerHTML: '', querySelector: selector => selector === '#auth-content' ? host : selector === '.access-page' ? page : null };
  return { container, host, form, button, alert };
}

test('rejected login stays on the access screen without checking MFA or loading private data', async () => {
  const originalFetch = globalThis.fetch, OriginalFormData = globalThis.FormData;
  let backend;
  globalThis.FormData = class {
    get(name) { return name === 'email' ? 'member@example.test' : 'fictional-password'; }
  };
  try {
    for (const status of [400, 429, 503]) {
      const requests = [];
      globalThis.fetch = async (input, init = {}) => {
        requests.push({ path: new URL(String(input)).pathname, method: init.method });
        return new Response(JSON.stringify({ code: status === 400 ? 'invalid_credentials' : 'unexpected_failure', msg: 'private server detail' }), {
          status, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' },
        });
      };
      backend = createBackend({ url: 'https://example.supabase.co', anonKey: 'sb_publishable_test' });
      backend.currentUser = backend.loadState = backend.mfa.factors = async () => assert.fail('A rejected login must stop before session, workspace or MFA checks');
      const fixture = loginFixture();
      renderAccess(fixture.container, { backend, logo: 'logo.svg', onAuthenticated: () => assert.fail('A rejected login must not open the private portal') });
      assert.match(fixture.host.innerHTML, /contraseña del portal Orquívia.*distinta.*Arsys/);
      await fixture.form.onsubmit({ preventDefault() {}, target: fixture.form });
      assert.equal(fixture.button.disabled, false);
      assert.equal(fixture.button.textContent, 'Iniciar sesión');
      assert.match(fixture.host.innerHTML, /id="access-form"/);
      assert.doesNotMatch(fixture.host.innerHTML, /id="totp-form"/);
      assert.match(fixture.alert.textContent, status === 400 ? /Revisa el correo y la contraseña/ : status === 429 ? /demasiados intentos/ : /no está disponible temporalmente/);
      assert.doesNotMatch(fixture.alert.textContent, /private|member@example/);
      assert.deepEqual(requests, [{ path: '/auth/v1/token', method: 'POST' }]);
      backend.dispose(); backend = null;
    }
  } finally {
    backend?.dispose(); globalThis.fetch = originalFetch; globalThis.FormData = OriginalFormData;
  }
});
