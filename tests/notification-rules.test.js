import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationCandidates, notificationPreferences, shouldRemindOn, privatePushPayload, notificationDeliveryHour } from '../src/notification-rules.js';
import { sameSecret, trustedPushEndpoint, validPushSubscription, validVapidConfiguration } from '../supabase/functions/_shared/push-security.js';

const preferences = { enabled: true, payment: true, contract: true, review: true, daysBefore: 2, onDueDate: true, repeatDays: 2, hour: 9 };
const invoice = (overrides = {}) => ({
  id: 'invoice-1', kind: 'invoice', status: 'issued', number: 'F-2026-001', date: '2026-10-10', dueDate: '2026-10-16',
  items: [{ quantity: 1, price: 100 }], vat: 21, withholding: 0, ...overrides,
});
const state = (documents, payments = []) => ({ documents, payments });

test('personal reminders opt out by default and ignore invalid preference values', () => {
  assert.equal(notificationPreferences().enabled, false);
  assert.equal(notificationPreferences({ enabled: 'true', daysBefore: -1, repeatDays: 31, hour: 99 }).enabled, false);
  assert.equal(notificationPreferences({ daysBefore: 0, repeatDays: 0, hour: 0 }).repeatDays, 0);
  assert.deepEqual(notificationCandidates(state([invoice()]), {}, '2026-10-14'), []);
});

test('advance, due-day and repeated follow-ups obey independent personal settings', () => {
  assert.equal(shouldRemindOn('2026-10-16', preferences, '2026-10-14'), true);
  assert.equal(shouldRemindOn('2026-10-16', preferences, '2026-10-15'), false);
  assert.equal(shouldRemindOn('2026-10-16', preferences, '2026-10-16'), true);
  assert.equal(shouldRemindOn('2026-10-16', preferences, '2026-10-17'), false);
  assert.equal(shouldRemindOn('2026-10-16', preferences, '2026-10-18'), true);
  assert.equal(shouldRemindOn('2026-10-16', { ...preferences, onDueDate: false }, '2026-10-16'), false);
  assert.equal(shouldRemindOn('2026-10-16', { ...preferences, repeatDays: 0 }, '2026-10-18'), false);
  assert.equal(shouldRemindOn('2026-02-30', preferences, '2026-03-02'), false);
});

test('calendar day repeats survive DST and reminders use Madrid delivery hours', () => {
  assert.equal(shouldRemindOn('2026-10-24', preferences, '2026-10-26'), true);
  assert.equal(shouldRemindOn('2026-03-28', preferences, '2026-03-30'), true);
  assert.equal(notificationDeliveryHour(new Date('2026-10-24T07:00:00Z')), 9);
  assert.equal(notificationDeliveryHour(new Date('2026-10-26T08:00:00Z')), 9);
});

test('paid and draft invoices never send payment reminders, unresolved imports send review only', () => {
  assert.equal(notificationCandidates(state([invoice()]), preferences, '2026-10-14').length, 1);
  assert.equal(notificationCandidates(state([invoice()], [{ documentId: 'invoice-1', amount: 121 }]), preferences, '2026-10-14').length, 0);
  assert.equal(notificationCandidates(state([invoice({ status: 'draft' })]), preferences, '2026-10-14').length, 0);
  const reviewed = notificationCandidates(state([invoice({ paymentReviewNeeded: true })]), preferences, '2026-10-14');
  assert.deepEqual(reviewed.map((entry) => entry.type), ['review']);
  assert.deepEqual(notificationCandidates(state([invoice({ paymentReviewNeeded: true })]), { ...preferences, review: false }, '2026-10-14'), []);
});

test('linked quote/invoice contracts produce one reminder and received contracts produce none', () => {
  const quote = { ...invoice(), id: 'quote-1', kind: 'quote', status: 'accepted', contractExpectedDate: '2026-10-16' };
  const linked = invoice({ quoteId: 'quote-1', contractExpectedDate: '2026-10-16', dueDate: '' });
  assert.deepEqual(notificationCandidates(state([quote, linked]), preferences, '2026-10-14').map((entry) => entry.type), ['contract']);
  assert.equal(notificationCandidates(state([{ ...quote, contractReceived: true }]), preferences, '2026-10-14').length, 0);
  assert.equal(notificationCandidates(state([{ ...quote, status: 'rejected' }]), preferences, '2026-10-14').length, 0);
});

test('lock-screen payload exposes no financial values or document identity', () => {
  assert.deepEqual(privatePushPayload('2026-10-14', 2), { kind: 'orquivia-reminder', day: '2026-10-14', count: 2, url: './?view=alerts' });
  assert.throws(() => privatePushPayload('2026-02-30', 2));
  assert.throws(() => privatePushPayload('2026-10-14', 0));
});

test('push endpoint allowlist blocks arbitrary hosts, credential URLs, ports and redirects targets', () => {
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/token', 'https://updates.push.services.mozilla.com/wpush/v2/token', 'https://web.push.apple.com/token', 'https://wns2-by3p.notify.windows.com/w/?token=test']) assert.equal(trustedPushEndpoint(endpoint), true, endpoint);
  for (const endpoint of ['http://fcm.googleapis.com/token', 'https://localhost/token', 'https://169.254.169.254/token', 'https://fcm.googleapis.com.evil.example/token', 'https://evilpush.apple.com/token', 'https://user:pass@web.push.apple.com/token', 'https://web.push.apple.com:8080/token', 'https://web.push.apple.com/token#fragment']) assert.equal(trustedPushEndpoint(endpoint), false, endpoint);
});

test('subscription encryption keys and server VAPID secrets have strict lengths', () => {
  const publicBytes = new Uint8Array(65); publicBytes[0] = 4;
  const encoded = (bytes) => Buffer.from(bytes).toString('base64url');
  const key = encoded(publicBytes);
  const privateKey = encoded(new Uint8Array(32));
  const subscription = { endpoint: 'https://web.push.apple.com/token', expirationTime: null, keys: { p256dh: key, auth: encoded(new Uint8Array(16)) } };
  assert.equal(validPushSubscription(subscription), true);
  assert.equal(validPushSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'invalid' } }), false);
  assert.equal(validVapidConfiguration(key, privateKey, 'mailto:npereyra@orquivia.com'), true);
  assert.equal(validVapidConfiguration(key, privateKey, 'http://localhost'), false);
});

test('cron secret comparison does not accept partial or different secrets', async () => {
  assert.equal(await sameSecret('secret-value', 'secret-value'), true);
  assert.equal(await sameSecret('secret', 'secret-value'), false);
  assert.equal(await sameSecret('secret-value!', 'secret-value'), false);
});
