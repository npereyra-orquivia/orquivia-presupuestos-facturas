import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalBackend, DEFAULT_NOTIFICATIONS, defaultPersonalProfile, validateProfile, validateNotificationPreferences, validatePushSubscription, validateAvatarFile, MAX_AVATAR_BYTES } from '../src/personal-backend.js';

const user = { id: 'c1000000-0000-4000-8000-000000000001' };
const workspace = { organizationId: 'c2000000-0000-4000-8000-000000000001' };
const subscription = () => ({ endpoint: 'https://web.push.apple.com/Qdevice-token', expirationTime: 1000, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });
const photo = (name = 'foto.png', bytes = [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) => Object.assign(new Blob([new Uint8Array(bytes)], { type: 'image/png' }), { name });

test('personal data is a detached, bounded profile and notifications are disabled by default', () => {
  const initial = defaultPersonalProfile(user, workspace);
  assert.equal(initial.notifications.enabled, false);
  initial.notifications.daysBefore = 7;
  assert.equal(DEFAULT_NOTIFICATIONS.daysBefore, 2);
  const original = { displayName: ' Nicole ', notifications: { ...DEFAULT_NOTIFICATIONS }, avatar: { id: 'photo' } };
  const snapshot = validateProfile(original);
  original.avatar.id = 'changed';
  original.notifications.enabled = true;
  assert.equal(snapshot.avatar.id, 'photo');
  assert.equal(snapshot.notifications.enabled, false);
  assert.equal(snapshot.displayName, 'Nicole');
  for (const field of ['daysBefore', 'repeatDays', 'hour']) assert.throws(() => validateNotificationPreferences({ ...DEFAULT_NOTIFICATIONS, [field]: -1 }), { code: 'INVALID_PROFILE' });
  assert.throws(() => validateNotificationPreferences({ ...DEFAULT_NOTIFICATIONS, enabled: 'true' }), { code: 'INVALID_PROFILE' });
  assert.throws(() => validateProfile({ ...snapshot, displayName: 'x\nsecret' }), { code: 'INVALID_PROFILE' });
});

test('push registration refuses arbitrary network targets and incomplete encryption keys', () => {
  const input = subscription();
  const snapshot = validatePushSubscription(input);
  input.keys.auth = 'changed';
  assert.equal(snapshot.keys.auth, 'A'.repeat(22));
  assert.equal(snapshot.expirationTime, null);
  for (const endpoint of ['http://web.push.apple.com/a', 'https://127.0.0.1/a', 'https://web.push.apple.com.evil.test/a', 'https://name:secret@web.push.apple.com/a', 'https://web.push.apple.com/a#fragment', 'https://web.push.apple.com:444/a']) {
    assert.throws(() => validatePushSubscription({ ...subscription(), endpoint }), { code: 'INVALID_PUSH_SUBSCRIPTION' });
  }
  assert.throws(() => validatePushSubscription({ ...subscription(), keys: { p256dh: 'B'.repeat(87), auth: 'short' } }), { code: 'INVALID_PUSH_SUBSCRIPTION' });
});

test('avatar accepts verified raster files only and bounds size before transport', async () => {
  assert.equal((await validateAvatarFile(photo())).mimeType, 'image/png');
  await assert.rejects(validateAvatarFile(photo('foto.svg')), { code: 'INVALID_AVATAR' });
  await assert.rejects(validateAvatarFile(photo('foto.png', [0x3c,0x73,0x76,0x67])), { code: 'INVALID_AVATAR' });
  await assert.rejects(validateAvatarFile({ size: MAX_AVATAR_BYTES + 1 }), { code: 'INVALID_AVATAR' });
});

test('personal requests reject a session switched while the owner-only response is in flight', async () => {
  let current = user;
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const backend = createPersonalBackend({ client: { rpc: () => response }, requireUser: async () => current, getWorkspace: () => workspace });
  const loading = backend.loadProfile();
  await Promise.resolve();
  current = { id: 'c1000000-0000-4000-8000-000000000002' };
  resolve({ data: { displayName: 'Nicole' }, error: null });
  await assert.rejects(loading, { code: 'AUTH_CHANGED' });
});

test('personal RPCs bind reads and writes to the captured user before the SDK can change its JWT', async () => {
  const requests = [];
  const backend = createPersonalBackend({
    client: { rpc: async (name, parameters) => { requests.push({ name, parameters }); return { data: {}, error: null }; } },
    requireUser: async () => user, getWorkspace: () => workspace,
  });
  await backend.loadProfile();
  await backend.saveProfile({ displayName: 'Nicole', avatar: null, notifications: { ...DEFAULT_NOTIFICATIONS } });
  await backend.savePushSubscription(subscription());
  await backend.removePushSubscription(subscription().endpoint);
  await backend.subscriptions();
  for (const request of requests) assert.equal(request.parameters.p_expected_user_id, user.id);
  const rejected = createPersonalBackend({
    client: { rpc: async (_name, parameters) => { assert.equal(parameters.p_expected_user_id, user.id); return { data: null, error: { code: '42501', message: 'AUTH_CHANGED' } }; } },
    requireUser: async () => user, getWorkspace: () => workspace,
  });
  await assert.rejects(rejected.saveProfile({ displayName: 'Old session', avatar: null, notifications: { ...DEFAULT_NOTIFICATIONS } }), { code: 'AUTH_CHANGED' });
});

test('avatar references cannot read a colleague photo and uploads use fresh owner paths', async () => {
  const calls = [];
  const client = { storage: { from: bucket => ({ upload: async (...args) => { calls.push({ bucket, args }); return { error: null }; }, download: async () => { throw new Error('must not run'); } }) } };
  const backend = createPersonalBackend({ client, requireUser: async () => user, getWorkspace: () => workspace });
  const avatar = await backend.uploadAvatar(photo());
  assert.match(avatar.path, new RegExp(`^${workspace.organizationId}/${user.id}/[a-f0-9-]+\\.png$`));
  assert.equal(calls[0].args[2].upsert, false);
  assert.equal(calls[0].args[1].type, 'image/png');
  const colleaguePath = avatar.path.replace(user.id, 'c1000000-0000-4000-8000-000000000002');
  await assert.rejects(backend.downloadAvatar({ ...avatar, path: colleaguePath }), { code: 'INVALID_AVATAR' });
});
