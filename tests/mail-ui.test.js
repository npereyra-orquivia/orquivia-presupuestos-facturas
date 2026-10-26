import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMailLoading, renderMailComposer, renderMailResult, bindMailComposer } from '../src/mail-ui.js';

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

const attachment = { name: 'Justificante.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4\nfixture\n%%EOF') };

test('extra files are an invoice-only action with independent automatic invoice and visible count/size limits', () => {
  const invoice = { ...document, kind: 'invoice', number: 'F-2026-001' };
  const html = renderMailComposer({ document: invoice, profile, draft: { ...draft, attachments: [attachment] } });
  assert.match(html, /data-add-mail-attachments/);assert.match(html, /type="file"[^>]+multiple/);
  assert.match(html, /Hasta 5 archivos/);assert.match(html, /5 MB por archivo/);assert.match(html, /10 MB en total/);
  assert.match(html, /factura-F-2026-001.pdf/);assert.match(html, /Justificante.pdf/);
  assert.match(html, /data-remove-mail-attachment="0"/);
  assert.ok(!renderMailComposer({ document, profile, draft }).includes('data-add-mail-attachments'));
  const history = renderMailResult({ document: invoice, job: { status: 'sent' }, history: [{ status: 'sent', attachments: [{ name: '<img bad>.pdf', size: 1000, raw: 'PRIVATE_BYTES' }] }] });
  assert.match(history, /&lt;img bad&gt;.pdf/);assert.ok(!history.includes('<img bad>'));assert.ok(!history.includes('PRIVATE_BYTES'));
});

function bindingFixture({ readAttachments, existing = [] } = {}) {
  const saved = [], sent = [], feedback = { textContent: '' }, preview = { innerHTML: '' };
  const fileInput = { files: [{ name: 'Fixture.pdf' }], value: 'selected', disabled: false, click() {} };
  const send = { disabled: false, remove() { this.removed = true; } }, add = { disabled: false };
  const list = { innerHTML: '', querySelectorAll: () => [] }, total = { textContent: '' };
  const elements = { to: { value: 'client@example.test' }, cc: { value: '' }, subject: { value: 'Factura' }, message: { value: 'Un mensaje' } };
  const inputs = [...Object.values(elements), fileInput];
  const form = { dataset: {}, elements, addEventListener() {}, removeEventListener() {}, querySelector: () => preview, querySelectorAll: () => inputs };
  const selectors = { '#mail-compose-form': form, '[data-send-mail]': send, '[data-mail-attachments-input]': fileInput,
    '[data-add-mail-attachments]': add, '[data-mail-extra-list]': list, '[data-mail-extra-total]': total, '[data-mail-feedback]': feedback };
  const root = { querySelector: selector => selectors[selector] || null,
    querySelectorAll: selector => selector.startsWith('button:not') ? [send, add, ...inputs] : [] };
  const ctx = { draft: { ...draft, attachments: existing }, profile, document: { kind: 'invoice', number: 'F-2026-001' }, readAttachments,
    onDraftChange: value => saved.push(structuredClone(value)), send: async value => { sent.push(value);return { job: { status: 'sent' } }; } };
  const dispose = bindMailComposer(root, ctx);
  return { ctx, dispose, saved, sent, send, fileInput, feedback, total };
}

test('selection stays local, blocks sending while bytes are read and sends exact files only on the explicit send action', async () => {
  let release;
  const f = bindingFixture({ readAttachments: () => new Promise(resolve => { release = resolve; }) });
  const selecting = f.fileInput.onchange();await Promise.resolve();
  await f.send.onclick();assert.equal(f.sent.length, 0);assert.equal(f.send.disabled, true);
  release([attachment]);await selecting;
  assert.equal(f.sent.length, 0);assert.equal(f.saved.at(-1).attachments[0].bytes.byteLength, attachment.bytes.byteLength);
  await f.send.onclick();assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].attachments[0].contentBase64, Buffer.from(attachment.bytes).toString('base64'));
  assert.equal(f.sent[0].idempotencyKey, draft.idempotencyKey);
  assert.equal(f.sent[0].attachments[0].bytes, undefined);
  f.dispose();
});

test('closing or changing sessions during file reading never updates a draft or starts a send', async () => {
  for (const reason of ['close', 'account']) {
    let release, current = true;
    const f = bindingFixture({ readAttachments: () => new Promise(resolve => { release = resolve; }) });
    f.ctx.isCurrent = () => current;
    const selecting = f.fileInput.onchange();await Promise.resolve();
    if (reason === 'close') f.dispose(); else current = false;
    release([attachment]);await selecting;
    assert.equal(f.saved.length, 0);assert.equal(f.sent.length, 0);
  }
});

test('a rejected attachment batch retains the previous files and displays the reason before sending', async () => {
  const f = bindingFixture({ existing: [attachment], readAttachments: async () => { throw Error('Máximo 5 archivos'); } });
  await f.fileInput.onchange();assert.match(f.feedback.textContent, /Máximo 5/);
  assert.equal(f.saved.length, 0);assert.equal(f.sent.length, 0);assert.equal(f.send.disabled, false);
  f.dispose();
});
