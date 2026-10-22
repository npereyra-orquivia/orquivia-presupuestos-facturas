import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceSheetReport } from '../src/balance-sheet.js';

const invoice = (overrides = {}) => ({ id: 'i1', kind: 'invoice', status: 'issued', number: 'F-2026-001', date: '2026-09-01',
  items: [{ description: 'Servicio', quantity: 1, price: 100 }], vat: 21, withholding: 0, discount: 0, ...overrides });
const expense = (overrides = {}) => ({ id: 'e1', date: '2026-09-01', base: 100, vatAmount: 21, vatDeductibleAmount: 0,
  total: 121, paymentStatus: 'pending', paidDate: null, ...overrides });
const state = (overrides = {}) => ({ company: { openingBalance: 1000, openingBalanceDate: '2026-10-01' }, documents: [], payments: [], expenses: [], taxRecords: [], ...overrides });

test('balance distinguishes bank cash, customer claims and supplier debt without inventing equity to balance it', () => {
  const result = balanceSheetReport(state({ documents: [invoice()], expenses: [expense()] }), { asOf: '2026-10-22' });
  assert.equal(result.summary.bankBalance, 1000);assert.equal(result.summary.receivables, 121);assert.equal(result.summary.payables, 121);
  assert.equal(result.summary.knownAssets, 1121);assert.equal(result.summary.knownLiabilities, 121);
  assert.equal(result.summary.netAssetsKnown, 1000);assert.equal(result.summary.equity, null);
  assert.equal(result.summary.balanced, false);assert.equal(result.summary.complete, false);
  assert.ok(result.missing.some(item => item.id === 'equity' && item.amount === null));
  assert.ok(result.pending.some(item => item.id === 'bank-reconciliation'));
});

test('historical receivables and payables use only payments made by closing date, irrespective of current paid status', () => {
  const result = balanceSheetReport(state({ documents: [invoice({ status: 'paid' })],
    payments: [{ id: 'p1', documentId: 'i1', date: '2026-09-20', amount: 50 }, { id: 'p2', documentId: 'i1', date: '2026-11-01', amount: 71 }],
    expenses: [expense({ paymentStatus: 'paid', paidDate: '2026-11-01' }), expense({ id: 'paid-before', paymentStatus: 'paid', paidDate: '2026-09-05' }),
      expense({ id: 'future-voucher', date: '2026-11-01' })] }), { asOf: '2026-10-22' });
  assert.equal(result.summary.receivables, 71);assert.equal(result.summary.payables, 121);
});

test('future supplier refunds create a receivable, not negative supplier debt', () => {
  const result = balanceSheetReport(state({ expenses: [expense({ kind: 'credit', base: -20, vatAmount: -4.2, total: -24.2,
    vatDeductibleAmount: 0, paymentStatus: 'paid', paidDate: '2026-11-01' })] }), { asOf: '2026-10-22' });
  assert.equal(result.summary.supplierRefunds, 24.2);assert.equal(result.summary.payables, 0);
  assert.equal(result.assets.find(item => item.id === 'supplier-refunds').amount, 24.2);
});

test('a reconciled bank-statement figure is explicit and does not create a capital or profit plug', () => {
  const result = balanceSheetReport(state(), { asOf: '2026-10-22' }, { bankBalance: 1724.47, bankSource: 'Extracto aportado hasta 22/10/2026' });
  assert.equal(result.summary.bankBalance, 1724.47);assert.equal(result.summary.knownAssets, 1724.47);
  assert.equal(result.pending.find(row=>row.id==='bank-difference').amount,724.47);assert.equal(result.summary.equity, null);
  assert.equal(result.assets.find(item => item.id === 'bank').source, 'Extracto aportado hasta 22/10/2026');
  const overdraft = balanceSheetReport(state(), { asOf: '2026-10-22' }, { bankBalance: -30 });
  assert.equal(overdraft.summary.knownAssets, 0);assert.equal(overdraft.summary.knownLiabilities, 30);
});

test('missing bank configuration stays unavailable and documented manual balances never silently complete the statement', () => {
  const result = balanceSheetReport(state({ company: {} }), { asOf: '2026-10-22' }, { adjustments: [
    { id: 'capital', section: 'equity', label: 'Capital social', amount: 3000, source: 'Balance aportado por el gestor' },
    { id: 'fixed-assets', section: 'asset', label: 'Inmovilizado neto', amount: 3000, source: 'Libro de inmovilizado del gestor' },
  ] });
  assert.equal(result.summary.bankBalance, null);assert.equal(result.summary.equity, 3000);
  assert.equal(result.summary.arithmeticDifference, 0);assert.equal(result.summary.balanced, false);
  assert.ok(result.missing.some(item => item.id === 'bank'));
  assert.throws(() => balanceSheetReport(state(), { asOf: '2026-02-30' }), /fecha válida/);
  assert.throws(() => balanceSheetReport(state(), { asOf: '2026-10-22' }, { adjustments: [{ id: 'capital', section: 'equity', label: 'Capital', amount: 3000 }] }), /fuente/);
});

test('same-ID duplicate sources cannot inflate balances, while conflicting versions stop generation', () => {
  const i = invoice(), e = expense();
  const result = balanceSheetReport(state({ documents: [i, structuredClone(i)], expenses: [e, structuredClone(e)] }), { asOf: '2026-10-22' });
  assert.equal(result.summary.receivables, 121);assert.equal(result.summary.payables, 121);
  assert.throws(() => balanceSheetReport(state({ expenses: [e, { ...e, total: 242 }] }), { asOf: '2026-10-22' }), /versiones distintas/);
});

test('tax payments follow the same deduplication policy before calculating bank cash', () => {
  const tax = { id: 't1', date: '2026-10-20', amount: 100, paymentStatus: 'paid', paidDate: '2026-10-20', model: '303' };
  const result = balanceSheetReport(state({ taxRecords: [tax, structuredClone(tax)] }), { asOf: '2026-10-22' });
  assert.equal(result.summary.bankBalance, 900);
  assert.throws(() => balanceSheetReport(state({ taxRecords: [tax, { ...tax, amount: 200 }] }), { asOf: '2026-10-22' }), /versiones distintas/);
});

test('explicit declared capital and zero financing stay visible and narrow the missing-data labels without inventing reserves', () => {
  const result = balanceSheetReport(state(), { asOf: '2026-10-22' }, { adjustments: [
    { id: 'declared-capital', section: 'equity', label: 'Capital social declarado', amount: 1, source: 'Declaración de la administradora' },
    { id: 'declared-financing', section: 'liability', label: 'Financiación declarada', amount: 0, source: 'Declaración de la administradora' },
  ] });
  assert.equal(result.summary.equity, 1);assert.equal(result.liabilities.find(item => item.id === 'manual:declared-financing').amount, 0);
  assert.match(result.missing.find(item => item.id === 'equity').label, /capital declarado por separado/);
  assert.equal(result.missing.some(item => item.id === 'financing'), false);
  assert.ok(result.missing.some(item => item.id === 'current-result'));assert.equal(result.summary.balanced, false);
  assert.throws(() => balanceSheetReport(state(), { asOf: '2026-10-22' }, { adjustments: [
    { id: 'declared-financing', section: 'liability', label: 'Financiación declarada', amount: -1, source: 'Declaración de la administradora' },
  ] }), /no pueden ser negativos/);
});
