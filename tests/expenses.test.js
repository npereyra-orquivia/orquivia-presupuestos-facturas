import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkspace } from '../src/domain.js';
import { prepareRestore } from '../src/security.js';
import { cashSummary, expenseTotals, quarterCSV, quarterlyReport, quarterRange, splitExpenseTotal,
  splitExpenseTotalManual, suggestedExpenseVAT, periodRange, periodReport, reportCSV, expenseCashAmount } from '../src/expenses.js';

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
    { supplier: null }, { supplier: 'A'.repeat(241) }, { description: 'A'.repeat(2001) },
    { reviewNeeded: 'true' }, { vatRate: 100.01 }, { id: EXPENSE_ID.toUpperCase() },
  ];
  for (const change of invalid) {
    assert.ok(validateWorkspace(workspace({ expenses: [expense(change)] }), TODAY).length > 0, JSON.stringify(change));
  }
  assert.match(validateWorkspace(workspace({ expenses: [expense(), expense()] }), TODAY).join(' '), /duplicado/);
  assert.deepEqual(validateWorkspace(workspace({ expenses: [expense({ paymentStatus: 'paid', paidDate: '2026-03-20' })] }), TODAY), []);
});

test('quick receipt capture allows no supplier while unreviewed VAT cannot confirm tax amounts', () => {
  const quick = expense({ supplier: '', base: 121, vatAmount: 0, vatRate: undefined, vatReviewNeeded: true });
  const state = workspace({ expenses: [quick] });
  assert.deepEqual(validateWorkspace(state, TODAY), []);
  delete quick.supplier;
  assert.deepEqual(validateWorkspace(state, TODAY), []);
  assert.deepEqual(expenseTotals(quick), { base: null, vatAmount: null, total: 121, vatDeductibleAmount: null, vatReviewNeeded: true });
  const summary = periodReport(state, { type: 'all' }).summary;
  assert.equal(summary.expenseTotal, 121);
  assert.equal(summary.expenseBase, 0);
  assert.equal(summary.inputVATRecorded, 0);
  assert.equal(summary.inputVATConfirmed, 0);
  assert.equal(summary.vatReviewCount, 1);
  assert.equal(summary.vatReviewTotal, 121);
  assert.equal(summary.reviewCount, 1);
  assert.equal(summary.activityDifference, null);
  const csv = reportCSV(state, { type: 'all' });
  assert.match(csv, /"Material";"";"";"0,00";"121,00";""/);
  assert.match(csv, /Por revisar: base e IVA sin confirmar/);
  for (const change of [{ vatReviewNeeded: 'true' }, { vatAmount: 1, base: 120 }, { vatRate: 0 }, { vatDeductibleAmount: 1 }]) {
    assert.ok(validateWorkspace(workspace({ expenses: [{ ...quick, ...change }] }), TODAY).length);
  }
});

test('annual and all-history reports retain date boundaries, exclude drafts and unrelated payments', () => {
  const older = invoice({ id: 'invoice-old', number: 'F-2025-001', date: '2025-12-31' });
  const state = workspace({ documents: [older, invoice(), invoice({ id: 'draft', status: 'draft', number: '', date: '2024-01-01' })],
    expenses: [expense({ paymentStatus: 'paid', paidDate: '2025-12-30' }),
      expense({ id: OTHER_ID, date: '2025-11-30', base: 20, vatAmount: 0, total: 20 })],
    payments: [{ id: 'paid-old', documentId: older.id, date: '2026-01-01', amount: 121 },
      { id: 'unrelated', documentId: 'draft', date: '2024-01-01', amount: 999 }] });
  const annual = periodReport(state, { type: 'year', year: 2026 });
  assert.equal(annual.from, '2026-01-01');
  assert.equal(annual.to, '2026-12-31');
  assert.equal(annual.summary.invoiceCount, 1);
  assert.equal(annual.summary.expenseCount, 1);
  assert.equal(annual.summary.cashReceived, 121);
  assert.equal(annual.summary.cashPaid, 0);
  assert.equal(annual.summary.activityDifference, 0);
  const all = periodReport(state, { type: 'all' });
  assert.equal(all.from, '2025-11-30');
  assert.equal(all.to, '2026-03-31');
  assert.equal(all.summary.invoiceCount, 2);
  assert.equal(all.summary.expenseCount, 2);
  assert.equal(all.summary.cashReceived, 121);
  assert.equal(all.summary.cashPaid, 121);
  assert.equal(all.summary.activityDifference, 80);
  assert.doesNotMatch(reportCSV(state, { type: 'all' }), /999,00/);
  assert.deepEqual(periodRange({ documents: [], expenses: [], payments: [] }, { type: 'all' }), {
    type: 'all', from: null, to: null, label: 'Todo el histórico',
  });
  for (const period of [{ type: 'year', year: 0 }, { type: 'year', year: '2026-01' }, { type: 'month', year: 2026 }]) {
    assert.throws(() => periodReport(state, period), /Selecciona/);
  }
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

test('supplier credits and additional non-VAT amounts keep cash and tax bases separate', () => {
  const credit = expense({ kind: 'credit', base: -40, vatAmount: -8.4, total: -48.4,
    vatDeductibleAmount: -4.2, paymentStatus: 'paid', paidDate: '2026-04-01' });
  const costs = expense({ id: OTHER_ID, base: 725, vatAmount: 152.25, additionalAmount: 636.02,
    total: 1513.27, paymentStatus: 'paid', paidDate: '2026-03-31' });
  const state = workspace({ expenses: [credit, costs] });
  assert.deepEqual(validateWorkspace(state, TODAY), []);
  assert.deepEqual(splitExpenseTotal(-48.4, 21), { base: -40, vatAmount: -8.4, total: -48.4 });
  assert.deepEqual(splitExpenseTotalManual(-48.4, -8.4), { base: -40, vatAmount: -8.4, total: -48.4 });
  assert.throws(() => splitExpenseTotalManual(-48.4, 8.4), /signo/);
  assert.throws(() => splitExpenseTotalManual(48.4, -8.4), /signo/);
  assert.equal(expenseTotals(credit).vatDeductibleAmount, -4.2);
  assert.equal(expenseTotals(costs).total, 1513.27);
  const summary = periodReport(state, { type: 'year', year: 2026 }).summary;
  assert.equal(summary.expenseBase, 685);
  assert.equal(summary.inputVATRecorded, 143.85);
  assert.equal(summary.inputVATConfirmed, -4.2);
  assert.equal(summary.additionalTotal, 636.02);
  assert.equal(summary.creditCount, 1);
  assert.equal(summary.expenseTotal, 1464.87);
  assert.equal(summary.cashPaid, 1464.87);
  assert.equal(summary.activityDifference, -585);
  assert.equal(cashSummary(state, TODAY).paidExpenses, 1464.87);
  assert.match(reportCSV(state, { type: 'all' }), /Abono de proveedor/);
  assert.match(reportCSV(state, { type: 'all' }), /Reembolsado/);
  for (const change of [{ kind: 'other' }, { base: 40 }, { total: 48.4 }, { vatDeductibleAmount: -8.41 },
    { additionalAmount: 1, total: -47.4 }, { vatDeductibleAmount: 1 }]) {
    assert.ok(validateWorkspace(workspace({ expenses: [{ ...credit, ...change }] }), TODAY).length);
  }
  for (const change of [{ additionalAmount: -1, total: 876.25 }, { additionalAmount: 636.001 }, { total: 1513.26 }]) {
    assert.ok(validateWorkspace(workspace({ expenses: [{ ...costs, ...change }] }), TODAY).length);
  }
});

test('cash ledgers retain gross documents, bank discounts, advance dates and later partial refunds', () => {
  const travel = expense({ date: '2026-05-23', base: 61.95, vatAmount: 0, total: 61.95, cashAmount: 61.8,
    paymentStatus: 'paid', paidDate: '2026-05-23' });
  const rental = expense({ id: OTHER_ID, date: '2026-05-31', base: 110.96, vatAmount: 23.3, total: 134.26,
    paymentStatus: 'paid', paidDate: '2026-05-31', cashMovements: [
      { id: '804f4204-ef81-4d89-a91c-3f7461916b47', date: '2026-05-12', amount: 144.16, reference: 'Cargo inicial' },
      { id: '04e43d6b-7a4a-4f83-996c-17af7a7c5e6d', date: '2026-05-31', amount: -9.9, reference: 'Devolución' },
    ] });
  const state = workspace({ company: { name: 'Orquívia', openingBalance: 1000, openingBalanceDate: '2026-05-01' },
    expenses: [travel, rental] });
  assert.deepEqual(validateWorkspace(state, TODAY), []);
  assert.equal(expenseTotals(travel).total, 61.95);
  assert.equal(expenseCashAmount(travel), 61.8);
  assert.equal(periodReport(state, { type: 'year', year: 2026 }).summary.expenseTotal, 196.21);
  assert.equal(periodReport(state, { type: 'year', year: 2026 }).summary.cashPaid, 196.06);
  const midMonth = cashSummary(state, '2026-05-20');
  assert.equal(midMonth.paidExpenses, 144.16);
  assert.equal(midMonth.balance, 855.84);
  assert.equal(cashSummary(state, '2026-05-31').paidExpenses, 196.06);
  state.company.openingBalanceDate = '2026-05-25';
  assert.equal(cashSummary(state, TODAY).paidExpenses, -9.9);
  assert.equal(cashSummary(state, TODAY).balance, 1009.9);
  const crossQuarter = structuredClone(rental);
  crossQuarter.cashMovements[1].date = '2026-07-01';
  crossQuarter.paidDate = '2026-07-01';
  const crossing = workspace({ expenses: [crossQuarter] });
  assert.equal(periodReport(crossing, { type: 'quarter', year: 2026, quarter: 2 }).summary.cashPaid, 144.16);
  const third = periodReport(crossing, { type: 'quarter', year: 2026, quarter: 3 });
  assert.equal(third.summary.expenseCount, 0);
  assert.equal(third.summary.cashPaid, -9.9);
  assert.equal(third.expensePayments.length, 1);
  assert.match(reportCSV(state, { type: 'all' }), /2026-05-31: -9,90/);
  for (const change of [{ cashAmount: -1 }, { cashAmount: 134.25 }, { paymentStatus: 'pending', paidDate: null },
    { cashMovements: [] }, { cashMovements: rental.cashMovements.map((m) => ({ ...m, id: rental.cashMovements[0].id })) },
    { cashMovements: [{ ...rental.cashMovements[0], amount: 134.261 }] },
    { cashMovements: [{ ...rental.cashMovements[0], date: '2026-10-15', amount: 134.26 }] }]) {
    assert.ok(validateWorkspace(workspace({ expenses: [{ ...rental, ...change }] }), TODAY).length);
  }
  const free = expense({ cashAmount: 0, paymentStatus: 'paid', paidDate: '2026-03-31' });
  assert.deepEqual(validateWorkspace(workspace({ expenses: [free] }), TODAY), []);
  assert.equal(periodReport(workspace({ expenses: [free] }), { type: 'all' }).summary.cashPaid, 0);
});
