import test from 'node:test';
import assert from 'node:assert/strict';
import { browserSecurityPolicy } from '../scripts/security-policy.mjs';

test('production CSP permits only the configured Supabase project and its websocket', () => {
  const policy = browserSecurityPolicy({ supabaseURL:'https://abcdefghijklmnopqrst.supabase.co' });
  assert.match(policy, /connect-src 'self' https:\/\/abcdefghijklmnopqrst\.supabase\.co wss:\/\/abcdefghijklmnopqrst\.supabase\.co;/);
  assert.doesNotMatch(policy, /\*|127\.0\.0\.1|unsafe-eval/);
  assert.match(policy, /script-src 'self';/);
  assert.match(policy, /object-src 'none';/);
});
test('invalid or missing production project URLs never widen network permissions', () => {
  for (const supabaseURL of ['', 'https://project.supabase.co.attacker.example', 'http://project.supabase.co',
    'https://project.supabase.co:443', "https://project.supabase.co/; connect-src *", 'https://user:secret@project.supabase.co']) {
    const policy = browserSecurityPolicy({ supabaseURL });
    assert.match(policy, /connect-src 'self';/);
    assert.doesNotMatch(policy, /attacker|secret|\*/);
  }
});
test('only local development can retain dynamic test connections and HMR', () => {
  assert.match(browserSecurityPolicy({ development:true }), /http:\/\/127\.0\.0\.1:\*/);
  assert.match(browserSecurityPolicy({ development:true }), /https:\/\/\*\.supabase\.co/);
});
