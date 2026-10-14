import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { validateWorkspace } from '../src/domain.js';
import { cashSummary, periodReport, reportCSV, taxCashMovements } from '../src/expenses.js';
import { prepareRestore } from '../src/security.js';
import { validateCloudState } from '../src/backend.js';
import { buildPeriodBundle } from '../src/quarter-export.js';

const TODAY = '2026-10-14';
const ORG = 'c1000000-0000-4000-8000-000000000001';
const TAX = 'c2000000-0000-4000-8000-000000000001';
const TAX2 = 'c2000000-0000-4000-8000-000000000002';
const EXPENSE = 'c3000000-0000-4000-8000-000000000001';
const FILE = 'c4000000-0000-4000-8000-000000000001';
const FILE2 = 'c4000000-0000-4000-8000-000000000002';
const BYTES = new TextEncoder().encode('%PDF-1.7\nFiled tax declaration\n');
const attachment = (record = TAX, id = FILE) => ({ id, name: 'Modelo.pdf', path: `${ORG}/${record}/${id}.pdf`, mimeType: 'application/pdf', size: BYTES.length });
const tax = (overrides = {}) => ({ id: TAX, date: '2026-07-13', model: '303', year: 2026, quarter: 2,
  amount: 2195.98, reference: 'DECL-01', notes: '', paymentStatus: 'paid', paidDate: '2026-07-20', attachments: [attachment()], ...overrides });
const expense = (overrides = {}) => ({ id: EXPENSE, date: '2026-07-01', supplier: 'Gestor', description: 'Servicios y suplido',
  base: 100, vatAmount: 21, vatDeductibleAmount: 0, additionalAmount: 30, total: 151,
  paymentStatus: 'paid', paidDate: '2026-07-01', attachments: [], ...overrides });
const workspace = (overrides = {}) => ({ company: { name: 'Orquívia', openingBalance: 3000, openingBalanceDate: '2026-07-01' },
  clients: [], documents: [], payments: [], expenses: [], taxRecords: [], ...overrides });

test('declarations use their fiscal period while actual bank payments use their own date', () => {
  const state = workspace({ taxRecords: [tax()] });
  assert.deepEqual(validateWorkspace(state, TODAY), []);
  const second = periodReport(state, { type: 'quarter', year: 2026, quarter: 2 });
  const third = periodReport(state, { type: 'quarter', year: 2026, quarter: 3 });
  assert.equal(second.taxRecords.length, 1);
  assert.equal(second.summary.taxDeclaredTotal, 2195.98);
  assert.equal(second.summary.cashPaidTaxes, 0);
  assert.equal(third.taxRecords.length, 0);
  assert.equal(third.summary.cashPaidTaxes, 2195.98);
  for (const report of [second, third]) {
    assert.equal(report.summary.expenseCount, 0);
    assert.equal(report.summary.expenseTotal, 0);
    assert.equal(report.summary.expenseBase, 0);
    assert.equal(report.summary.inputVATRecorded, 0);
    assert.equal(report.summary.inputVATConfirmed, 0);
  }
  assert.equal(cashSummary(state, TODAY).paidTaxes, 2195.98);
  assert.equal(cashSummary(state, TODAY).paidExpenses, 0);
  assert.equal(cashSummary(state, TODAY).balance, 804.02);
  assert.equal(cashSummary(state, '2026-07-14').balance, 3000);
  assert.equal(cashSummary(state, '2026-07-14').forecastBalance, 804.02, 'A historical cash view retains an already-confirmed later payment in its forecast');
  const csv = reportCSV(state, { type: 'quarter', year: 2026, quarter: 2 });
  assert.match(csv, /Declaración fiscal/);
  assert.match(csv, /Modelo 303 · 2026 T2/);
  assert.match(csv, /"";"";"";"2195,98";""/);
  assert.doesNotMatch(csv, /c1000000/);
  assert.deepEqual(prepareRestore(state, { today: TODAY }).taxRecords, state.taxRecords);
  assert.deepEqual(validateCloudState(state).taxRecords, state.taxRecords);
});

test('zero declarations, unconfirmed payments, pending payments and refunds have distinct cash behavior', () => {
  const zero = tax({ model: '111', amount: 0, paymentStatus: 'no-payment', paidDate: null });
  assert.deepEqual(validateWorkspace(workspace({ taxRecords: [zero] }), TODAY), []);
  assert.deepEqual(taxCashMovements(zero), []);
  assert.equal(cashSummary(workspace({ taxRecords: [zero] }), TODAY).forecastBalance, 3000);
  const unconfirmed = tax({ paymentStatus: 'unconfirmed', paidDate: null });
  assert.deepEqual(validateWorkspace(workspace({ taxRecords: [unconfirmed] }), TODAY), []);
  assert.equal(cashSummary(workspace({ taxRecords: [unconfirmed] }), TODAY).forecastBalance, 3000);
  assert.equal(periodReport(workspace({ taxRecords: [unconfirmed] }), { type: 'all' }).summary.taxUnconfirmedCount, 1);
  const pending = tax({ paymentStatus: 'pending', paidDate: null });
  const pendingCash = cashSummary(workspace({ taxRecords: [pending] }), TODAY);
  assert.equal(pendingCash.balance, 3000);
  assert.equal(pendingCash.pendingTaxes, 2195.98);
  assert.equal(pendingCash.forecastBalance, 804.02);
  const refund = tax({ amount: -100 });
  assert.deepEqual(validateWorkspace(workspace({ taxRecords: [refund] }), TODAY), []);
  assert.equal(cashSummary(workspace({ taxRecords: [refund] }), TODAY).balance, 3100);
  const cutoff = workspace({ taxRecords: [tax()], company: { name: 'Orquívia', openingBalance: 8346.54, openingBalanceDate: '2026-10-01' } });
  assert.equal(cashSummary(cutoff, TODAY).balance, 8346.54, 'Old tax payments cannot be subtracted again from the opening balance');
});

test('tax payments already included as supplier suplidos cannot be counted or linked twice', () => {
  const linked = tax({ amount: 30, paymentStatus: 'included', paidDate: null, linkedExpenseId: EXPENSE });
  const state = workspace({ expenses: [expense()], taxRecords: [linked] });
  assert.deepEqual(validateWorkspace(state, TODAY), []);
  assert.equal(cashSummary(state, TODAY).paidTaxes, 0);
  assert.equal(cashSummary(state, TODAY).paidExpenses, 151);
  assert.equal(cashSummary(state, TODAY).balance, 2849);
  const report = periodReport(state, { type: 'all' });
  assert.equal(report.summary.expenseTotal, 151);
  assert.equal(report.summary.expenseBase, 100);
  assert.equal(report.summary.inputVATRecorded, 21);
  const duplicateLink = tax({ id: TAX2, amount: 1, paymentStatus: 'included', paidDate: null, linkedExpenseId: EXPENSE, attachments: [attachment(TAX2, FILE2)] });
  assert.match(validateWorkspace({ ...state, taxRecords: [linked, duplicateLink] }, TODAY).join(' '), /superan el suplido/);
  assert.match(validateWorkspace(workspace({ expenses: [expense({ additionalAmount: 0, total: 121 })], taxRecords: [linked] }), TODAY).join(' '), /suplido/);
});

test('invalid fiscal amounts, statuses, periods, links and private original references fail closed', () => {
  const invalid = [
    { amount: 0 }, { amount: 0, paymentStatus: 'pending', paidDate: null }, { paymentStatus: 'no-payment' },
    { amount: Infinity }, { amount: 1.001 }, { amount: '12' }, { model: '999' }, { year: 2027 },
    { year: 2026.5 }, { quarter: 4 }, { quarter: 2.5 }, { date: '2026-02-30' }, { date: '2026-10-15' },
    { paidDate: '2026-10-15' }, { paidDate: '' }, { paymentStatus: 'unconfirmed' }, { linkedExpenseId: EXPENSE },
    { amount: -1, paymentStatus: 'pending', paidDate: null }, { paymentStatus: 'included', linkedExpenseId: 'missing', paidDate: null },
    { attachments: [] }, { attachments: [attachment(EXPENSE)] }, { attachments: [{ ...attachment(), size: 10485761 }] },
    { attachments: [{ ...attachment(), name: '../Model.pdf' }] }, { attachments: [{ ...attachment(), mimeType: 'text/html' }] },
  ];
  for (const change of invalid) assert.ok(validateWorkspace(workspace({ taxRecords: [tax(change)] }), TODAY).length, JSON.stringify(change));
  const duplicatedFile = expense({ attachments: [{ ...attachment(), path: `${ORG}/${EXPENSE}/${FILE}.pdf` }] });
  assert.match(validateWorkspace(workspace({ expenses: [duplicatedFile], taxRecords: [tax()] }), TODAY).join(' '), /documento está duplicado/);
  assert.match(validateWorkspace(workspace({ expenses: [expense()], taxRecords: [tax({ id: EXPENSE, attachments: [attachment(EXPENSE)] })] }), TODAY).join(' '), /identificador está duplicado/);
  assert.doesNotThrow(() => validateWorkspace({ ...workspace(), expenses: {}, taxRecords: [tax()] }, TODAY));
});

test('quarter bundles include exact declaration originals by fiscal quarter without including their payment as a supplier cost', async () => {
  const state = workspace({ taxRecords: [tax()] });
  const result = await buildPeriodBundle(state, { type: 'quarter', year: 2026, quarter: 2 }, {
    backend: { async downloadReceipt(metadata) { assert.equal(metadata.path, attachment().path); return new Blob([BYTES], { type: 'application/pdf' }); } },
  });
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
  assert.deepEqual(await zip.file(`declaraciones/${TAX}/${FILE}_Modelo.pdf`).async('uint8array'), BYTES);
  const csv = await zip.file('registro-trimestre.csv').async('string');
  assert.match(csv, /Declaración fiscal/);
  assert.doesNotMatch(csv, /Gasto recibido/);
  const summary = await zip.file('resumen.txt').async('string');
  assert.match(summary, /Declaraciones fiscales del período fiscal seleccionado: 1/);
  assert.match(summary, /Resultado declarado \(no es gasto ni IVA soportado\): 2\.?195,98/);
  assert.match(summary, /Pagos fiscales separados con fecha dentro del período: 0,00/);
  const third = await buildPeriodBundle(state, { type: 'quarter', year: 2026, quarter: 3 });
  assert.equal(third.receiptCount, 0, 'The T2 filing must not be moved to T3 because its bank payment was in July');
  const thirdZip = await JSZip.loadAsync(await third.blob.arrayBuffer());
  assert.match(await thirdZip.file('resumen.txt').async('string'), /Pagos fiscales separados con fecha dentro del período: 2\.?195,98/);
});
