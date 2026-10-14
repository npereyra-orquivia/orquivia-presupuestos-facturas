import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyCashActivity } from '../src/cash-activity.js';
import { cashSummary, periodReport } from '../src/expenses.js';

function expense(overrides = {}) {
  return { id: 'expense-1', date: '2026-04-01', category: 'Servicios', base: 100, vatAmount: 21,
    total: 121, vatDeductibleAmount: 0, paymentStatus: 'paid', paidDate: '2026-04-15', ...overrides };
}
function invoice(overrides = {}) {
  return { id: 'invoice-1', kind: 'invoice', status: 'issued', date: '2026-04-01',
    items: [{ description: 'Servicio', quantity: 1, price: 100 }], vat: 21, ...overrides };
}
function tax(overrides = {}) {
  return { id: 'tax-1', model: '303', year: 2026, quarter: 2, date: '2026-07-13',
    amount: 2195.98, paymentStatus: 'paid', paidDate: '2026-07-20', ...overrides };
}
function state(overrides = {}) {
  return { company: {}, clients: [], documents: [], payments: [], expenses: [], taxRecords: [], ...overrides };
}

test('monthly cash distinguishes gross debits, supplier refunds and tax refunds without losing cents', () => {
  const workspace = state({ documents: [invoice()], payments: [
    { documentId: 'invoice-1', date: '2026-04-20', amount: 0.1 },
    { documentId: 'invoice-1', date: '2026-04-20', amount: 0.2 },
  ], expenses: [expense({ cashMovements: [
    { date: '2026-04-01', amount: 100 }, { date: '2026-05-01', amount: -20 },
  ] }), expense({ id: 'credit', kind: 'credit', base: -40, vatAmount: -8.4, total: -48.4,
    paidDate: '2026-05-20' })], taxRecords: [tax({ amount: 10, paidDate: '2026-04-30' }),
    tax({ id: 'tax-refund', amount: -2.41, paidDate: '2026-05-20' })] });
  const activity = monthlyCashActivity(workspace, { type: 'quarter', year: 2026, quarter: 2 });
  assert.deepEqual(activity.totals, { receivedInvoices: 0.3, expenseRefunds: 68.4, taxRefunds: 2.41,
    inflows: 71.11, paidExpenses: 100, paidTaxes: 10, outflows: 110, net: -38.89 });
  assert.deepEqual(activity.categories, [{ name: 'Servicios profesionales', amount: 100 }]);
  assert.deepEqual(activity.months.map(month => [month.month, month.inflows, month.outflows, month.net]), [
    ['2026-04', 0.3, 110, -109.7], ['2026-05', 70.81, 0, 70.81], ['2026-06', 0, 0, 0],
  ]);
  assert.deepEqual(activity.months[1].categories, [], 'A refund is an inflow, not negative spending by category');
});

test('cash uses bank dates across quarters and gross amounts even when VAT is unknown', () => {
  const workspace = state({ expenses: [expense({ date: '2026-05-31', base: 529, vatAmount: 0,
    total: 529, vatReviewNeeded: true, paidDate: '2026-07-01', category: 'Alojamiento',
    cashAmount: 528.85 })], taxRecords: [tax()] });
  const second = monthlyCashActivity(workspace, { type: 'quarter', year: 2026, quarter: 2 });
  const third = monthlyCashActivity(workspace, { type: 'quarter', year: 2026, quarter: 3 });
  assert.equal(periodReport(workspace, { type: 'quarter', year: 2026, quarter: 2 }).summary.expenseTotal, 529);
  assert.equal(second.totals.outflows, 0, 'A T2 receipt is not a T2 bank debit when paid in July');
  assert.equal(third.totals.paidExpenses, 528.85);
  assert.equal(third.totals.paidTaxes, 2195.98, 'The T2 VAT declaration was paid in T3');
  assert.equal(third.totals.outflows, 2724.83);
  assert.deepEqual(third.categories, [{ name: 'Alojamiento', amount: 528.85 }]);
  assert.deepEqual(third.range, { from: '2026-07-01', to: '2026-09-30', label: '3.º trimestre de 2026' });
});

test('only issued invoice collections, paid expenses and independently confirmed tax payments enter the chart', () => {
  const workspace = state({ documents: [invoice(), invoice({ id: 'draft', status: 'draft' }),
    invoice({ id: 'quote', kind: 'quote' }), invoice({ id: 'partial', status: 'partial' }),
    invoice({ id: 'paid', status: 'paid' }), invoice({ id: 'late', status: 'overdue' })],
  payments: ['invoice-1', 'draft', 'quote', 'partial', 'paid', 'late'].map(documentId => ({
    documentId, date: '2026-04-01', amount: 1,
  })), expenses: [expense({ paymentStatus: 'pending', paidDate: null }), expense({ id: 'paid', category: 'Comidas' })],
  taxRecords: [tax({ amount: 0, paymentStatus: 'no-payment', paidDate: null }),
    tax({ id: 'unknown', paymentStatus: 'unconfirmed', paidDate: null }),
    tax({ id: 'pending', paymentStatus: 'pending', paidDate: null }),
    tax({ id: 'included', amount: 30, paymentStatus: 'included', paidDate: null }),
    tax({ id: 'invalid', paidDate: '2026-02-30' })] });
  const activity = monthlyCashActivity(workspace, { type: 'all' });
  assert.equal(activity.totals.receivedInvoices, 4);
  assert.equal(activity.totals.paidExpenses, 121);
  assert.equal(activity.totals.paidTaxes, 0);
  assert.deepEqual(activity.categories, [{ name: 'Comidas y dietas', amount: 121 }]);
});

test('opening balances do not enter period activity or hide earlier historical movements', () => {
  const workspace = state({ company: { openingBalance: 8346.54, openingBalanceDate: '2026-10-01' },
    documents: [invoice()], payments: [{ documentId: 'invoice-1', date: '2026-04-20', amount: 121 }],
    expenses: [expense({ total: 10.1, base: 10.1, vatAmount: 0 })], taxRecords: [tax({ amount: 20 })] });
  assert.equal(cashSummary(workspace, '2026-10-14').balance, 8346.54);
  assert.equal(monthlyCashActivity(workspace, { type: 'all' }).totals.net, 90.9);
  assert.deepEqual(monthlyCashActivity(workspace, { type: 'all' }), monthlyCashActivity({ ...workspace,
    company: { openingBalance: 1, openingBalanceDate: '2026-01-01' } }, { type: 'all' }));
});

test('year and short history show missing months; empty history stays empty; long histories are bounded', () => {
  const empty = monthlyCashActivity(state(), { type: 'all' });
  assert.deepEqual(empty.range, { from: null, to: null, label: 'Todo el histórico' });
  assert.deepEqual(empty.months, []);
  assert.equal(empty.totals.net, 0);
  assert.equal(monthlyCashActivity(state(), { type: 'year', year: 2026 }).months.length, 12);
  const short = monthlyCashActivity(state({ expenses: [expense({ date: '2025-12-31', paidDate: '2026-03-01' })] }), { type: 'all' });
  assert.deepEqual(short.months.map(month => month.month), ['2025-12', '2026-01', '2026-02', '2026-03']);
  const long = monthlyCashActivity(state({ expenses: [expense({ id: 'old', date: '1000-01-01', paidDate: '1000-01-01' }),
    expense({ date: '9999-12-31', paidDate: '9999-12-31' })] }), { type: 'all' });
  assert.deepEqual(long.months.map(month => month.month), ['1000-01', '9999-12']);
});

test('category totals count gross outgoing cash including IVA and keep user categories deterministic', () => {
  const workspace = state({ expenses: [expense({ id: 'food', category: 'Comidas', base: 10, vatAmount: 1, total: 11 }),
    expense({ id: 'travel', category: 'Transporte', base: 10, vatAmount: 1, total: 11 }),
    expense({ id: 'custom', category: '  Formación  ', base: 20, vatAmount: 4.2, total: 24.2 }),
    expense({ id: 'missing', category: '', base: 0.1, vatAmount: 0.2, total: 0.3 })] });
  const before = structuredClone(workspace);
  const activity = monthlyCashActivity(workspace, { type: 'all' });
  assert.deepEqual(activity.categories, [{ name: 'Formación', amount: 24.2 },
    { name: 'Comidas y dietas', amount: 11 }, { name: 'Transporte', amount: 11 }, { name: 'Otros gastos', amount: 0.3 }]);
  assert.equal(activity.totals.outflows, 46.5);
  assert.deepEqual(workspace, before, 'Pure derivation must not alter recorded documents or bank movements');
});
