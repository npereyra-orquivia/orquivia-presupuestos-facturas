import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeArchive, bufferEntry } from '../scripts/backup/archive.mjs';
import { DRIVE_SCOPE, DRIVE_UPLOAD_LIMITS, DRIVE_UPLOAD_FIELDS, driveConfiguration, validateSessionURL, uploadBackup, main } from '../scripts/backup/drive-upload.mjs';

const FOLDER = 'fixture_private_folder_1234', FILE_ID = 'fixture_uploaded_file_1234';
const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture_session_12345';
const OWNER = 'owner@example.test', REVIEWER = 'reviewer@example.test';
const PRIVATE_PERMISSIONS = [{ id: 'fixture-owner', type: 'user', role: 'owner', emailAddress: OWNER },
  { id: 'fixture-reviewer', type: 'user', role: 'reader', emailAddress: REVIEWER }];
const ENV = { ORQUIVIA_DRIVE_UPLOAD_ENABLED: 'true', ORQUIVIA_DRIVE_FOLDER_ID: FOLDER,
  ORQUIVIA_DRIVE_ALLOWED_EMAILS: `${OWNER},${REVIEWER}`,
  ORQUIVIA_DRIVE_CLIENT_ID: '123456789-test.apps.googleusercontent.com', ORQUIVIA_DRIVE_CLIENT_SECRET: 'fixture-only-client-secret',
  ORQUIVIA_DRIVE_REFRESH_TOKEN: 'fixture-only-refresh-token-not-real' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function fixture(t, { incomplete = false, large = false, sourceCommit, original = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orquivia-drive-test-'));
  t.after(async () => { assert.ok(root.startsWith(join(tmpdir(), 'orquivia-drive-test-'))); await rm(root, { recursive: true, force: true }); });
  const key = randomBytes(32), file = join(root, 'orquivia-fixture.orqbackup');
  const entries = [bufferEntry('database.dump', 'PGDMP-fake-test-only'), bufferEntry('database-roles.sql', '-- fixture'), bufferEntry('source.tar', 'source-fixture'),
    ...['auth', 'vault-secrets', 'recovery'].map(name => bufferEntry(`configuration/${name}.json`, '{}')),
    ...['buckets', 'inventory'].map(name => bufferEntry(`storage/${name}.json`, '[]'))];
  if (large) entries.push(bufferEntry('large/private.dat', Buffer.alloc(7 * 1024 * 1024, 123)));
  if (original) entries.push(bufferEntry('storage/objects/receipts/org/test.pdf', 'stub', {kind:'storage-object',bucket:'receipts',name:'org/test.pdf',size:4}));
  await writeArchive({ output: file, key, source: { projectRef: 'abcdefghijklmnopqrst', storageObjects: original ? 1 : 0, ...(sourceCommit ? {commit:sourceCommit} : {}) }, entries: incomplete ? entries.slice(0, 2) : entries });
  const bytes = await readFile(file);
  const env = { ...ENV, ORQUIVIA_BACKUP_KEY: key.toString('base64') };
  return { root, file, bytes, env, key };
}

function service(f, { token, folder, permissions, session = SESSION, uploaded, chunk, postPermissions, responseFailure } = {}) {
  const calls = []; let folderCalls = 0, permissionCalls = 0, uploadCalls = 0;
  const finished = { id: FILE_ID, name: 'orquivia-fixture.orqbackup', mimeType: 'application/octet-stream', trashed: false,
    parents: [FOLDER], size: String(f.bytes.length), md5Checksum: createHash('md5').update(f.bytes).digest('hex'), sha256Checksum: createHash('sha256').update(f.bytes).digest('hex'), ...uploaded };
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (responseFailure) return responseFailure(url, options);
    if (url === 'https://oauth2.googleapis.com/token') return token || json({ access_token: 'fixture-only-access-token-not-real', token_type: 'Bearer', expires_in: 3600, scope: DRIVE_SCOPE });
    if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${FOLDER}?`)) {
      folderCalls++; return folder || json({ id: FOLDER, mimeType: 'application/vnd.google-apps.folder', trashed: false, capabilities: { canAddChildren: true } });
    }
    if (url.includes('/permissions?')) {
      permissionCalls++;
      return ((permissionCalls > 1 && postPermissions) || permissions)?.clone() || json({ permissions: PRIVATE_PERMISSIONS });
    }
    if (options.method === 'POST' && url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=')) return new Response(null, { status: 200, headers: { location: session } });
    if (url === session) {
      uploadCalls++;
      if (chunk) return chunk({ url, options, uploadCalls, finished });
      return json(finished);
    }
    throw new Error('Unexpected fixture destination');
  };
  return { fetcher, calls, finished };
}

test('Drive helper remains disabled without explicit authorization and accepts only complete narrow config', () => {
  assert.throws(() => driveConfiguration({ ...ENV, ORQUIVIA_DRIVE_UPLOAD_ENABLED: '' }), { code: 'DRIVE_UPLOAD_NOT_AUTHORIZED' });
  assert.equal(driveConfiguration(ENV).folderId, FOLDER);
  for (const extra of [{ ORQUIVIA_DRIVE_FOLDER_ID: `https://drive.google.com/${FOLDER}` }, { ORQUIVIA_DRIVE_CLIENT_SECRET: 'bad\nsecret' }, { ORQUIVIA_DRIVE_REFRESH_TOKEN: '' }]) {
    assert.throws(() => driveConfiguration({ ...ENV, ...extra }), { code: 'DRIVE_CONFIGURATION_INVALID' });
  }
});

test('provider session projection and opaque session credential retain the fixed destination and never leak in results', async t => {
  const session = `${SESSION}&fields=${encodeURIComponent(DRIVE_UPLOAD_FIELDS)}&session_crd=fixture_private_session_credential`;
  assert.equal(validateSessionURL(session),session);
  for (const extra of ['&fields=*','&session_crd=other_secret','&uploadType=resumable','&upload_id=other_id','&other=1'])
    assert.throws(()=>validateSessionURL(session+extra),{code:'DRIVE_SESSION_URL_INVALID'});
  assert.throws(()=>validateSessionURL(SESSION+'&fields=*'),{code:'DRIVE_SESSION_URL_INVALID'});
  assert.throws(()=>validateSessionURL(SESSION+'&session_crd=https%3A%2F%2Fevil.example'),{code:'DRIVE_SESSION_URL_INVALID'});
  const f=await fixture(t),mock=service(f,{session});
  const result=await uploadBackup({file:f.file,env:f.env,fetcher:mock.fetcher});
  assert.equal(result.status,'uploaded-and-verified');
  assert.ok(mock.calls.some(call=>call.url===session&&call.options.method==='PUT'));
  assert.ok(!JSON.stringify(result).includes('fixture_private_session_credential'));
});

test('allowed people are a mandatory canonical ASCII list of one to twenty unique addresses', () => {
  assert.deepEqual([...driveConfiguration(ENV).allowedEmails], [OWNER, REVIEWER]);
  assert.deepEqual([...driveConfiguration({ ...ENV, ORQUIVIA_DRIVE_ALLOWED_EMAILS: OWNER }).allowedEmails], [OWNER]);
  const twenty = Array.from({ length: 20 }, (_, index) => `person${index}@example.test`).join(',');
  assert.equal(driveConfiguration({ ...ENV, ORQUIVIA_DRIVE_ALLOWED_EMAILS: twenty }).allowedEmails.size, 20);
  for (const value of [undefined, null, [], '', OWNER.toUpperCase(), ` ${OWNER}`, `${OWNER}, ${REVIEWER}`, `${OWNER},`,
    `${OWNER},${OWNER}`, `${OWNER},${OWNER.toUpperCase()}`, 'owner@example.test\n', 'ownér@example.test',
    'Owner <owner@example.test>', 'owner@localhost', 'owner..name@example.test', '.owner@example.test',
    'owner@example..test', `${OWNER};${REVIEWER}`, `${twenty},extra@example.test`]) {
    assert.throws(() => driveConfiguration({ ...ENV, ORQUIVIA_DRIVE_ALLOWED_EMAILS: value }), { code: 'DRIVE_ALLOWED_EMAILS_INVALID' });
  }
});

test('a missing allowed-person list fails before any Google request', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(uploadBackup({ file: f.file, env: { ...f.env, ORQUIVIA_DRIVE_ALLOWED_EMAILS: undefined },
    fetcher: () => { calls++; } }), { code: 'DRIVE_ALLOWED_EMAILS_INVALID' });
  assert.equal(calls, 0);
});

test('session URLs cannot redirect the token or ciphertext to another host, path, port or query', () => {
  assert.equal(validateSessionURL(SESSION), SESSION);
  for (const value of [SESSION.replace('www.googleapis.com', 'evil.example'), SESSION.replace('https:', 'http:'), SESSION.replace('/upload/drive/v3/files', '/other'), `${SESSION}&other=1`, `${SESSION}&upload_id=duplicate`, `${SESSION}#fragment`, SESSION.replace('www.googleapis.com', 'user:pass@www.googleapis.com'), SESSION.replace('www.googleapis.com', 'www.googleapis.com:444')]) {
    assert.throws(() => validateSessionURL(value), { code: 'DRIVE_SESSION_URL_INVALID' });
  }
});

test('only a verified complete encrypted archive is uploaded to the configured folder without changing sharing', async t => {
  const f = await fixture(t), mock = service(f);
  const result = await uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher });
  assert.deepEqual(result, { status: 'uploaded-and-verified', encryptedBytes: f.bytes.length, checksumVerified: true, permissionsChecked: true, recoveryTested: false });
  const create = mock.calls.find(call => call.options.method === 'POST' && call.url.includes('/upload/'));
  assert.deepEqual(JSON.parse(create.options.body), { name: 'orquivia-fixture.orqbackup', mimeType: 'application/octet-stream', parents: [FOLDER] });
  const put = mock.calls.find(call => call.options.method === 'PUT');
  assert.deepEqual(put.options.body, f.bytes);
  assert.equal(put.options.body.includes(Buffer.from('PGDMP-fake-test-only')), false);
  assert.equal(put.options.body.includes(Buffer.from(f.env.ORQUIVIA_BACKUP_KEY)), false);
  assert.ok(mock.calls.every(call => call.options.redirect === 'manual' && call.options.credentials === 'omit'));
  assert.ok(mock.calls.every(call => !['PATCH', 'DELETE'].includes(call.options.method)));
  assert.ok(mock.calls.filter(call => call.url.includes('/permissions')).every(call => call.options.method === 'GET'));
  assert.ok(mock.calls.filter(call => call.url.includes('/permissions')).every(call => new URL(call.url).searchParams.get('fields').includes('emailAddress')));
  assert.doesNotMatch(JSON.stringify(result), /token|fixture_private|uploaded_file|client_secret|BACKUP_KEY/);
});

test('optional health evidence is derived from the authenticated archive only after verified upload', async t => {
  const commit='a'.repeat(40), f=await fixture(t,{sourceCommit:commit,original:true}),mock=service(f);
  const result=await uploadBackup({file:f.file,env:f.env,fetcher:mock.fetcher,includeEvidence:true});
  assert.deepEqual(result.operationalEvidence,{sourceCommit:commit,storageObjects:1,storageBytes:4,archiveSha256:createHash('sha256').update(f.bytes).digest('hex')});
  const missing=await fixture(t);let calls=0;
  await assert.rejects(uploadBackup({file:missing.file,env:missing.env,fetcher:()=>{calls++;},includeEvidence:true}),{code:'DRIVE_ARCHIVE_METADATA_INVALID'});
  assert.equal(calls,0);
});

test('one authorized owner or exactly two authorized people with supported roles can receive a copy', async t => {
  const f = await fixture(t);
  const one = service(f, { permissions: json({ permissions: [PRIVATE_PERMISSIONS[0]] }) });
  assert.equal((await uploadBackup({ file: f.file, env: { ...f.env, ORQUIVIA_DRIVE_ALLOWED_EMAILS: OWNER }, fetcher: one.fetcher })).status, 'uploaded-and-verified');
  for (const role of ['owner', 'writer', 'commenter', 'reader']) {
    const mock = service(f, { permissions: json({ permissions: [PRIVATE_PERMISSIONS[0], { ...PRIVATE_PERMISSIONS[1], role, emailAddress: REVIEWER.toUpperCase() }] }) });
    assert.equal((await uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher })).status, 'uploaded-and-verified');
  }
});

test('plaintext, invalid archives, wrong keys and incomplete recovery contents make no Google request', async t => {
  for (const variant of ['plaintext', 'key', 'incomplete']) {
    const f = await fixture(t, { incomplete: variant === 'incomplete' }); let calls = 0;
    if (variant === 'plaintext') await writeFile(f.file, 'Secret fixture plaintext'.repeat(10));
    if (variant === 'key') f.env.ORQUIVIA_BACKUP_KEY = randomBytes(32).toString('base64');
    await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: () => { calls++; } }));
    assert.equal(calls, 0);
  }
});

test('OAuth token refresh must confirm exactly drive.file; broad, extra or missing scopes fail closed', async t => {
  const f = await fixture(t);
  for (const scope of [undefined, 'https://www.googleapis.com/auth/drive', `${DRIVE_SCOPE} openid`, `${DRIVE_SCOPE} ${DRIVE_SCOPE}`]) {
    const mock = service(f, { token: json({ access_token: 'fixture-only-access-token', token_type: 'Bearer', expires_in: 3600, scope }) });
    await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher }), { code: 'DRIVE_SCOPE_INVALID' });
    assert.equal(mock.calls.length, 1);
  }
});

test('public or domain-wide folder permissions and unsupported shared-drive targets prevent upload creation', async t => {
  const f = await fixture(t);
  for (const type of ['anyone', 'domain', 'unknown']) {
    const mock = service(f, { permissions: json({ permissions: [{ id: 'broad', type, role: 'reader' }] }) });
    await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher }), { code: 'DRIVE_FOLDER_SHARING_UNSAFE' });
    assert.equal(mock.calls.some(call => call.url.includes('/upload/')), false);
  }
  const mock = service(f, { folder: json({ id: FOLDER, mimeType: 'application/vnd.google-apps.folder', trashed: false, driveId: 'shared-drive', capabilities: { canAddChildren: true } }) });
  await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher }), { code: 'DRIVE_FOLDER_INVALID' });
});

test('extra users, groups, absent or invalid emails and unsupported roles prevent any upload', async t => {
  const f = await fixture(t);
  const variants = [
    [...PRIVATE_PERMISSIONS, { id: 'extra-user', type: 'user', role: 'reader', emailAddress: 'extra@example.test' }],
    [PRIVATE_PERMISSIONS[0]],
    [{ ...PRIVATE_PERMISSIONS[0], emailAddress: undefined }, PRIVATE_PERMISSIONS[1]],
    [{ ...PRIVATE_PERMISSIONS[0], emailAddress: 'ownér@example.test' }, PRIVATE_PERMISSIONS[1]],
    [{ ...PRIVATE_PERMISSIONS[0], emailAddress: 'owner@example.test ' }, PRIVATE_PERMISSIONS[1]],
    [{ ...PRIVATE_PERMISSIONS[0], type: 'group' }, PRIVATE_PERMISSIONS[1]],
    [{ ...PRIVATE_PERMISSIONS[0], type: undefined }, PRIVATE_PERMISSIONS[1]],
    ...['organizer', 'fileOrganizer', 'unknown', undefined].map(role => [{ ...PRIVATE_PERMISSIONS[0], role }, PRIVATE_PERMISSIONS[1]]),
  ];
  for (const permissions of variants) {
    const mock = service(f, { permissions: json({ permissions }) });
    await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher }), { code: 'DRIVE_FOLDER_SHARING_UNSAFE' });
    assert.equal(mock.calls.some(call => call.url.includes('/upload/')), false);
    assert.equal(mock.calls.some(call => ['PATCH', 'DELETE'].includes(call.options.method)), false);
  }
});

test('every folder and uploaded-file permission page must equal the authorized-person set', async t => {
  const f = await fixture(t), original = service(f); let pageCalls = 0;
  const fetcher = async (url, options) => {
    if (url.includes('/permissions?')) {
      pageCalls++; assert.equal(options.method, 'GET');
      assert.equal(new URL(url).searchParams.get('fields'), 'nextPageToken,permissions(id,type,role,emailAddress)');
      if (!new URL(url).searchParams.has('pageToken')) return json({ nextPageToken: 'fixture-person-page', permissions: [PRIVATE_PERMISSIONS[0]] });
      assert.equal(new URL(url).searchParams.get('pageToken'), 'fixture-person-page');
      return json({ permissions: [PRIVATE_PERMISSIONS[1]] });
    }
    return original.fetcher(url, options);
  };
  assert.equal((await uploadBackup({ file: f.file, env: f.env, fetcher })).status, 'uploaded-and-verified');
  assert.equal(pageCalls, 6); // Folder before and after, then new file; two pages each.
});

test('all permission pages must be inspectable and free of broad sharing before any upload', async t => {
  const f = await fixture(t), original = service(f); let pageCalls = 0;
  const fetcher = async (url, options) => {
    if (url.includes('/permissions?')) {
      pageCalls++;
      if (pageCalls === 1) return json({ nextPageToken: 'fixture-next-page', permissions: [PRIVATE_PERMISSIONS[0]] });
      assert.equal(new URL(url).searchParams.get('pageToken'), 'fixture-next-page');
      return json({ permissions: [{ id: 'domain', type: 'domain', role: 'reader' }] });
    }
    return original.fetcher(url, options);
  };
  await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher }), { code: 'DRIVE_FOLDER_SHARING_UNSAFE' });
  assert.equal(pageCalls, 2);
  assert.equal(original.calls.some(call => call.url.includes('/upload/')), false);
  const hidden = service(f, { permissions: json({ error: { message: 'private diagnostic' } }, 403) });
  await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: hidden.fetcher }), { code: 'DRIVE_METADATA_UNAVAILABLE' });
});

test('a resumable session at an unapproved destination never receives Authorization or file bytes', async t => {
  const f = await fixture(t), mock = service(f, { session: 'https://evil.example/upload?token=fixture' });
  await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher }), { code: 'DRIVE_SESSION_URL_INVALID' });
  assert.ok(mock.calls.every(call => !call.url.includes('evil.example')));
  assert.ok(mock.calls.every(call => call.options.method !== 'PUT'));
});

test('network uncertainty asks the same session for the accepted offset before continuing ciphertext', async t => {
  const f = await fixture(t, { large: true });
  assert.ok(f.bytes.length > DRIVE_UPLOAD_LIMITS.chunk);
  const accepted = 4 * 1024 * 1024;
  const mock = service(f, { chunk({ options, uploadCalls, finished }) {
    if (uploadCalls === 1) throw new Error('fixture secret diagnostic');
    if (uploadCalls === 2) {
      assert.equal(options.headers['Content-Range'], `bytes */${f.bytes.length}`);
      assert.equal(options.body.length, 0);
      return new Response(null, { status: 308, headers: { range: `bytes=0-${accepted - 1}` } });
    }
    assert.equal(options.headers['Content-Range'], `bytes ${accepted}-${f.bytes.length - 1}/${f.bytes.length}`);
    assert.deepEqual(options.body, f.bytes.subarray(accepted));
    return json(finished);
  } });
  assert.equal((await uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher })).status, 'uploaded-and-verified');
  assert.equal(mock.calls.filter(call => call.options.method === 'POST' && call.url.includes('/upload/')).length, 1);
});

test('invalid upload ranges and stalled progress fail instead of skipping or duplicating ciphertext', async t => {
  const f = await fixture(t);
  for (const range of [`bytes=0-${f.bytes.length + 10}`, 'bytes=1-10', 'bytes=0-not-a-number']) {
    const mock = service(f, { chunk: () => new Response(null, { status: 308, headers: { range } }) });
    await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher }), { code: 'DRIVE_UPLOAD_RANGE_INVALID' });
  }
  const stalled = service(f, { chunk: () => new Response(null, { status: 308 }) });
  await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: stalled.fetcher }), { code: 'DRIVE_UPLOAD_STALLED' });
  assert.equal(stalled.calls.filter(call => call.options.method === 'PUT').length, 3);
});

test('wrong remote checksum, wrong parent, changed privacy or an uncertain retry never confirms success', async t => {
  const f = await fixture(t);
  for (const uploaded of [{ md5Checksum: '0'.repeat(32) }, { parents: ['different_folder_1234'] }, { sha256Checksum: '0'.repeat(64) }]) {
    const mock = service(f, { uploaded });
    await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher }), { code: 'DRIVE_UPLOAD_VERIFICATION_FAILED' });
  }
  const privacy = service(f, { postPermissions: json({ permissions: [{ type: 'anyone', role: 'reader' }] }) });
  await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: privacy.fetcher }), { code: 'DRIVE_FOLDER_SHARING_UNSAFE' });
  assert.equal(privacy.calls.some(call => call.options.method === 'DELETE'), false);
  const uncertain = service(f, { chunk() { throw new Error('fixture private response'); } });
  await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: uncertain.fetcher }), { code: 'DRIVE_UPLOAD_OUTCOME_UNCERTAIN' });
});

test('a changed folder person or unapproved person inherited by the new file never confirms a copy', async t => {
  const f = await fixture(t);
  const folderChanged = service(f, { postPermissions: json({ permissions: [PRIVATE_PERMISSIONS[0],
    { ...PRIVATE_PERMISSIONS[1], emailAddress: 'replacement@example.test' }] }) });
  await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: folderChanged.fetcher }), { code: 'DRIVE_FOLDER_SHARING_UNSAFE' });
  assert.equal(folderChanged.calls.filter(call => call.url.includes('/upload/') && call.options.method === 'POST').length, 1);
  assert.equal(folderChanged.calls.some(call => ['PATCH', 'DELETE'].includes(call.options.method)), false);

  for (const permission of [{ ...PRIVATE_PERMISSIONS[1], emailAddress: 'extra@example.test' },
    { ...PRIVATE_PERMISSIONS[1], emailAddress: undefined }, { ...PRIVATE_PERMISSIONS[1], type: 'group' }]) {
    const original = service(f); let filePages = 0;
    const fetcher = async (url, options) => {
      if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${FILE_ID}/permissions?`)) {
        filePages++;
        if (filePages === 1) return json({ nextPageToken: 'fixture-file-person-page', permissions: [PRIVATE_PERMISSIONS[0]] });
        return json({ permissions: [permission] });
      }
      return original.fetcher(url, options);
    };
    await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher }), { code: 'DRIVE_FOLDER_SHARING_UNSAFE' });
    assert.equal(filePages, 2);
    assert.equal(original.calls.filter(call => call.url.includes('/upload/') && call.options.method === 'POST').length, 1);
    assert.equal(original.calls.some(call => ['PATCH', 'DELETE'].includes(call.options.method)), false);
  }
});

test('redirects, oversized responses, hung fetches and private diagnostics stay bounded and redacted', async t => {
  const f = await fixture(t);
  const failures = [
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example/?private=fixture' } }),
    () => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': String(DRIVE_UPLOAD_LIMITS.json + 1) } }),
    () => { throw new Error('PRIVATE_DO_NOT_PRINT https://evil.example/?token=fixture'); },
    () => new Promise(() => {}),
  ];
  for (const responseFailure of failures) {
    const mock = service(f, { responseFailure });
    await assert.rejects(uploadBackup({ file: f.file, env: f.env, fetcher: mock.fetcher, timeoutMs: 20 }), failure => {
      assert.match(failure.code, /^DRIVE_[A-Z_]+$/); assert.doesNotMatch(failure.message, /PRIVATE|https:|token=|fixture/); return true;
    });
    assert.equal(mock.calls.length, 1);
  }
});

test('CLI accepts only an explicit file argument, never secrets on the command line', async () => {
  for (const args of [[], ['--key', 'private'], ['--file', '/path', '--token', 'private']]) await assert.rejects(main(args, ENV), { code: 'DRIVE_ARGUMENT_INVALID' });
});
