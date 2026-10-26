import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMailComposeEntry } from '../src/mail-compose-entry.js';

const defaultDraft = { to: ['default@example.test'], cc: [], subject: 'Presupuesto actual', message: 'Mensaje por defecto' };
const savedDraft = { to: ['chosen@example.test'], cc: ['copy@example.test'], subject: 'Asunto editado', message: 'Mi mensaje completo\ncon cambios.', idempotencyKey: 'existing-id' };
const job = (status, fields = {}) => ({ id: 'existing-id', status, to: ['previous@example.test'], cc: ['other-copy@example.test'], subject: 'Asunto anterior', createdAt: '2026-10-16T10:00:00Z', ...fields });
const neverCreate = () => { throw new Error('A pending attempt must not get a new UUID'); };

test('reopening a completed attempt always preserves its edited content with a new UUID', () => {
  for (const status of ['sent', 'archive_pending', 'failed']) {
    let generated = 0;
    const result = resolveMailComposeEntry({ savedDraft, history: [job(status)], defaultDraft, createId: () => `new-${++generated}` });
    assert.deepEqual(result, { draft: { ...savedDraft, idempotencyKey: 'new-1' }, job: null });
    assert.equal(generated, 1);
  }
});

test('an unsent draft or a result not yet visible in history retains its content and UUID', () => {
  for (const history of [[], [job('sent', { id: 'another-id' })]]) {
    const result = resolveMailComposeEntry({ savedDraft, history, defaultDraft, createId: neverCreate });
    assert.deepEqual(result, { draft: savedDraft, job: null });
  }
});

test('a reset reconstructs a new editable message from defaults and the latest completed metadata', () => {
  for (const status of ['sent', 'archive_pending', 'failed']) {
    const latest = job(status), older = job('sent', { id: 'older', createdAt: '2026-10-15T10:00:00Z' });
    const result = resolveMailComposeEntry({ history: [older, latest], defaultDraft, createId: () => 'new-id' });
    assert.deepEqual(result, { draft: { to: latest.to, cc: latest.cc, subject: latest.subject, message: defaultDraft.message, idempotencyKey: 'new-id' }, job: null });
  }
});

test('without any history or saved draft a fresh UUID always replaces a stale default UUID', () => {
  const result = resolveMailComposeEntry({ defaultDraft: { ...defaultDraft, idempotencyKey: 'stale' }, createId: () => 'new-id' });
  assert.deepEqual(result, { draft: { ...defaultDraft, idempotencyKey: 'new-id' }, job: null });
});

test('any pending, uncertain or partial job blocks new mail even when another draft or successful job is newer', () => {
  for (const blocked of [job('sending'), job('uncertain'), job('sent', { errorCode: 'SMTP_PARTIAL' })]) {
    const history = [job('sent', { id: 'latest-success', createdAt: '2026-10-16T11:00:00Z' }), blocked];
    const result = resolveMailComposeEntry({ savedDraft: { ...savedDraft, idempotencyKey: 'unsent-id' }, history, defaultDraft, createId: neverCreate });
    assert.deepEqual(result, { draft: { ...savedDraft, idempotencyKey: 'unsent-id' }, job: blocked });
  }
});

test('without a saved draft a blocking job retains its original UUID and never generates another', () => {
  for (const status of ['sending', 'uncertain']) {
    const blocked = job(status);
    const result = resolveMailComposeEntry({ history: [blocked], defaultDraft, createId: neverCreate });
    assert.deepEqual(result, { draft: { to: blocked.to, cc: blocked.cc, subject: blocked.subject, message: defaultDraft.message, idempotencyKey: blocked.id }, job: blocked });
  }
});

test('unknown delivery states fail closed without creating a new attempt', () => {
  const blocked = job('not-yet-understood');
  assert.equal(resolveMailComposeEntry({ savedDraft, history: [blocked], defaultDraft, createId: neverCreate }).job.status, blocked.status);
});

test('date order is descending with a stable fallback for equal, missing or invalid dates', () => {
  const late = job('sent', { id: 'late', subject: 'Latest', createdAt: '2026-10-17T10:00:00Z' });
  const old = job('sent', { id: 'old', createdAt: '2026-10-15T10:00:00Z' });
  assert.equal(resolveMailComposeEntry({ history: [old, late], defaultDraft, createId: () => 'new' }).draft.subject, 'Latest');
  for (const dates of [['bad', undefined], ['2026-10-16T10:00:00Z', '2026-10-16T10:00:00Z']]) {
    const first = job('sent', { id: 'first', subject: 'First', createdAt: dates[0] });
    const second = job('sent', { id: 'second', subject: 'Second', createdAt: dates[1] });
    assert.equal(resolveMailComposeEntry({ history: [first, second], defaultDraft, createId: () => 'new' }).draft.subject, 'First');
  }
});

test('the latest blocking result wins and returned data cannot mutate any input', () => {
  const blocked = job('uncertain', { id: 'latest-block', createdAt: '2026-10-17T10:00:00Z' });
  const history = [job('uncertain'), blocked], original = structuredClone({ savedDraft, history, defaultDraft });
  const result = resolveMailComposeEntry({ savedDraft, history, defaultDraft, createId: neverCreate });
  assert.equal(result.job.id, blocked.id);
  result.draft.to.push('new@example.test');result.job.to.push('new@example.test');
  assert.deepEqual({ savedDraft, history, defaultDraft }, original);
});

test('an explicit billing contact replaces completed recipients while retaining edited message and CC', () => {
  for (const status of ['sent', 'archive_pending', 'failed']) {
    for (const saved of [undefined, savedDraft]) {
      const result = resolveMailComposeEntry({ savedDraft: saved, history: [job(status)], defaultDraft,
        preferDefaultRecipients: true, createId: () => 'new-id' });
      assert.deepEqual(result.draft.to, defaultDraft.to);
      assert.deepEqual(result.draft.cc, saved?.cc || job(status).cc);
      assert.equal(result.draft.message, saved?.message || defaultDraft.message);
      assert.equal(result.draft.idempotencyKey, 'new-id');
      assert.equal(result.job, null);
    }
  }
});

test('a preferred billing contact never rewrites an unsent draft or an uncertain attempt', () => {
  const unsent = resolveMailComposeEntry({ savedDraft, history: [], defaultDraft, preferDefaultRecipients: true, createId: neverCreate });
  assert.deepEqual(unsent, { draft: savedDraft, job: null });
  for (const blocked of [job('sending'), job('uncertain'), job('sent', { errorCode: 'SMTP_PARTIAL' })]) {
    const result = resolveMailComposeEntry({ history: [blocked], defaultDraft, preferDefaultRecipients: true, createId: neverCreate });
    assert.deepEqual(result.draft.to, blocked.to);
    assert.equal(result.draft.idempotencyKey, blocked.id);
    assert.deepEqual(result.job, blocked);
  }
});

test('extra attachment bytes stay with an unsent or uncertain attempt but never silently carry into a new send', () => {
  const attached = { ...savedDraft, attachments: [{ name: 'Pedido.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }] };
  for (const status of ['sent', 'archive_pending', 'failed']) {
    const result = resolveMailComposeEntry({ savedDraft: attached, history: [job(status)], defaultDraft, createId: () => 'new-id' });
    assert.deepEqual(result.draft.attachments, []);assert.equal(result.draft.idempotencyKey, 'new-id');
  }
  for (const history of [[], [job('uncertain')], [job('sent', { errorCode: 'SMTP_PARTIAL' })]]) {
    const result = resolveMailComposeEntry({ savedDraft: attached, history, defaultDraft, createId: neverCreate });
    assert.deepEqual(result.draft.attachments[0].bytes, new Uint8Array([1, 2, 3]));
    assert.equal(result.draft.idempotencyKey, attached.idempotencyKey);
  }
  assert.equal(attached.attachments.length, 1);
});
