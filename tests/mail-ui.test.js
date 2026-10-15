import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMailLoading, renderMailComposer, renderMailResult } from '../src/mail-ui.js';

const document = { id: 'quote', kind: 'quote', number: 'PR-2026-001' };
const profile = { connected: true, email: 'sender@example.test', signature: { name: 'Persona de prueba', role: 'Dirección', phone: '' } };
const draft = { to: ['client@example.test'], cc: [], subject: 'Presupuesto', message: 'Hola,\nAdjunto el documento.', idempotencyKey: 'original' };

test('sent and failed attempts expose an explicit new-send action without an old Send button', () => {
  for (const status of ['sent', 'archive_pending', 'failed']) {
    const job = { id: 'original', status, to: draft.to, subject: draft.subject };
    for (const html of [renderMailResult({ document, job, history: [job] }), renderMailComposer({ document, profile, draft, job })]) {
      assert.ok(html.includes('data-new-mail'));
      assert.ok(!html.includes('data-send-mail'));
      assert.ok(html.includes('data-refresh-mail'));
    }
  }
  const html = renderMailComposer({ document, profile, draft });
  assert.match(html, /type="button"[^>]+data-send-mail/);
  assert.ok(!html.includes('data-new-mail'));
});

test('only a confirmed sent-and-archived job displays the success confirmation', () => {
  assert.match(renderMailResult({ document, job: { status: 'sent' } }), /Correo enviado correctamente/);
  for (const status of ['archive_pending', 'failed', 'sending', 'uncertain']) {
    const html = renderMailResult({ document, job: { id: 'job', status } });
    assert.ok(!html.includes('Correo enviado correctamente'));
    assert.equal(html.includes('data-retry-archive'), status === 'archive_pending');
    if (['sending', 'uncertain'].includes(status)) assert.ok(!html.includes('data-new-mail'));
  }
  const partial = renderMailResult({ document, job: { status: 'uncertain', errorCode: 'SMTP_PARTIAL' } });
  assert.match(partial, /Envío parcial · por revisar/);
  assert.ok(!partial.includes('data-new-mail'));
  assert.ok(!renderMailResult({ document, job: { status: 'sent', errorCode: 'SMTP_PARTIAL' } }).includes('data-new-mail'));
});

test('loading is accessible and result metadata cannot inject executable markup', () => {
  const loader = renderMailLoading();
  assert.match(loader, /role="status"/);
  assert.match(loader, /aria-live="polite"/);
  assert.match(loader, /mail-loading-spinner/);
  const html = renderMailResult({ document: { ...document, number: '<script>bad</script>' },
    job: { status: 'sent' }, history: [{ status: 'sent', to: ['<img src=x onerror=bad()>'], subject: '<script>bad</script>' }] });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
});
