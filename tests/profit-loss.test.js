import test from 'node:test';
import assert from 'node:assert/strict';
import { profitLossReport, statementRange } from '../src/profit-loss.js';

const range = { from: '2026-01-01', to: '2026-10-22' };
const invoice = (overrides = {}) => ({ id: 'invoice-1', kind: 'invoice', status: 'issued', number: 'F-2026-001',
  date: '2026-03-20', items: [{ description: 'Servicio', quantity: 1, price: 1000 }], vat: 21, withholding: 15, discount: 0, ...overrides });
const expense = (overrides = {}) => ({ id: 'expense-1', date: '2026-03-10', description: 'Material de oficina', category: 'Material', supplier: 'Proveedor',
  base: 100, vatAmount: 21, total: 121, vatDeductibleAmount: 21, paymentStatus: 'paid', paidDate: '2026-03-10',
  attachments: [{ id: 'receipt-1' }], ...overrides });
const workspace = (overrides = {}) => ({ company: { name: 'Sociedad' }, documents: [invoice()], expenses: [], payments: [], taxRecords: [], ...overrides });

test('P&L uses issued invoice bases by document date independently of collections, VAT and withholding', () => {
  const state = workspace({ documents: [invoice(), invoice({ id: 'quote', kind: 'quote', number: 'PR-2026-001', status: 'sent' }),
    invoice({ id: 'draft', number: '', status: 'draft' }), invoice({ id: 'other-year', number: 'F-2025-001', date: '2025-12-31' })],
  payments: [{ id: 'p1', documentId: 'invoice-1', date: '2027-01-01', amount: 1060 }] });
  const report = profitLossReport(state, range);
  assert.equal(report.summary.salesBase, 1000);assert.equal(report.summary.invoiceCount, 1);
  assert.equal(report.summary.resultBeforePending, 1000);assert.equal(report.summary.netResult, null);
  assert.equal(report.status, 'provisional');assert.equal(report.lines.find(row => row.id === 'final-result').amount, null);
});

test('known expenses are accrued on voucher date and supplier credits reduce costs', () => {
  const state = workspace({ expenses: [expense({ paymentStatus: 'pending', paidDate: null }),
    expense({ id: 'credit', kind: 'credit', base: -20, vatAmount: -4.2, total: -24.2, vatDeductibleAmount: -4.2 }),
    expense({ id: 'outside', date: '2025-12-31', paidDate: '2026-01-02', base: 300, vatAmount: 0, total: 300, vatDeductibleAmount: 0 })] });
  const result = profitLossReport(state, range);
  assert.equal(result.summary.operatingExpenses, 80);assert.equal(result.summary.resultBeforePending, 920);
  assert.equal(result.summary.pendingCount, 0);
});

test('unknown VAT retains gross pending rather than silently using its placeholder as net expense', () => {
  const result = profitLossReport(workspace({ expenses: [expense({ base: 529, vatAmount: 0, total: 529,
    vatReviewNeeded: true, vatDeductibleAmount: 0, attachments: [] })] }), range);
  assert.equal(result.expenses[0].base, null);assert.equal(result.expenses[0].costKnown, null);
  assert.equal(result.summary.knownExpenses, 0);assert.equal(result.summary.pendingExpenseGross, 529);
  assert.equal(result.summary.resultBeforePending, 1000);
  assert.ok(result.pending.some(item => item.type === 'vat-breakdown' && item.amount === 529));
  assert.ok(result.pending.some(item => item.type === 'receipt'));
});

test('zero confirmed VAT means unconfirmed recoverability and is not automatically non-deductible', () => {
  const state = workspace({ expenses: [expense({ vatDeductibleAmount: 0 })] });
  const provisional = profitLossReport(state, range);
  assert.equal(provisional.summary.operatingExpenses, 100);assert.equal(provisional.summary.pendingVATAmount, 21);
  const nonDeductible = profitLossReport(state, range, { expenseTreatments: { 'expense-1': { vatTreatment: 'non-deductible' } } });
  assert.equal(nonDeductible.summary.operatingExpenses, 121);assert.equal(nonDeductible.summary.pendingVATAmount, 0);
  const deductible = profitLossReport(state, range, { expenseTreatments: { 'expense-1': { vatTreatment: 'deductible' } } });
  assert.equal(deductible.summary.operatingExpenses, 100);assert.equal(deductible.summary.pendingVATAmount, 0);
  const noBreakdown = profitLossReport(workspace({ expenses: [expense({ base: 121, vatAmount: 0, vatDeductibleAmount: 0, vatReviewNeeded: true })] }), range,
    { expenseTreatments: { 'expense-1': { vatTreatment: 'non-deductible' } } });
  assert.equal(noBreakdown.summary.knownExpenses, 121);assert.equal(noBreakdown.summary.pendingExpenseGross, 0);
  assert.equal(noBreakdown.expenses[0].vatAmount, null);
});

test('loan principal, temporary bank retentions, internal transfers and tax settlements are excluded from operating results', () => {
  const state = workspace({ expenses: [expense({ category: 'Principal de préstamo' }), expense({ id: 'hold', category: 'Retenciones bancarias temporales', base: 150, vatAmount: 0, total: 150 }),
    expense({ id: 'release', category: 'Retenciones bancarias temporales', kind: 'credit', base: -150, vatAmount: 0, total: -150, vatDeductibleAmount: 0 }),
    expense({ id: 'transfer', category: 'Transferencias internas' })], taxRecords: [{ id: 'tax', date: '2026-07-20', model: '303', amount: 450, paymentStatus: 'paid', paidDate: '2026-07-20' }] });
  const result = profitLossReport(state, range);
  assert.equal(result.summary.knownExpenses, 0);assert.equal(result.summary.pendingExpenseGross, 0);
  assert.equal(result.summary.taxSettlementsGross, 450);assert.equal(result.excluded.length, 5);
});

test('financial interest is separated and an unsplit loan instalment or incorporation payment remains unclassified', () => {
  const state = workspace({ expenses: [expense({ category: 'Gastos financieros', base: 20, vatAmount: 0, total: 20, vatDeductibleAmount: 0 }),
    expense({ id: 'instalment', category: 'Préstamos', base: 300, vatAmount: 0, total: 300, vatDeductibleAmount: 0 }),
    expense({ id: 'incorporation', description: 'Constitución de la sociedad', base: 725, vatAmount: 152.25, additionalAmount: 636.02, total: 1513.27 })] });
  const result = profitLossReport(state, range);
  assert.equal(result.summary.financialExpenses, 20);assert.equal(result.summary.operatingExpenses, 0);
  assert.equal(result.summary.pendingClassificationGross, 1813.27);
  assert.equal(result.pending.filter(item => item.type === 'classification').length, 2);
});

test('linked tax suplidos do not inflate expense bases or duplicate a filed tax payment', () => {
  const state = workspace({ expenses: [expense({ base: 100, vatAmount: 21, additionalAmount: 150, total: 271 })],
    taxRecords: [{ id: 'tax1', date: '2026-04-20', amount: 100, model: '111', paymentStatus: 'included', linkedExpenseId: 'expense-1' }] });
  const result = profitLossReport(state, range);
  assert.equal(result.summary.knownExpenses, 100);assert.equal(result.summary.pendingAdditionalAmount, 50);
  assert.ok(result.excluded.some(item => item.type === 'linked-tax' && item.amount === 100));
  assert.equal(result.excluded.filter(item => item.amount === 100).length, 1);
  assert.equal(result.summary.taxSettlementsGross, 100);
});

test('only exact repeated IDs deduplicate; distinct real transactions with equal date/amount remain separate', () => {
  const item = expense();
  const result = profitLossReport(workspace({ expenses: [item, structuredClone(item), { ...item, id: 'expense-2' }] }), range);
  assert.equal(result.summary.knownExpenses, 200);assert.equal(result.summary.duplicateCount, 1);
  assert.throws(() => profitLossReport(workspace({ expenses: [item, { ...item, base: 200, total: 221 }] }), range), /versiones distintas/);
  assert.throws(() => profitLossReport(workspace({ documents: [invoice(), invoice({ id: 'duplicate-number' })] }), range), /mismo número/);
});

test('period boundaries, decimal sums and invalid source totals cannot silently skew the report', () => {
  const state = workspace({ expenses: [expense({ base: 0.1, vatAmount: 0, vatDeductibleAmount: 0, total: 0.1 }),
    expense({ id: 'e2', base: 0.2, vatAmount: 0, vatDeductibleAmount: 0, total: 0.2, date: range.to })] });
  assert.equal(profitLossReport(state, range).summary.knownExpenses, 0.3);
  assert.throws(() => profitLossReport(workspace({ expenses: [expense({ total: 120 })] }), range), /no coincide/);
  assert.throws(() => statementRange(state, { from: '2026-02-30', to: range.to }), /período válido/);
  assert.throws(() => profitLossReport(state, { from: range.to, to: range.from }), /período válido/);
  assert.equal(profitLossReport(state, { type: 'year', year: 2026 }).summary.knownExpenses, 0.3);
});

test('statement generation is pure and does not mark IVA, classifications or receipts as resolved', () => {
  const state = workspace({ expenses: [expense({ vatReviewNeeded: true, base: 121, vatAmount: 0, vatDeductibleAmount: 0 })] });
  const before = JSON.stringify(state);
  profitLossReport(state, range);
  assert.equal(JSON.stringify(state), before);
});
