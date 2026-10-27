import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStagingConfiguration, PRODUCTION_PROJECT_REF } from '../scripts/staging-config.mjs';

const ref = 'abcdefghijklmnopqrst';
const configured = () => ({ VITE_APP_MODE: 'staging', VITE_DOCUMENT_MAIL: 'false',
  VITE_SUPABASE_URL: `https://${ref}.supabase.co`, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fictional_staging_test',
  ORQUIVIA_STAGING_PROJECT_REF: ref });

test('a staging build requires a dedicated project and disables document email', () => {
  assert.deepEqual(assertStagingConfiguration(configured()), { projectRef: ref, mailEnabled: false });
});
test('staging cannot point to the live company even with explicit confirmation', () => {
  assert.throws(() => assertStagingConfiguration({ ...configured(),
    VITE_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`, ORQUIVIA_STAGING_PROJECT_REF: PRODUCTION_PROJECT_REF }), /PRODUCTION_PROJECT_FORBIDDEN/);
});
test('staging rejects mail, implicit mode, project mismatch and privileged keys', () => {
  for (const change of [{ VITE_DOCUMENT_MAIL: 'true' }, { VITE_DOCUMENT_MAIL: undefined },
    { VITE_APP_MODE: 'production' }, { ORQUIVIA_STAGING_PROJECT_REF: 'different' },
    { VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_forbidden' }, { VITE_SUPABASE_URL: 'https://attacker.example' }]) {
    assert.throws(() => assertStagingConfiguration({ ...configured(), ...change }));
  }
});
