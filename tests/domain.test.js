import test from 'node:test';
import assert from 'node:assert/strict';
import { todayISO, money, escapeHTML, totals, paidAmount, outstanding, status, alerts,
  nextNumber, sequenceFromNumber, createInvoiceFromQuote, validateDocument, validateWorkspace } from '../src/domain.js';

function invoice(overrides = {}) {
  return { id: 'invoice-1', kind: 'invoice', status: 'issued', number: 'F-2026-001',
    clientId: 'client-1', date: '2026-10-01', dueDate: '2026-10-13',
    items: [{ description: 'Servicio', quantity: 1, price: 100 }],
    discount: 0, vat: 21, withholding: 0, ...overrides };
}

function workspace(overrides = {}) {
  return { company: { name: 'Orquívia', vat: 21, withholding: 0, paymentTerms: 30 },
    clients: [{ id: 'client-1', name: 'Cliente' }], documents: [invoice()], payments: [], ...overrides };
}

test('Madrid date follows local midnight and daylight-saving offsets', () => {
  assert.equal(todayISO(new Date('2026-10-12T22:30:00Z')), '2026-10-13');
  assert.equal(todayISO(new Date('2026-01-01T23:30:00Z')), '2026-01-02');
  assert.equal(todayISO(new Date('2026-06-30T21:59:00Z')), '2026-06-30');
});

test('money and HTML helpers handle user-provided values safely', () => {
  assert.match(money(12345.5), /12\.345,50/);
  assert.match(money(NaN), /0,00/);
  assert.equal(escapeHTML(`<script a="x">O'Neil & hijos</script>`),
    '&lt;script a=&quot;x&quot;&gt;O&#39;Neil &amp; hijos&lt;/script&gt;');
});

test('taxes and withholding apply to the discounted base with exact cents', () => {
  assert.deepEqual(totals(invoice({
    items: [{ description: 'A', quantity: 3, price: 19.99 }, { description: 'B', quantity: 0.5, price: 10 }],
    discount: 10, withholding: 15,
  })), { subtotal: 64.97, discountAmount: 6.5, base: 58.47,
    vatAmount: 12.28, withholdingAmount: 8.77, total: 61.98 });
});

test('line and percentage rounding correctly handle half cents', () => {
  const result = totals(invoice({
    items: [{ quantity: 1, price: '1.005' }, { quantity: 3, price: '0.10' }],
    discount: 0, vat: 0, withholding: 0,
  }));
  assert.equal(result.subtotal, 1.31);
  assert.equal(result.total, 1.31);
  assert.deepEqual(totals(invoice({ items: [{ quantity: '1,5', price: '0,30' }], vat: 10 })),
    { subtotal: 0.45, discountAmount: 0, base: 0.45, vatAmount: 0.05, withholdingAmount: 0, total: 0.5 });
});

test('payment totals exclude unrelated, negative and invalid amounts', () => {
  const doc = invoice();
  const payments = [
    { documentId: doc.id, amount: '30.10' }, { documentId: doc.id, amount: 20.2 },
    { documentId: 'other', amount: 500 }, { documentId: doc.id, amount: -20 },
    { documentId: doc.id, amount: 'invalid' }, { documentId: doc.id, amount: Infinity },
  ];
  assert.equal(paidAmount(doc, payments), 50.3);
  assert.equal(outstanding(doc, payments), 70.7);
  assert.equal(status(doc, payments, '2026-10-13'), 'partial');
  assert.equal(status(doc, payments, '2026-10-14'), 'overdue');
});

test('overpayment clears the outstanding balance and overdue state', () => {
  const doc = invoice();
  const payments = [{ documentId: doc.id, amount: 121.01 }];
  assert.equal(paidAmount(doc, payments), 121.01);
  assert.equal(outstanding(doc, payments), 0);
  assert.equal(status(doc, payments, '2026-12-01'), 'paid');
  assert.deepEqual(alerts([doc], payments, '2026-12-01'), []);
  assert.equal(status(invoice({ status: 'draft' }), payments, '2026-12-01'), 'draft');
});

test('quote states remain independent of invoice payments', () => {
  for (const state of ['draft', 'sent', 'accepted', 'rejected']) {
    assert.equal(status(invoice({ kind: 'quote', status: state }), [], '2026-12-01'), state);
  }
  assert.equal(status(invoice({ kind: 'quote', status: 'unexpected' })), 'draft');
});

test('alerts distinguish due today from overdue and suppress inactive documents', () => {
  const docs = [invoice(), invoice({ id: 'late', dueDate: '2026-10-12' }),
    invoice({ id: 'draft', status: 'draft', dueDate: '2026-09-01' }),
    invoice({ id: 'future', dueDate: '2026-10-14' }),
    invoice({ id: 'bad-date', dueDate: '2026-02-30' })];
  const result = alerts(docs, [], '2026-10-13');
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => [item.documentId, item.type, item.severity]),
    [['late', 'payment', 'danger'], ['invoice-1', 'payment', 'warning']]);
});

test('contract reminders remain visible until receipt is confirmed', () => {
  const quote = invoice({ id: 'quote-1', kind: 'quote', status: 'accepted', number: 'PR-2026-001',
    contractExpectedDate: '2026-10-10', contractReceived: false });
  const result = alerts([quote], [], '2026-10-13');
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'contract');
  assert.equal(result[0].severity, 'danger');
  assert.deepEqual(alerts([{ ...quote, contractReceived: true }], [], '2026-10-13'), []);
  assert.deepEqual(alerts([{ ...quote, status: 'rejected' }], [], '2026-10-13'), []);
  assert.deepEqual(alerts([{ ...quote, status: 'draft' }], [], '2026-10-13'), []);
});

test('a linked invoice shares the active quote contract reminder but keeps its payment alert', () => {
  const quote = invoice({ id: 'quote-1', kind: 'quote', status: 'accepted', number: 'PR-2026-001',
    contractExpectedDate: '2026-10-10', contractReceived: false });
  const linkedInvoice = invoice({ quoteId: quote.id,
    contractExpectedDate: quote.contractExpectedDate, contractReceived: false });
  for (const quoteStatus of ['sent', 'accepted']) {
    const result = alerts([{ ...quote, status: quoteStatus }, linkedInvoice], [], '2026-10-13');
    assert.deepEqual(result.map((item) => [item.documentId, item.type]),
      [['quote-1', 'contract'], ['invoice-1', 'payment']]);
  }
  for (const quoteStatus of ['draft', 'rejected']) {
    const result = alerts([{ ...quote, status: quoteStatus }, linkedInvoice], [], '2026-10-13');
    assert.deepEqual(result.map((item) => [item.documentId, item.type]),
      [['invoice-1', 'contract'], ['invoice-1', 'payment']]);
  }
  const differentDate = alerts([quote, { ...linkedInvoice, contractExpectedDate: '2026-10-11' }], [], '2026-10-13');
  assert.equal(differentDate.filter((item) => item.type === 'contract').length, 2);
  const receivedQuote = alerts([{ ...quote, contractReceived: true }, linkedInvoice], [], '2026-10-13');
  assert.equal(receivedQuote.filter((item) => item.type === 'contract').length, 1);
  assert.equal(receivedQuote.find((item) => item.type === 'contract').documentId, linkedInvoice.id);
});

test('numbering uses the highest existing number for each type and year', () => {
  const documents = [{ kind: 'invoice', number: 'F-2026-001' }, { kind: 'invoice', number: 'F-2026-005' }, { kind: 'invoice', number: 'F-2026-005' },
    { kind: 'quote', number: 'PR-2026-010' }, { kind: 'invoice', number: 'F-2025-800' }, { kind: 'invoice', number: 'F-2026-invalid' }];
  assert.equal(nextNumber('invoice', documents, 2026), 'F-2026-006');
  assert.equal(nextNumber('quote', documents, 2026), 'PR-2026-011');
  assert.equal(nextNumber('invoice', documents, 2027), 'F-2027-001');
  assert.equal(nextNumber('quote', [{ kind: 'quote', number: 'PR-2026-999' }], 2026), 'PR-2026-1000');
});

test('invoice conversion copies a quote without mutating it and adds 30 calendar days', () => {
  const quote = invoice({ id: 'quote-1', kind: 'quote', status: 'accepted', number: 'PR-2026-003',
    notes: 'Texto original', contractReceived: true });
  const converted = createInvoiceFromQuote(quote, [{ kind: 'invoice', number: 'F-2026-004' }], '2026-12-15');
  assert.notEqual(converted.id, quote.id);
  assert.match(converted.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(converted.kind, 'invoice');
  assert.equal(converted.status, 'draft');
  assert.equal(converted.number, 'F-2026-005');
  assert.equal(converted.date, '2026-12-15');
  assert.equal(converted.dueDate, '2027-01-14');
  assert.equal(converted.quoteId, quote.id);
  assert.equal(converted.notes, quote.notes);
  converted.items[0].description = 'Modificado';
  assert.equal(quote.items[0].description, 'Servicio');
  assert.equal(quote.kind, 'quote');
});

test('validation rejects invalid calendar dates, rates and malformed line items', () => {
  assert.deepEqual(validateDocument(invoice()), []);
  const errors = validateDocument(invoice({ clientId: '', number: '', date: '2026-02-30',
    dueDate: 'not-a-date', contractExpectedDate: '2026-04-31', vat: 101, discount: -1,
    withholding: 'oops', items: [{ description: '', quantity: 0, price: -2 }] }));
  assert.equal(errors.length, 11);
  assert.ok(errors.some((item) => item.includes('emisión válida')));
  assert.ok(errors.some((item) => item.includes('contrato')));
  assert.ok(validateDocument(invoice({ dueDate: '2026-09-30' })).some((item) => item.includes('anterior')));
  assert.deepEqual(validateDocument(invoice({ date: '2024-02-29', dueDate: '2024-03-01' })), []);
  assert.ok(validateDocument(invoice({ items: [] })).length > 0);
  assert.ok(validateDocument(invoice({ items: [{ description: 'X', quantity: Infinity, price: NaN }] })).length > 0);
});

test('historical documents with unknown payment evidence are reviewed instead of marked unpaid', () => {
  const imported = invoice({ number: '2026-002', date: '2026-06-30', dueDate: '2026-07-30', paymentReviewNeeded: true });
  assert.equal(status(imported, [], '2026-10-14'), 'review');
  assert.equal(status(imported, [{ documentId: imported.id, amount: 121 }], '2026-10-14'), 'review');
  assert.deepEqual(alerts([imported], [], '2026-10-14').map((item) => [item.type, item.date, item.severity]),
    [['review', '2026-06-30', 'warning']]);
  assert.equal(status({ ...imported, paymentReviewNeeded: false }, [], '2026-10-14'), 'overdue');
  assert.equal(status({ ...imported, paymentReviewNeeded: false }, [{ documentId: imported.id, amount: 121 }], '2026-10-14'), 'paid');
  assert.equal(status({ ...imported, status: 'draft' }, [], '2026-10-14'), 'draft');
  assert.deepEqual(alerts([{ ...imported, status: 'draft' }], [], '2026-10-14'), []);
  assert.equal(status({ ...imported, kind: 'quote', status: 'sent' }, [], '2026-10-14'), 'sent');
});

test('original annual numbers seed separate invoice and quote sequences without rewriting originals', () => {
  const documents = [{ kind: 'invoice', number: '2026-001' }, { kind: 'invoice', number: '2026-002' },
    { kind: 'quote', number: '2026-003' }, { kind: 'invoice', number: '2025-999' },
    { kind: 'quote', number: 'F-2026-800' }, { kind: 'invoice', number: 'PR-2026-900' }];
  const original = structuredClone(documents);
  assert.equal(nextNumber('invoice', documents, 2026), 'F-2026-003');
  assert.equal(nextNumber('quote', documents, 2026), 'PR-2026-004');
  assert.equal(nextNumber('invoice', documents, 2027), 'F-2027-001');
  assert.deepEqual(documents, original);
  assert.equal(sequenceFromNumber('invoice', '2026-002', 2026), 2);
  assert.equal(sequenceFromNumber('quote', 'pr-2026-003', '2026'), 3);
  assert.equal(sequenceFromNumber('quote', 'F-2026-003', 2026), null);
  assert.equal(sequenceFromNumber('invoice', '2025-002', 2026), null);
  assert.equal(sequenceFromNumber('invoice', '2026-000', 2026), null);
  assert.equal(sequenceFromNumber('invoice', '2026-9007199254740992', 2026), null);
  assert.throws(() => nextNumber('invoice', [{ kind: 'invoice', number: '2026-9007199254740991' }], 2026), /límite/);
});

test('workspace import preserves evidence, comments and nullable validity without changing data', () => {
  const importedQuote = invoice({ id: 'quote-1', kind: 'quote', status: 'sent', number: '2026-003', dueDate: null,
    po: 'SA01P103213', notes: 'Comentario libre', importWarnings: ['La validez original era anterior a la emisión.'],
    sourceMetadata: { originalValidityDate: '2026-02-30', originalTotals: { total: 121.02 }, paymentStatusEvidence: 'unknown' } });
  const importedInvoice = invoice({ number: '2026-002', paymentReviewNeeded: true, total: 121,
    companySnapshot: { name: 'Orquívia' }, clientSnapshot: { name: 'Cliente' } });
  const data = workspace({ documents: [importedQuote, importedInvoice] });
  const snapshot = structuredClone(data);
  assert.deepEqual(validateWorkspace(data, '2026-10-14'), []);
  assert.deepEqual(data, snapshot);
  assert.deepEqual(validateWorkspace(workspace({ documents: [invoice({ status: 'draft', number: '' })] }), '2026-10-14'), []);
  assert.deepEqual(validateDocument(invoice({ status: 'draft', number: '' })), []);
  assert.ok(validateDocument(invoice({ number: '' })).some((error) => error.includes('número')));
});

test('workspace validation rejects malformed types, excessive precision and unsafe money totals', () => {
  assert.deepEqual(validateWorkspace(workspace(), '2026-10-14'), []);
  const malformed = workspace({ documents: [invoice({ clientId: 1, vat: '21',
    items: [{ description: 123, quantity: 0.0001, price: 12.345 }], paymentReviewNeeded: 'true' })] });
  const errors = validateWorkspace(malformed, '2026-10-14');
  for (const path of ['clientId', 'vat', 'description', 'quantity', 'price', 'paymentReviewNeeded']) {
    assert.ok(errors.some((error) => error.includes(path)), path);
  }
  const taxOverflow = invoice({ items: [{ description: 'Importe elevado', quantity: 1, price: 80_000_000_000_000 }], vat: 21 });
  assert.ok(validateDocument(taxOverflow).some((error) => error.includes('límite')));
  assert.ok(validateWorkspace(workspace({ documents: [invoice({ total: 121.01 })] }), '2026-10-14').some((error) => error.includes('total calculado')));
  const nonJSON = workspace();
  nonJSON.sourceMetadata = { amount: Infinity, callback: () => {} };
  assert.ok(validateWorkspace(nonJSON, '2026-10-14').some((error) => error.includes('JSON')));
  assert.ok(validateWorkspace(nonJSON, '2026-10-14').some((error) => error.includes('finito')));
});

test('workspace validation catches real calendar errors and impossible payment statuses', () => {
  const data = workspace({ documents: [invoice({ status: 'paid' })],
    payments: [{ id: 'payment-1', documentId: 'invoice-1', amount: 50, date: '2026-02-30' }] });
  const errors = validateWorkspace(data, '2026-10-14');
  assert.ok(errors.some((error) => error.includes('fecha de cobro')));
  assert.ok(errors.some((error) => error.includes('estado pagado')));
  assert.ok(validateWorkspace(workspace({ documents: [invoice({ status: 'partial' })] }), '2026-10-14').some((error) => error.includes('estado parcial')));
  assert.ok(validateWorkspace(workspace({ documents: [invoice({ status: 'overdue', dueDate: '2026-10-14' })] }), '2026-10-14').some((error) => error.includes('estado vencido')));
  const futurePayment = { id: 'payment-1', documentId: 'invoice-1', amount: 121, date: '2026-10-15' };
  assert.ok(validateWorkspace(workspace({ payments: [futurePayment] }), '2026-10-14').some((error) => error.includes('futuro')));
  const fractionalPayment = { ...futurePayment, date: '2026-10-14', amount: 0.001 };
  assert.ok(validateWorkspace(workspace({ payments: [fractionalPayment] }), '2026-10-14').some((error) => error.includes('payments[0].amount')));
  assert.ok(validateWorkspace(workspace({ payments: [{ ...futurePayment, date: '2026-10-14', amount: 121.01 }] }), '2026-10-14').some((error) => error.includes('cobros superan')));
  assert.ok(validateWorkspace(workspace({ documents: [invoice({ status: 'draft', number: '' })],
    payments: [{ ...futurePayment, date: '2026-10-14' }] }), '2026-10-14').some((error) => error.includes('factura emitida')));
  assert.deepEqual(validateWorkspace(workspace({ documents: [invoice({ status: 'paid' })],
    payments: [{ ...futurePayment, date: '2026-10-14' }] }), '2026-10-14'), []);
});

test('workspace numbers and IDs are unique while original invoice and quote numbers can coincide', () => {
  const sameNumber = [invoice({ number: '2026-002' }), invoice({ id: 'quote-1', kind: 'quote', status: 'sent', number: '2026-002' })];
  assert.deepEqual(validateWorkspace(workspace({ documents: sameNumber }), '2026-10-14'), []);
  const alias = [invoice({ number: '2026-002' }), invoice({ id: 'invoice-2', number: 'F-2026-002' })];
  assert.ok(validateWorkspace(workspace({ documents: alias }), '2026-10-14').some((error) => error.includes('secuencia anual')));
  assert.ok(validateWorkspace(workspace({ documents: [invoice(), invoice()] }), '2026-10-14').some((error) => error.includes('identificador está duplicado')));
  const payment = { id: 'payment-1', documentId: 'invoice-1', amount: 10, date: '2026-10-14' };
  assert.ok(validateWorkspace(workspace({ payments: [payment, payment] }), '2026-10-14').some((error) => error.includes('payments[1].id')));
});

test('workspace relationships prevent orphaned clients, quotes, payments and multiple invoice conversions', () => {
  const quote = invoice({ id: 'quote-1', kind: 'quote', status: 'accepted', number: 'PR-2026-001' });
  const linkedInvoice = invoice({ quoteId: quote.id });
  assert.deepEqual(validateWorkspace(workspace({ documents: [quote, linkedInvoice] }), '2026-10-14'), []);
  assert.ok(validateWorkspace(workspace({ documents: [linkedInvoice] }), '2026-10-14').some((error) => error.includes('presupuesto existente')));
  assert.ok(validateWorkspace(workspace({ clients: [], documents: [invoice()] }), '2026-10-14').some((error) => error.includes('cliente no existe')));
  assert.ok(validateWorkspace(workspace({ documents: [quote, linkedInvoice, { ...linkedInvoice, id: 'invoice-2', number: 'F-2026-002' }] }), '2026-10-14').some((error) => error.includes('ya tiene una factura')));
  assert.ok(validateWorkspace(workspace({ clients: [{ id: 'client-1', name: 'Primero' }, { id: 'client-2', name: 'Segundo' }],
    documents: [quote, { ...linkedInvoice, clientId: 'client-2' }] }), '2026-10-14').some((error) => error.includes('mismo cliente')));
  assert.ok(validateWorkspace(workspace({ documents: [quote],
    payments: [{ id: 'payment-1', documentId: quote.id, amount: 10, date: '2026-10-14' }] }), '2026-10-14').some((error) => error.includes('factura emitida')));
});
