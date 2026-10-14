import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkspace } from '../src/domain.js';
import { prepareRestore } from '../src/security.js';
import { cashSummary, expenseTotals, quarterCSV, quarterlyReport, quarterRange, splitExpenseTotal,
  splitExpenseTotalManual, suggestedExpenseVAT } from '../src/expenses.js';

const TODAY = '2026-10-14';
const EXPENSE_ID = '17b04d52-8e40-4b7b-a858-f726ff809232';
const ATTACHMENT_ID = '45c25293-42d9-4d24-a11e-06612c3f968f';
const ORG_ID = '6aa21be8-c52e-4c8e-a69b-054d04af4d61';
const OTHER_ID = '2e32deba-e082-4bbb-b68c-6f49b5165c20';

function expense(overrides = {}) {
  return { id: EXPENSE_ID, date: '2026-03-31', supplier: 'Proveedor', description: 'Material', category: 'Material',
    base: 100, vatRate: 21, vatAmount: 21, total: 121, vatDeductibleAmount: 0, paymentStatus: 'pending',
    paidDate: null, reference: 'REC-01', notes: '', attachments: [], ...overrides };
}

function invoice(overrides = {}) {
  return { id: 'invoice-1', kind: 'invoice', status: 'issued', number: 'F-2026-001', clientId: 'client-1',
    date: '2026-03-31', dueDate: '2026-04-30', title: 'Servicios', items: [{ description: 'Servicio', quantity: 1, price: 100 }],
    vat: 21, discount: 0, withholding: 0, ...overrides };
}

function workspace(overrides = {}) {
  return { company: { name: 'Orquívia' }, clients: [{ id: 'client-1', name: 'Cliente', taxId: 'NIF-1' }],
    documents: [invoice()], payments: [], ...overrides };
}

function attachment(overrides = {}) {
  return { id: ATTACHMENT_ID, name: 'Ticket.pdf', path: `${ORG_ID}/${EXPENSE_ID}/${ATTACHMENT_ID}.pdf`,
    mimeType: 'application/pdf', size: 230, ...overrides };
}

test('receipt totals and reverse VAT preserve every cent including half-cent boundaries', () => {
  assert.deepEqual(splitExpenseTotal(121, 21), { base: 100, vatAmount: 21, total: 121 });
  assert.deepEqual(splitExpenseTotal(0.03, 21), { base: 0.02, vatAmount: 0.01, total: 0.03 });
  assert.deepEqual(splitExpenseTotal('10,00', 4), { base: 9.62, vatAmount: 0.38, total: 10 });
  assert.deepEqual(splitExpenseTotal(10.1, 0), { base: 10.1, vatAmount: 0, total: 10.1 });
  assert.equal(suggestedExpenseVAT(0.05, 10), 0.01);
  assert.deepEqual(expenseTotals(expense({ base: 0.1, vatAmount: 0.2, total: 0.3 })),
    { base: 0.1, vatAmount: 0.2, total: 0.3, vatDeductibleAmount: 0 });
  assert.throws(() => splitExpenseTotal(100, 101), /porcentaje/);
  for (const value of [NaN, Infinity, '0x10', '', 'invalid']) assert.throws(() => splitExpenseTotal(value, 21), /decimal/);
});

test('manual VAT supports mixed rates and never presumes deductibility', () => {
  assert.deepEqual(splitExpenseTotalManual(115, 15), { base: 100, vatAmount: 15, total: 115 });
  assert.throws(() => splitExpenseTotalManual(100, 101), /IVA/);
  const mixed = expense({ vatAmount: 15, total: 115 });
  assert.deepEqual(validateWorkspace(workspace({ expenses: [mixed] }), TODAY), []);
  assert.equal(quarterlyReport(workspace({ expenses: [mixed] }), 2026, 1).summary.inputVATRecorded, 15);
  assert.equal(quarterlyReport(workspace({ expenses: [mixed] }), 2026, 1).summary.inputVATConfirmed, 0);
  mixed.vatDeductibleAmount = 15;
  assert.equal(quarterlyReport(workspace({ expenses: [mixed] }), 2026, 1).summary.inputVATConfirmed, 15);
});

test('legacy workspaces and backups remain valid without expenses or opening balance', () => {
  const original = workspace();
  assert.deepEqual(validateWorkspace(original, TODAY), []);
  assert.deepEqual(prepareRestore(original, { today: TODAY }), original);
  assert.equal(quarterlyReport(original, 2026, 1).summary.expenseCount, 0);
  const cash = cashSummary(original, TODAY);
  assert.equal(cash.configured, false);
  assert.equal(cash.balance, null);
  assert.equal(cash.forecastBalance, null);
});

test('new backups preserve expense records, source metadata, and manually confirmed VAT', () => {
  const original = workspace({ expenses: [expense({ attachments: [attachment()], vatDeductibleAmount: 10.5 })] });
  const restored = prepareRestore(original, { today: TODAY });
  assert.deepEqual(restored.expenses, original.expenses);
  assert.notEqual(restored.expenses, original.expenses);
});

test('invalid expense amounts, dates, states and duplicates cannot replace a workspace', () => {
  const invalid = [
    { total: 120 }, { base: -1 }, { vatAmount: Infinity }, { total: 0, base: 0, vatAmount: 0 },
    { base: 1.001, vatAmount: 0, total: 1.001 }, { vatDeductibleAmount: 22 }, { vatDeductibleAmount: -1 },
    { date: '2026-02-30' }, { date: '2026-10-15' }, { paymentStatus: 'paid' },
    { paymentStatus: 'pending', paidDate: '2026-03-31' }, { paymentStatus: 'paid', paidDate: '2026-10-15' },
    { supplier: '' }, { supplier: 'A'.repeat(241) }, { description: 'A'.repeat(2001) },
    { reviewNeeded: 'true' }, { vatRate: 100.01 }, { id: EXPENSE_ID.toUpperCase() },
  ];
  for (const change of invalid) {
    assert.ok(validateWorkspace(workspace({ expenses: [expense(change)] }), TODAY).length > 0, JSON.stringify(change));
  }
  assert.match(validateWorkspace(workspace({ expenses: [expense(), expense()] }), TODAY).join(' '), /duplicado/);
  assert.deepEqual(validateWorkspace(workspace({ expenses: [expense({ paymentStatus: 'paid', paidDate: '2026-03-20' })] }), TODAY), []);
});

test('opening balance is signed, paired with a real date, and rejects future dates', () => {
  assert.deepEqual(validateWorkspace(workspace({ company: { name: 'Orquívia', openingBalance: -100.25,
    openingBalanceDate: '2026-04-01' } }), TODAY), []);
  for (const company of [{ openingBalance: 10 }, { openingBalanceDate: '2026-01-01' },
    { openingBalance: 1.001, openingBalanceDate: '2026-01-01' },
    { openingBalance: 10, openingBalanceDate: '2026-10-15' }]) {
    assert.ok(validateWorkspace(workspace({ company: { name: 'Orquívia', ...company } }), TODAY).some((entry) => entry.includes('opening')));
  }
});

test('receipt validation binds paths to UUIDs and rejects unsafe types, oversize, duplicate attachments', () => {
  assert.deepEqual(validateWorkspace(workspace({ expenses: [expense({ attachments: [attachment()] })] }), TODAY), []);
  const invalid = [{ path: `https://example.com/${ATTACHMENT_ID}.pdf` },
    { path: `${ORG_ID}/${OTHER_ID}/${ATTACHMENT_ID}.pdf` }, { path: `${ORG_ID}/${EXPENSE_ID}/${ATTACHMENT_ID}.svg`, mimeType: 'image/svg+xml' },
    { path: `${ORG_ID}/${EXPENSE_ID}/${ATTACHMENT_ID}.html`, mimeType: 'text/html' }, { size: 10 * 1024 * 1024 + 1 },
    { size: 0 }, { size: 1.5 }, { mimeType: 'image/jpeg' }, { name: 'Bad\nname.pdf' }];
  for (const change of invalid) assert.ok(validateWorkspace(workspace({ expenses: [expense({ attachments: [attachment(change)] })] }), TODAY).length, JSON.stringify(change));
  assert.match(validateWorkspace(workspace({ expenses: [expense({ attachments: [attachment(), attachment()] })] }), TODAY).join(' '), /duplicad/);
  for (const [extension, mimeType] of [['heic', 'image/heic'], ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['rtf', 'application/rtf']]) {
    assert.deepEqual(validateWorkspace(workspace({ expenses: [expense({ attachments: [attachment({ path: `${ORG_ID}/${EXPENSE_ID}/${ATTACHMENT_ID}.${extension}`, mimeType })] })] }), TODAY), []);
  }
});

test('quarter boundaries use document dates for tax registers and payment dates for cash', () => {
  const state = workspace({ payments: [{ id: 'payment-1', documentId: 'invoice-1', amount: 121, date: '2026-04-05' }],
    expenses: [expense({ paymentStatus: 'paid', paidDate: '2026-04-06' })] });
  const first = quarterlyReport(state, 2026, 1).summary, second = quarterlyReport(state, 2026, 2).summary;
  assert.equal(first.salesBase, 100);
  assert.equal(first.outputVAT, 21);
  assert.equal(first.expenseBase, 100);
  assert.equal(first.cashReceived, 0);
  assert.equal(first.cashPaid, 0);
  assert.equal(second.invoiceCount, 0);
  assert.equal(second.expenseCount, 0);
  assert.equal(second.cashReceived, 121);
  assert.equal(second.cashPaid, 121);
  assert.deepEqual(quarterRange(2028, 1), { year: 2028, quarter: 1, from: '2028-01-01', to: '2028-03-31' });
  assert.equal(quarterRange(2026, 4).to, '2026-12-31');
  assert.throws(() => quarterRange(2026, 0), /trimestre/);
});

test('quarter export excludes quotes and draft invoices, includes issued invoices only once', () => {
  const state = workspace({ documents: [invoice(), invoice({ id: 'quote-1', kind: 'quote', status: 'accepted', number: 'PR-2026-001' }),
    invoice({ id: 'draft-1', status: 'draft', number: '' })], payments: [{ id: 'wrong', documentId: 'quote-1', amount: 10, date: '2026-03-01' }] });
  const result = quarterlyReport(state, 2026, 1);
  assert.equal(result.summary.invoiceCount, 1);
  assert.equal(result.summary.salesTotal, 121);
  assert.equal(result.summary.cashReceived, 0);
});

test('cash opening balance excludes earlier movements but outstanding invoices use all recorded payments', () => {
  const old = invoice({ id: 'old', number: 'F-2026-001', date: '2026-03-01' });
  const current = invoice({ id: 'current', number: 'F-2026-002', date: '2026-04-01' });
  const review = invoice({ id: 'review', number: 'F-2026-003', date: '2026-04-01', paymentReviewNeeded: true });
  const state = workspace({ company: { name: 'Orquívia', openingBalance: 1000, openingBalanceDate: '2026-04-01' },
    documents: [old, current, review], payments: [{ documentId: old.id, amount: 121, date: '2026-03-31' },
      { documentId: current.id, amount: 20, date: '2026-04-01' }, { documentId: current.id, amount: 10, date: '2026-04-20' }],
    expenses: [expense({ date: '2026-04-01', base: 10, vatAmount: 0, total: 10, paymentStatus: 'paid', paidDate: '2026-04-02' }),
      expense({ id: OTHER_ID, date: '2026-04-01', base: 50, vatAmount: 0, total: 50 })] });
  const result = cashSummary(state, '2026-04-10');
  assert.equal(result.received, 20);
  assert.equal(result.paidExpenses, 10);
  assert.equal(result.balance, 1010);
  assert.equal(result.pendingReceivables, 101);
  assert.equal(result.pendingExpenses, 50);
  assert.equal(result.forecastBalance, 1061);
  assert.equal(result.unconfirmedInvoices, 1);
  assert.equal(cashSummary(state, '2026-03-31').configured, false);
});

test('CSV quotes delimiters/newlines and neutralizes formulas without exporting private paths', () => {
  const state = workspace({ clients: [{ id: 'client-1', name: '=HYPERLINK("unsafe")', taxId: '@evil' }],
    expenses: [expense({ supplier: ' +1+1', notes: 'Texto; con "comillas"\ny línea', attachments: [attachment()] })] });
  const csv = quarterCSV(state, 2026, 1);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=HYPERLINK(""unsafe"")"'));
  assert.ok(csv.includes('"\'@evil"'));
  assert.ok(csv.includes('"\' +1+1"'));
  assert.ok(csv.includes('"Texto; con ""comillas""\ny línea"'));
  assert.ok(csv.includes('"121,00"'));
  assert.ok(csv.includes('Ticket.pdf'));
  assert.ok(!csv.includes(ORG_ID));
});
