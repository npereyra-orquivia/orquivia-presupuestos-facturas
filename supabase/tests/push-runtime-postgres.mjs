// Tests the actual private-key SQL permissions and one-time bootstrap in PostgreSQL/WASM.
// Profile membership/MFA guards are separately covered by personal-postgres.mjs.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = await PGlite.create();
let checks = 0;
const query = async (sql, parameters = []) => (await db.query(sql, parameters)).rows;
const deny = async (sql, parameters = [], code = '42501') => { await assert.rejects(db.query(sql, parameters), (error) => error.code === code); checks++; };
const as = async (role, member = false, aal = 'aal2') => {
  await db.exec(`reset role; set role ${role};`);
  await db.query("select set_config('test.member',$1,false),set_config('test.aal',$2,false)", [String(member), aal]);
};
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema orquivia_private;
    grant usage on schema orquivia_private to anon,authenticated,service_role;
    create function orquivia_private.personal_context() returns uuid
      language plpgsql security definer set search_path='' as $$
      begin
        if current_setting('test.member',true) is distinct from 'true'
          or current_setting('test.aal',true) is distinct from 'aal2' then
          raise exception 'MEMBERSHIP_OR_MFA_REQUIRED' using errcode='42501';
        end if;
        return 'a2000000-0000-4000-8000-000000000001'::uuid;
      end; $$;`);
  await db.exec(await readFile(new URL('../migrations/202610140005_push_runtime.sql', import.meta.url), 'utf8'));
  checks++;
  await as('anon');
  await deny('select * from orquivia_private.push_runtime_config');
  await deny('select public.get_orquivia_push_runtime_config()');
  await deny('select public.get_orquivia_push_config()');
  await deny('select public.initialize_orquivia_push_runtime($1,$2,$3)', ['B'.repeat(87), 'A'.repeat(43), 'mailto:nicole@example.test']);
  await deny('select public.record_orquivia_push_run(true)');
  await as('authenticated', true);
  const initial = (await query('select public.get_orquivia_push_config() result'))[0].result;
  assert.equal(initial.publicKey, null); assert.equal(initial.configured, false); checks++;
  assert.equal(Object.hasOwn(initial, 'privateKey'), false); assert.equal(Object.hasOwn(initial, 'cronSecret'), false); checks++;
  await deny('select * from orquivia_private.push_runtime_config');
  await deny('select public.get_orquivia_push_runtime_config()');
  await deny('select public.initialize_orquivia_push_runtime($1,$2,$3)', ['B'.repeat(87), 'A'.repeat(43), 'mailto:nicole@example.test']);
  await deny('select public.record_orquivia_push_run(true)');
  await as('authenticated', false);
  await deny('select public.get_orquivia_push_config()');
  await as('authenticated', true, 'aal1');
  await deny('select public.get_orquivia_push_config()');
  await as('service_role');
  await deny('select * from orquivia_private.push_runtime_config');
  const runtime = (await query('select public.get_orquivia_push_runtime_config() result'))[0].result;
  assert.equal(runtime.cronSecret.length, 64); assert.match(runtime.cronSecret, /^[a-f0-9]{64}$/); checks++;
  await deny('select public.initialize_orquivia_push_runtime($1,$2,$3)', [null, 'A'.repeat(43), 'mailto:nicole@example.test'], '22023');
  await deny('select public.initialize_orquivia_push_runtime($1,$2,$3)', ['B'.repeat(87), 'A'.repeat(43), 'http://localhost'], '22023');
  const initialized = (await query('select public.initialize_orquivia_push_runtime($1,$2,$3) result', ['B'.repeat(87), 'A'.repeat(43), 'mailto:nicole@example.test']))[0].result;
  assert.equal(initialized.publicKey, 'B'.repeat(87)); assert.equal(initialized.privateKey, 'A'.repeat(43)); checks++;
  const winning = (await query('select public.initialize_orquivia_push_runtime($1,$2,$3) result', ['C'.repeat(87), 'D'.repeat(43), 'mailto:other@example.test']))[0].result;
  assert.deepEqual(winning, initialized); checks++;
  await query('select public.record_orquivia_push_run(true)'); checks++;
  await db.exec('reset role; update orquivia_private.push_runtime_config set scheduled=true where singleton;');
  await as('authenticated', true);
  const ready = (await query('select public.get_orquivia_push_config() result'))[0].result;
  assert.equal(ready.configured, true); assert.equal(ready.lastStatus, 'ok'); assert.ok(ready.lastSuccessAt); checks++;
  assert.deepEqual(Object.keys(ready).sort(), ['configured', 'lastRunAt', 'lastStatus', 'lastSuccessAt', 'publicKey'].sort()); checks++;
  console.log(`PASS ${checks} push runtime PostgreSQL checks`);
} finally { await db.close(); }
