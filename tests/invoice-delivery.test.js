import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvoiceFromQuote, invoiceDeliveryStatus, invoiceDeliveryLabel, status, outstanding, alerts,
  validateDocument, validateWorkspace } from '../src/domain.js';
import { defaultViewState, parseViewRoute, applyViewRoute, viewRouteHash, sanitizeViewState,
  writeViewState, readViewState } from '../src/view-state.js';
import { historyFieldLabel, mergeRecordHistory, renderUnifiedHistory, compareWorkspaceEdits,
  renderConflictComparison } from '../src/history-ui.js';

const today = '2026-10-23', options = { today };
const invoice = (extra = {}) => ({ id: 'invoice-1', kind: 'invoice', status: 'issued', number: 'F-2026-008',
  clientId: 'client-1', date: '2026-10-01', dueDate: '2026-11-01',
  items: [{ description: 'Servicio', quantity: 1, price: 100 }], vat: 21, discount: 0, withholding: 0, ...extra });
const workspace = (extra = {}) => ({ company: { name: 'Orquivia' }, clients: [{ id: 'client-1', name: 'Cliente' }],
  documents: [invoice()], payments: [], ...extra });

test('historical invoice delivery stays unknown and drafts remain distinct from issued delivery filters', () => {
  const legacy = invoice(), snapshot = structuredClone(legacy);
  assert.equal(invoiceDeliveryStatus(legacy), 'unknown');
  assert.equal(invoiceDeliveryLabel(legacy), 'Sin indicar');
  assert.equal(invoiceDeliveryStatus(invoice({ deliveryStatus: 'ready' })), 'ready');
  assert.equal(invoiceDeliveryLabel(invoice({ deliveryStatus: 'ready' })), 'Preparada');
  assert.equal(invoiceDeliveryStatus(invoice({ deliveryStatus: 'sent' })), 'sent');
  assert.equal(invoiceDeliveryLabel(invoice({ deliveryStatus: 'sent' })), 'Enviada');
  for (const deliveryStatus of [undefined, 'ready', 'sent']) {
    assert.equal(invoiceDeliveryStatus(invoice({ status: 'draft', deliveryStatus })), 'draft');
    assert.equal(invoiceDeliveryLabel(invoice({ status: 'draft', deliveryStatus })), 'Borrador');
  }
  const rows = [legacy, invoice({ id: 'draft', status: 'draft' }), invoice({ id: 'ready', deliveryStatus: 'ready' })];
  assert.deepEqual(rows.filter(doc => invoiceDeliveryStatus(doc) === 'unknown').map(doc => doc.id), ['invoice-1']);
  assert.deepEqual(legacy, snapshot, 'a label cannot infer or save a historical send');
});

test('delivery changes do not alter outstanding money, payment classification or reminders', () => {
  for (const dueDate of ['2026-11-01', '2026-10-01']) for (const amount of [0, 20, 121]) {
    const doc = invoice({ dueDate });
    const payments = amount ? [{ documentId: doc.id, amount }] : [];
    const expected = { payment: status(doc, payments, today), amount: outstanding(doc, payments), alerts: alerts([doc], payments, today) };
    for (const deliveryStatus of ['ready', 'sent']) {
      const modified = { ...doc, deliveryStatus };
      assert.deepEqual({ payment: status(modified, payments, today), amount: outstanding(modified, payments),
        alerts: alerts([modified], payments, today) }, expected);
    }
  }
  assert.equal(status(invoice({ paymentReviewNeeded: true, deliveryStatus: 'sent' }), [], today), 'review');
});

test('quote conversion starts a separate invoice draft even when its source was sent', () => {
  const quote = invoice({ id: 'quote-1', kind: 'quote', status: 'accepted', number: 'PR-2026-025',
    deliveryStatus: 'sent', billingEmail: 'accounts@example.test', po: 'PO-001' });
  const original = structuredClone(quote);
  const converted = createInvoiceFromQuote(quote, [invoice()], today);
  assert.equal(converted.kind, 'invoice');
  assert.equal(converted.status, 'draft');
  assert.equal(Object.hasOwn(converted, 'deliveryStatus'), false);
  assert.equal(invoiceDeliveryStatus(converted), 'draft');
  assert.equal(converted.quoteId, quote.id);
  assert.notEqual(converted.id, quote.id);
  assert.equal(converted.number, 'F-2026-009');
  assert.equal(converted.billingEmail, 'accounts@example.test');
  assert.equal(converted.po, 'PO-001');
  converted.items[0].description = 'Concepto añadido al facturar';
  assert.deepEqual(quote, original);
});

test('optional billing addresses accept one mailbox and reject lists and header injection on documents and clients', () => {
  for (const billingEmail of [undefined, '', 'accounts@example.test', 'Accounts+invoices@EXAMPLE.test']) {
    assert.deepEqual(validateDocument(invoice({ billingEmail })), []);
    assert.deepEqual(validateWorkspace(workspace({ clients: [{ id: 'client-1', name: 'Cliente', billingEmail }],
      documents: [invoice({ billingEmail })] }), today), []);
  }
  for (const billingEmail of [null, 12, [], {}, 'Name <accounts@example.test>', 'one@example.test,two@example.test',
    'one@example.test;two@example.test', 'accounts@example.test\r\nBcc: hidden@example.test', 'missing-at']) {
    assert.ok(validateDocument(invoice({ billingEmail })).some(error => error.includes('correo de facturación')), String(billingEmail));
    assert.ok(validateWorkspace(workspace({ clients: [{ id: 'client-1', name: 'Cliente', billingEmail }] }), today)
      .some(error => error.includes('clients[0].billingEmail')), String(billingEmail));
  }
  for (const deliveryStatus of ['ready', 'sent']) assert.deepEqual(validateWorkspace(workspace({ documents: [invoice({ deliveryStatus })] }), today), []);
  for (const deliveryStatus of [null, '', 'unknown', 'paid', true]) {
    assert.ok(validateDocument(invoice({ deliveryStatus })).some(error => error.includes('estado de envío')));
  }
  assert.ok(validateDocument(invoice({ kind: 'quote', status: 'ready', deliveryStatus: 'ready' })).some(error => error.includes('estado de envío')));
  assert.ok(validateDocument(invoice({ status: 'draft', deliveryStatus: 'ready' })).some(error => error.includes('estado de envío')));
  assert.ok(validateDocument(invoice({ kind: 'quote', status: 'ready', billingEmail: 'accounts@example.test' })).some(error => error.includes('correo de facturación')));
});

test('invoice delivery and collection filters survive reload independently and explicit all restores browser navigation', () => {
  const rows = new Map(), storage = { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) };
  for (const filter of ['all', 'draft', 'review', 'issued', 'partial', 'overdue', 'paid']) {
    for (const deliveryFilter of ['all', 'ready', 'sent', 'unknown']) {
      const view = { ...defaultViewState(today), page: 'invoices', invoices: { filter, deliveryFilter, query: 'Cliente privado' } };
      writeViewState(storage, 'local', view, options);
      const hash = viewRouteHash(view, options);
      assert.equal(hash, `#facturas?estado=${filter}&envio=${deliveryFilter}`);
      assert.ok(!hash.includes('privado'));
      const restored = applyViewRoute(readViewState(storage, 'local', options), parseViewRoute({ hash }), options);
      assert.deepEqual(restored.invoices, view.invoices);
    }
  }
  const saved = sanitizeViewState({ invoices: { filter: 'paid', deliveryFilter: 'sent', query: 'Cliente' } }, options);
  const all = applyViewRoute(saved, parseViewRoute({ hash: '#facturas?estado=all&envio=all' }), options);
  assert.deepEqual(all.invoices, { filter: 'all', deliveryFilter: 'all', query: 'Cliente' });
  assert.equal(applyViewRoute(saved, parseViewRoute({ hash: '#facturas?estado=paid' }), options).invoices.deliveryFilter, 'all', 'old invoice links remain unfiltered by delivery');
  assert.deepEqual(parseViewRoute({ hash: '#facturas?estado=sent&envio=paid' }), { page: 'invoices', invoices: { deliveryFilter: 'all' } });
  assert.deepEqual(parseViewRoute({ hash: '#presupuestos?estado=sent&envio=ready' }), { page: 'quotes', quotes: { filter: 'sent' } });
});

const audit = (extra = {}) => ({ id: 8, entityType: 'document', entityId: 'invoice-1', action: 'updated',
  event: 'email_sent', actorEmail: 'nicole@example.test', changedFields: ['deliveryStatus'], workspaceVersion: 20,
  createdAt: '2026-10-23T10:00:02Z', ...extra });
const mail = (extra = {}) => ({ id: 'invoice-mail', documentId: 'invoice-1', sender: 'nicole@example.test',
  to: ['accounts@example.test'], cc: ['purchasing@example.test'], subject: 'Factura F-2026-008', status: 'sent',
  sentAt: '2026-10-23T10:00:00Z', createdAt: '2026-10-23T09:59:00Z', ...extra });

test('invoice send history absorbs only its matching delivery-only audit and preserves all other edits and attempts', () => {
  const automatic = audit();
  const preserved = [audit({ id: 9, changedFields: ['deliveryStatus', 'billingEmail'] }),
    audit({ id: 10, event: 'save' }), audit({ id: 11, entityId: 'quote-1' }), audit({ id: 12, actorEmail: 'liliana@example.test' })];
  const timeline = mergeRecordHistory([automatic, ...preserved], [mail()]);
  assert.equal(timeline.length, 5);
  assert.deepEqual(timeline.find(entry => entry.kind === 'mail').stateChange.changedFields, ['deliveryStatus']);
  assert.deepEqual(timeline.filter(entry => entry.kind === 'change').map(entry => entry.historyId).sort((a, b) => a - b), [9, 10, 11, 12]);
  for (const job of [mail({ documentId: '' }), mail({ documentId: 'another-invoice' }), mail({ status: 'uncertain' }),
    mail({ status: 'failed' }), mail({ errorCode: 'SMTP_PARTIAL' })]) {
    assert.equal(mergeRecordHistory([automatic], [job]).length, 2);
  }
  assert.equal(mergeRecordHistory([audit({ entityId: '' })], [mail({ documentId: '' })]).length, 2);
  const html = renderUnifiedHistory([automatic], [mail()]);
  assert.match(html, /Estado de envío/);
  assert.match(html, /Factura F-2026-008/);
  assert.match(html, /accounts@example.test/);
  assert.match(html, /purchasing@example.test/);
  assert.match(html, /versión 20/);
  assert.ok(!html.includes('Documento actualizado'));
});

test('conflict history labels invoice delivery and billing contact separately from payment', () => {
  const base = workspace(), draft = structuredClone(base), current = structuredClone(base);
  draft.documents[0].deliveryStatus = 'ready';
  draft.documents[0].billingEmail = 'billing@example.test';
  current.documents[0].deliveryStatus = 'sent';
  assert.equal(historyFieldLabel('billingEmail'), 'Correo de facturación');
  assert.equal(historyFieldLabel('deliveryStatus'), 'Estado de envío');
  const html = renderConflictComparison(compareWorkspaceEdits(base, draft, current));
  assert.match(html, /Preparada/);
  assert.match(html, /Enviada/);
  assert.match(html, /billing@example.test/);
  assert.match(html, /Estado de envío/);
});
