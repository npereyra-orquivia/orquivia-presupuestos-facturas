// Server-only operator script. JSON config and secrets enter through stdin.
// {apply:false,url,serviceKey,admin:{email,password,name},editor:{email,password,name},
//  organizationId?,statePath?,requireMfa:true,overwrite:false,expectedVersion?,expectedHash?}
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { totals, validateWorkspace } from '../../src/domain.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** Mirrors the import RPC's calculated total and ignores object key ordering. */
export function stateDigest(state) {
  const normalized = { ...state, documents: state.documents.map((document) => ({ ...document, total: totals(document).total })) };
  return createHash('sha256').update(JSON.stringify(canonical(normalized))).digest('hex');
}

/** A retry may skip an identical result, but may never rewind subsequent user changes. */
export function historicalImportDecision(workspace, state, options = {}) {
  const currentHash = stateDigest(workspace.state), importHash = stateDigest(state);
  if (currentHash === importHash) return { action: 'already-imported', importHash };
  const pristine = Number(workspace.version) === 1
    && ['clients', 'documents', 'payments'].every((key) => Array.isArray(workspace.state[key]) && workspace.state[key].length === 0);
  if (pristine) return { action: 'import', expectedVersion: 1, importHash };
  if (options.overwrite !== true) throw new Error('HISTORICAL_IMPORT_NONEMPTY_WORKSPACE');
  if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion !== Number(workspace.version)
    || typeof options.expectedHash !== 'string' || options.expectedHash !== currentHash) {
    throw new Error('HISTORICAL_IMPORT_EXPECTED_VERSION_AND_HASH_REQUIRED');
  }
  return { action: 'import', expectedVersion: options.expectedVersion, importHash };
}

async function bootstrapTeam(c) {
  const url = new URL(c.url), key = String(c.serviceKey || '');
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) throw new Error('SUPABASE_HTTPS_HOST_REQUIRED');
  const role = key.split('.').length === 3 ? JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role : null;
  if (!key.startsWith('sb_secret_') && role !== 'service_role') throw new Error('SERVER_SECRET_KEY_REQUIRED');
  for (const accountRole of ['admin', 'editor']) {
    const account = c[accountRole];
    if (!account || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) || typeof account.password !== 'string' || account.password.length < 16) {
      throw new Error('TWO_ACCOUNTS_AND_STRONG_PASSWORDS_REQUIRED');
    }
  }
  if (c.admin.email.toLowerCase() === c.editor.email.toLowerCase()) throw new Error('DISTINCT_ACCOUNTS_REQUIRED');
  if (c.requireMfa !== undefined && typeof c.requireMfa !== 'boolean') throw new Error('REQUIRE_MFA_BOOLEAN_REQUIRED');
  if (c.overwrite !== undefined && typeof c.overwrite !== 'boolean') throw new Error('OVERWRITE_BOOLEAN_REQUIRED');
  let state = null;
  if (c.statePath) {
    state = JSON.parse(await readFile(c.statePath, 'utf8'));
    if (validateWorkspace(state).length) throw new Error('HISTORICAL_STATE_INVALID');
  }
  if (c.apply !== true) {
    console.log('Validated locally. No network calls or changes performed. Production MFA defaults to required.');
    return;
  }
  const db = createClient(url.origin, key, { auth: { persistSession: false, autoRefreshToken: false } }), found = new Map();
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    for (const user of data.users) if (user.email) found.set(user.email.toLowerCase(), user);
    if (data.users.length < 100) break;
  }
  const users = {};
  for (const accountRole of ['admin', 'editor']) {
    const account = c[accountRole]; let user = found.get(account.email.toLowerCase());
    if (!user) {
      const { data, error } = await db.auth.admin.createUser({ email: account.email, password: account.password, email_confirm: true, user_metadata: { name: account.name || accountRole } });
      if (error) throw error;
      user = data.user;
    }
    users[accountRole] = user.id;
  }
  const { data: membership, error: membershipError } = await db.from('orquivia_memberships').select('organization_id').eq('user_id', users.admin).maybeSingle();
  if (membershipError) throw membershipError;
  const org = c.organizationId || membership?.organization_id || crypto.randomUUID();
  const { error: bootstrapError } = await db.rpc('bootstrap_orquivia_team', { p_admin_user_id: users.admin, p_editor_user_id: users.editor, p_name: 'Orquívia', p_organization_id: org });
  if (bootstrapError) throw bootstrapError;
  // The legacy SQL default stays unchanged; production provisioning explicitly requires MFA.
  const requireMfa = c.requireMfa !== false;
  const { error: mfaError } = await db.from('orquivia_organizations').update({ require_mfa: requireMfa }).eq('id', org);
  if (mfaError) throw mfaError;
  let importResult = 'not-requested', importHash;
  if (state) {
    const { data: workspace, error } = await db.from('orquivia_team_workspaces').select('state,version').eq('organization_id', org).single();
    if (error) throw error;
    const decision = historicalImportDecision(workspace, state, c);
    importHash = decision.importHash;
    importResult = decision.action;
    if (decision.action === 'import') {
      const { error: importError } = await db.rpc('import_orquivia_state', { p_organization_id: org, p_state: state, p_expected_version: decision.expectedVersion });
      if (importError) throw importError;
      importResult = 'imported';
    }
  }
  console.log(JSON.stringify({ organizationId: org, accountsProvisioned: 2, sharedWorkspace: true, requireMfa, historicalImport: importResult, importHash }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  try { await bootstrapTeam(JSON.parse(input)); }
  catch (error) {
    // Provider errors may contain supplied data. Never print their message or response body.
    const operatorErrors = new Set(['SUPABASE_HTTPS_HOST_REQUIRED', 'SERVER_SECRET_KEY_REQUIRED', 'TWO_ACCOUNTS_AND_STRONG_PASSWORDS_REQUIRED',
      'DISTINCT_ACCOUNTS_REQUIRED', 'REQUIRE_MFA_BOOLEAN_REQUIRED', 'OVERWRITE_BOOLEAN_REQUIRED', 'HISTORICAL_STATE_INVALID',
      'HISTORICAL_IMPORT_NONEMPTY_WORKSPACE', 'HISTORICAL_IMPORT_EXPECTED_VERSION_AND_HASH_REQUIRED']);
    const safe = operatorErrors.has(error.message) ? error.message : 'PROVISIONING_FAILED';
    console.error(JSON.stringify({ error: safe, code: typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : undefined, partialChangesPossible: true }));
    process.exitCode = 1;
  }
}
