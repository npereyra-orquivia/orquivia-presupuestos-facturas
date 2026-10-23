import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMailDraft, mailAttachmentName, validateMailDraft } from '../src/mail-domain.js';
import { resolveMailComposeEntry } from '../src/mail-compose-entry.js';
import { renderMailComposer, renderMailResult } from '../src/mail-ui.js';
import { createMailFeature } from '../src/mail-integration.js';
import { createDocumentMailBackend } from '../src/document-mail-backend.js';

const invoice = { id: 'invoice', kind: 'invoice', number: '2026-008', po: 'PO-45008412', status: 'issued', billingEmail: 'invoice-contact@example.test' };
const client = { email: 'quote-contact@example.test', billingEmail: 'accounts@example.test' };
const profile = { connected: true, email: 'sender@example.test', signature: { name: 'Nicole', role: 'Dirección', phone: '+34 600 000 000' } };

test('invoice defaults use its billing contact independently of the quote recipient', () => {
  const before = structuredClone({ invoice, client });
  assert.deepEqual(defaultMailDraft(invoice, client).to, ['invoice-contact@example.test']);
  assert.deepEqual(defaultMailDraft({ ...invoice, billingEmail: '' }, client).to, ['accounts@example.test']);
  assert.deepEqual(defaultMailDraft({ ...invoice, billingEmail: undefined }, { ...client, billingEmail: '' }).to, ['quote-contact@example.test']);
  assert.deepEqual(defaultMailDraft({ ...invoice, kind: 'quote' }, client).to, ['quote-contact@example.test']);
  assert.deepEqual({ invoice, client }, before, 'choosing recipients must not rewrite either document or client');
});

test('invalid legacy billing contacts cannot become recipients or injectable email headers', () => {
  const invalid = 'accounts@example.test\r\nBcc: hidden@example.test';
  assert.deepEqual(defaultMailDraft({ ...invoice, billingEmail: invalid }, { ...client, billingEmail: 'not-an-address' }).to, ['quote-contact@example.test']);
  const missing = defaultMailDraft({ ...invoice, billingEmail: invalid }, { email: '' });
  assert.deepEqual(missing.to, ['']);
  assert.equal(validateMailDraft(missing).ok, false, 'an absent recipient still requires the user to choose one');
});

test('invoice message carries the actual invoice number and optional PO without copying the quote text', () => {
  const value = defaultMailDraft(invoice, client);
  assert.equal(value.subject, 'Factura 2026-008 · Orquívia');
  assert.match(value.message, /Te adjunto la factura 2026-008 para que puedas tramitarla/);
  assert.match(value.message, /Orden de pedido \(PO\): PO-45008412/);
  assert.ok(!value.message.includes('presupuesto'));
  assert.equal(validateMailDraft(value).ok, true);
  assert.ok(!defaultMailDraft({ ...invoice, po: '' }, client).message.includes('Orden de pedido'));
  assert.ok(!defaultMailDraft({ ...invoice, kind: 'quote' }, client).message.includes('Orden de pedido'));
  assert.equal(mailAttachmentName(invoice), 'factura-2026-008.pdf');
});

test('invoice email preview includes the changed recipient, CC, signature, PO, and invoice attachment', () => {
  const draft = { ...defaultMailDraft({ ...invoice, po: '<script>PO</script>' }, client), cc: ['purchasing@example.test'] };
  const html = renderMailComposer({ document: invoice, client, profile, draft });
  assert.match(html, /invoice-contact@example.test/);
  assert.match(html, /purchasing@example.test/);
  assert.match(html, /La factura puede enviarse a una dirección distinta de la del presupuesto/);
  assert.match(html, /factura-2026-008\.pdf/);
  assert.match(html, /Orden de pedido \(PO\): &lt;script&gt;PO&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /Nicole/);
  assert.match(html, /Envíos de esta factura/);
});

test('reopening an invoice after sending preserves edited recipients and message with a fresh attempt', () => {
  const savedDraft = { ...defaultMailDraft(invoice, client), to: ['new-accounts@example.test'], cc: ['copy@example.test'], message: 'Mensaje de factura modificado', idempotencyKey: 'sent-id' };
  const previous = { id: 'sent-id', status: 'sent', to: savedDraft.to, cc: savedDraft.cc, subject: savedDraft.subject };
  const result = resolveMailComposeEntry({ savedDraft, history: [previous], defaultDraft: defaultMailDraft(invoice, client), createId: () => 'new-id' });
  assert.equal(result.job, null);
  assert.deepEqual(result.draft, { ...savedDraft, idempotencyKey: 'new-id' });
  assert.ok(renderMailComposer({ document: invoice, profile, draft: result.draft }).includes('data-send-mail'));
  const pending = resolveMailComposeEntry({ savedDraft, history: [{ ...previous, status: 'uncertain' }], defaultDraft: defaultMailDraft(invoice, client), createId: () => { throw Error('must not create another attempt'); } });
  const html = renderMailResult({ document: invoice, job: pending.job, history: [pending.job] });
  assert.match(html, /Factura 2026-008/);
  assert.ok(!html.includes('data-new-mail'));
  assert.ok(!html.includes('data-send-mail'));
});

function mailHarness({ load = async () => ({ profile, history: [] }), documentNow = () => invoice } = {}) {
  let sends = 0;
  const headers = [], requests = [];
  const modal = { isConnected: true, innerHTML: '', scrollTop: 0,
    classList: { toggle() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [] };
  const feature = createMailFeature({
    getMode: () => 'cloud', getUser: () => ({ id: 'nicole', email: profile.email }), scope: () => () => true,
    getBackend: () => ({ mail: { composer: async id => { requests.push(id); return load(id); }, send: async () => { ++sends; } } }),
    isBusy: () => false, isConflict: () => false,
    header: title => { headers.push(title); return `<h1>${title}</h1>`; },
    openModal: html => { modal.innerHTML = html; }, root: { querySelector: () => modal },
    cleanup() {}, documentFor: documentNow, clientFor: () => client, preview: () => '<p>PDF de factura</p>',
  });
  return { feature, modal, headers, requests, sent: () => sends };
}

test('opening the invoice composer reads only that invoice context and uses its latest billing contact', async () => {
  let release, latest = invoice;
  const response = new Promise(resolve => { release = resolve; });
  const harness = mailHarness({ load: () => response, documentNow: () => latest });
  const opening = harness.feature.openComposer(invoice);
  latest = { ...invoice, billingEmail: 'latest-accounts@example.test' };
  release({ profile, history: [] });
  await opening;
  assert.deepEqual(harness.requests, ['invoice']);
  assert.deepEqual(harness.headers, ['Enviar factura', 'Enviar factura']);
  assert.match(harness.modal.innerHTML, /latest-accounts@example.test/);
  assert.match(harness.modal.innerHTML, /PDF de factura/);
  assert.equal(harness.sent(), 0, 'opening or preparing a message never sends it');
});

test('an invoice with an uncertain delivery reopens its invoice result without enabling another send', async () => {
  const harness = mailHarness({ load: async () => ({ profile, history: [{ id: 'attempt', status: 'uncertain', to: ['accounts@example.test'] }] }) });
  await harness.feature.openComposer(invoice);
  assert.deepEqual(harness.headers, ['Enviar factura', 'Envío de la factura']);
  assert.match(harness.modal.innerHTML, /Envíos de esta factura/);
  assert.ok(!harness.modal.innerHTML.includes('data-send-mail'));
  assert.equal(harness.sent(), 0);
});

test('a converted invoice has its own recipients and delivery history independently of its source quote', async () => {
  const quote = { id: 'quote', kind: 'quote', number: 'PR-2026-006', status: 'accepted' };
  const converted = { ...invoice, sourceQuoteId: quote.id };
  let latest = quote;
  const harness = mailHarness({
    documentNow: () => latest,
    load: async id => ({ profile, history: id === quote.id
      ? [{ id: 'quote-mail', status: 'sent', to: ['quote-only@example.test'], subject: 'Presupuesto especial' }]
      : [{ id: 'invoice-mail', status: 'sent', to: ['accounts-only@example.test'], cc: ['invoice-copy@example.test'], subject: 'Factura para contabilidad' }] }),
  });
  await harness.feature.openComposer(quote);
  assert.match(harness.modal.innerHTML, /quote-only@example.test/);
  assert.ok(!harness.modal.innerHTML.includes('invoice-copy@example.test'));
  latest = converted;
  await harness.feature.openComposer(converted);
  assert.deepEqual(harness.requests, [quote.id, converted.id]);
  assert.match(harness.modal.innerHTML, /name="to"[^>]+value="invoice-contact@example.test"/);
  assert.match(harness.modal.innerHTML, /accounts-only@example.test/);
  assert.match(harness.modal.innerHTML, /invoice-copy@example.test/);
  assert.match(harness.modal.innerHTML, /Factura para contabilidad/);
  assert.ok(!harness.modal.innerHTML.includes('quote-only@example.test'));
  assert.ok(!harness.modal.innerHTML.includes('Presupuesto especial'));
  assert.equal(harness.sent(), 0);
});

test('changing a saved invoice billing contact invalidates the old draft and rechecks history before reopening', async () => {
  let latest = invoice;
  const previous = { id: 'previous', status: 'sent', to: ['previous-recipient@example.test'], cc: ['copy@example.test'], subject: 'Factura enviada' };
  const harness = mailHarness({ documentNow: () => latest, load: async () => ({ profile, history: [previous] }) });
  await harness.feature.openComposer(invoice);
  latest = { ...invoice, billingEmail: 'changed-billing@example.test' };
  harness.feature.forgetDraft(invoice.id);
  await harness.feature.openComposer(latest);
  assert.deepEqual(harness.requests, [invoice.id, invoice.id], 'editing a billing contact must invalidate cached delivery context');
  assert.match(harness.modal.innerHTML, /name="to"[^>]+value="changed-billing@example.test"/);
  assert.match(harness.modal.innerHTML, /previous-recipient@example.test/, 'the original delivery remains visible in history');
  assert.equal(harness.sent(), 0);
});

test('changing billing metadata cannot clear a pending delivery or authorize a second invoice send', async () => {
  for (const pending of [
    { id: 'pending', status: 'sending' }, { id: 'pending', status: 'uncertain' },
    { id: 'pending', status: 'sent', errorCode: 'SMTP_PARTIAL' },
  ]) {
    let latest = invoice;
    const harness = mailHarness({ documentNow: () => latest, load: async () => ({ profile, history: [{ ...pending, to: ['previous-recipient@example.test'] }] }) });
    await harness.feature.openComposer(invoice);
    latest = { ...invoice, billingEmail: 'changed-billing@example.test' };
    harness.feature.forgetDraft(invoice.id);
    await harness.feature.openComposer(latest);
    assert.ok(!harness.modal.innerHTML.includes('data-send-mail'));
    assert.ok(!harness.modal.innerHTML.includes('data-new-mail'));
    assert.match(harness.modal.innerHTML, /previous-recipient@example.test/);
    assert.equal(harness.sent(), 0);
  }
});

test('sending an invoice binds its own ID and billing recipients while adopting the returned workspace version', async () => {
  let adopted;
  const calls = [];
  const workspace = { state: { documents: [invoice] }, version: 8 };
  const mail = createDocumentMailBackend({
    client: { functions: { invoke: async (name, args) => {
      calls.push({ name, ...args });
      return { data: { job: { id: 'invoice-attempt', status: 'sent' }, workspace }, error: null };
    } } },
    requireUser: async () => ({ id: 'nicole' }), getWorkspace: () => ({ organizationId: 'orquivia' }),
    getVersion: () => 7, enqueue: action => action(), adoptWorkspace: result => { adopted = result; },
  });
  const fields = { ...defaultMailDraft(invoice, client), cc: ['purchasing@example.test'], idempotencyKey: 'invoice-attempt' };
  await mail.send(invoice.id, fields);
  assert.deepEqual(calls, [{ name: 'document-mail', body: {
    ...fields, documentId: invoice.id, action: 'send', expectedWorkspaceVersion: 7,
    expectedUserId: 'nicole', organizationId: 'orquivia',
  } }]);
  assert.deepEqual(adopted, workspace);
});
