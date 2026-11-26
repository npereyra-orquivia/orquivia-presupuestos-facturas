import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastLedger } from '../src/forecast-ledger.js';
import { defaultPlanning, planningProjection } from '../src/planning.js';

const TODAY = '2026-11-25';
const fixture = () => ({ company: { openingBalance: 1000, openingBalanceDate: '2026-01-01' }, documents: [], expenses: [], payments: [], taxRecords: [] });
const plan = () => defaultPlanning({ today: TODAY });
const invoice = (id, extra = {}) => ({ id, kind: 'invoice', number: id, title: 'Trabajo de ejemplo', status: 'issued', date: '2026-11-01', dueDate: '2026-12-10',
  items: [{ quantity: 1, price: 100 }], vat: 21, discount: 0, withholding: 0, ...extra });
const expense = (id, extra = {}) => ({ id, description: 'Servicio de ejemplo', supplier: 'Proveedor', date: '2026-11-10', paidDate: '2026-11-10', paymentStatus: 'paid',
  base: 100, vatAmount: 21, total: 121, vatDeductibleAmount: 21, ...extra });
const item = (id, extra = {}) => ({ id, label: 'Servicio recurrente', kind: 'expense', amountGross: 100, vatRate: null, vatDeductible: false,
  treatment: 'operating', recurrence: 'monthly', startDate: '2026-11-10', endDate: null, active: true, linkedRecordIds: [], ...extra });
const cell = (ledger, rowID, month) => ledger.rows.find(row => row.id === rowID).months[`2026-${month}`];

test('annual ledger combines actual cash and remaining forecasts with exact opening and ending balances', () => {
  const s = fixture(), p = plan();
  s.documents = [invoice('sale')]; s.payments = [{ id: 'collection', documentId: 'sale', date: '2026-11-20', amount: 121 }];
  s.expenses = [expense('cost', { base: 82.64, vatAmount: 17.36, total: 100 })];
  p.items = [item('next', { startDate: '2026-12-10' })];
  const before = structuredClone({ s, p }), ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.months.length, 12); assert.deepEqual(ledger.months[0], { key: '2026-01', label: 'Ene', withinHorizon: true });
  assert.equal(ledger.openingBalance, 1000); assert.equal(ledger.cashNow, 1021); assert.equal(ledger.closingBalance, 921);
  assert.deepEqual(ledger.totals, { actualIn: 121, actualOut: 100, expectedIn: 0, expectedOut: 100, net: -79 });
  assert.equal(ledger.series[10].actualBalance, 1021); assert.equal(ledger.series[11].actualBalance, null);
  assert.equal(ledger.series[11].closingBalance, ledger.projection.cashAtHorizon);
  assert.deepEqual({ s, p }, before);
});

test('invoice document date alone never counts as cash received', () => {
  const s = fixture(); s.documents = [invoice('unpaid')];
  const ledger = forecastLedger(s, plan(), { today: TODAY });
  assert.equal(ledger.totals.actualIn, 0); assert.equal(ledger.totals.expectedIn, 121);
  assert.equal(cell(ledger, 'invoice:unpaid', '12').expected, 121);
});

test('a linked record replaces one occurrence with its own amount while the following month remains', () => {
  const s = fixture(), p = plan(); s.expenses = [expense('receipt')]; p.items = [item('service', { linkedRecordIds: ['receipt'] })];
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.rows.length, 1);
  assert.equal(cell(ledger, 'forecast:service', '11').actual, -121);
  assert.equal(cell(ledger, 'forecast:service', '11').expected, 0);
  assert.equal(cell(ledger, 'forecast:service', '12').expected, -100);
  assert.deepEqual(ledger.rows[0].recordIds, ['receipt']);
  assert.equal(ledger.overdueOccurrences.length, 0);
});

test('document period and late bank payment remain separate instead of consuming the next recurring month', () => {
  const s = fixture(), p = plan(); p.settings.asOf = '2026-10-20'; p.settings.horizon = '2026-11-30';
  s.expenses = [expense('late', { date: '2026-10-10', paidDate: '2026-11-05' })];
  p.items = [item('service', { startDate: '2026-10-10', linkedRecordIds: ['late'] })];
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.totals.actualOut, 0); assert.equal(ledger.totals.expectedOut, 221);
  assert.equal(cell(ledger, 'forecast:service', '11').expected, -221);
  assert.equal(ledger.overdueOccurrences.length, 0);
  assert.deepEqual(ledger.projection.occurrences.map(row => row.date), ['2026-11-10']);
});

test('partial invoice collections retain the remaining expected amount on the same linked row', () => {
  const s = fixture(), p = plan(); s.documents = [invoice('partial', { status: 'partial', dueDate: '2026-11-30' })];
  s.payments = [{ id: 'part', documentId: 'partial', date: '2026-11-15', amount: 60 }];
  p.items = [item('work', { kind: 'income', amountGross: 999, recurrence: 'once', startDate: '2026-11-30', linkedRecordIds: ['partial'] })];
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.rows.length, 1); assert.equal(ledger.totals.actualIn, 60); assert.equal(ledger.totals.expectedIn, 61);
  assert.equal(cell(ledger, 'forecast:work', '11').total, 121);
  assert.deepEqual(cell(ledger, 'forecast:work', '11').entries.map(row => row.status), ['actual', 'expected']);
});

test('future-dated registered payments are expected and do not duplicate the residual', () => {
  const s = fixture(), p = plan(); s.documents = [invoice('partial', { status: 'partial', dueDate: '2026-11-30' })];
  s.payments = [{ id: 'past', documentId: 'partial', date: '2026-11-15', amount: 60 }, { id: 'next', documentId: 'partial', date: '2026-12-05', amount: 40 }];
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.totals.actualIn, 60); assert.equal(ledger.totals.expectedIn, 61);
  assert.equal(cell(ledger, 'invoice:partial', '11').expected, 21); assert.equal(cell(ledger, 'invoice:partial', '12').expected, 40);
});

test('a supplier invoice received but not paid remains expected rather than actual bank cash', () => {
  const s = fixture(); s.expenses = [expense('received', { paidDate: null, paymentStatus: 'pending', dueDate: '2026-12-10' })];
  const ledger = forecastLedger(s, plan(), { today: TODAY });
  assert.equal(ledger.totals.actualOut, 0); assert.equal(ledger.totals.expectedOut, 121);
  assert.equal(cell(ledger, 'expense:received', '12').expected, -121);
});

test('refund and tax settlement movements preserve real signed bank amounts and linked taxes count once', () => {
  const s = fixture();
  s.expenses = [expense('refund', { kind: 'credit', base: -100, vatAmount: -21, total: -121, vatDeductibleAmount: -21,
    cashMovements: [{ date: '2026-10-15', amount: 100 }, { date: '2026-11-15', amount: -121 }] })];
  s.taxRecords = [{ id: 'tax-paid', model: '303', year: 2026, quarter: 3, date: '2026-10-20', paidDate: '2026-10-20', amount: 40, paymentStatus: 'paid' },
    { id: 'tax-included', model: '111', year: 2026, quarter: 3, date: '2026-10-20', paidDate: null, amount: 50, paymentStatus: 'included', linkedExpenseId: 'refund' },
    { id: 'tax-due', model: '303', year: 2026, quarter: 4, date: '2026-12-20', amount: 60, paymentStatus: 'pending' }];
  const ledger = forecastLedger(s, plan(), { today: TODAY });
  assert.equal(ledger.totals.actualIn, 121); assert.equal(ledger.totals.actualOut, 140); assert.equal(ledger.totals.expectedOut, 60);
  assert.equal(ledger.rows.find(row => row.id === 'tax:tax-due').kind, 'tax');
  assert.equal(ledger.closingBalance, 921);
});

test('identical repeated records are deduplicated and conflicting duplicates fail', () => {
  const s = fixture(); s.expenses = [expense('one')]; s.expenses.push(structuredClone(s.expenses[0]));
  assert.equal(forecastLedger(s, plan(), { today: TODAY }).totals.actualOut, 121);
  s.expenses[1].base = 200;
  assert.throws(() => forecastLedger(s, plan(), { today: TODAY }), /versiones distintas/);
});

test('same ID in invoice and expense collections does not overwrite direction-specific linkage', () => {
  const s = fixture(), p = plan(); s.documents = [invoice('same')]; s.expenses = [expense('same')];
  p.items = [item('income', { kind: 'income', amountGross: 999, recurrence: 'once', startDate: '2026-12-10', linkedRecordIds: ['same'] })];
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.totals.actualOut, 121); assert.equal(ledger.totals.expectedIn, 121);
  assert.equal(ledger.rows.find(row => row.id === 'forecast:income').expected, 121);
  assert.equal(ledger.rows.find(row => row.id === 'expense:same').actual, -121);
});

test('ambiguous expense/tax links warn and never silently choose one collection', () => {
  const s = fixture(), p = plan(); s.expenses = [expense('ambiguous')];
  s.taxRecords = [{ id: 'ambiguous', model: '303', year: 2026, quarter: 3, date: '2026-11-10', paidDate: '2026-11-10', amount: 40, paymentStatus: 'paid' }];
  p.items = [item('service', { linkedRecordIds: ['ambiguous'] })];
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.ok(ledger.warnings.some(w => /coincide con varios/.test(w)));
  assert.equal(ledger.rows.find(row => row.id === 'expense:ambiguous').actual, -121);
  assert.equal(ledger.rows.find(row => row.id === 'tax:ambiguous').actual, -40);
});

test('accepted quotes linked to issued invoices transfer their row relationship without duplicate income', () => {
  const s = fixture(), p = plan(); s.documents = [invoice('quote', { kind: 'quote', status: 'accepted', number: 'PR-1' }), invoice('child', { quoteId: 'quote' })];
  p.settings.collectionDates.quote = '2026-12-20';
  p.items = [item('work', { kind: 'income', amountGross: 999, recurrence: 'once', startDate: '2026-12-10', linkedRecordIds: ['quote'] })];
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.totals.expectedIn, 121); assert.equal(ledger.rows.length, 1);
  assert.deepEqual(ledger.rows[0].recordIds, ['child']);
});

test('overdue invoices without collection date are visible without assuming a cash date', () => {
  const s = fixture(); s.documents = [invoice('late', { dueDate: '2026-11-01' })];
  const ledger = forecastLedger(s, plan(), { today: TODAY });
  assert.equal(ledger.totals.expectedIn, 0); assert.equal(ledger.unscheduled.length, 1);
  assert.equal(ledger.unscheduled[0].id, 'late'); assert.ok(ledger.warnings.some(w => /fecha prevista/.test(w)));
});

test('past unlinked forecasts remain visible for review without creating a debt or reducing known cash', () => {
  const p = plan(); p.items = [item('once', { startDate: '2026-11-10', recurrence: 'once' })];
  const ledger = forecastLedger(fixture(), p, { today: TODAY });
  assert.equal(ledger.overdueOccurrences.length, 1); assert.equal(ledger.overdueOccurrences[0].itemId, 'once');
  assert.equal(ledger.totals.expectedOut, 0); assert.equal(ledger.closingBalance, 1000);
});

test('a starting balance known only mid-year leaves earlier monthly balances unknown', () => {
  const s = fixture(); s.company.openingBalanceDate = '2026-09-01'; s.company.openingBalance = 5000;
  s.expenses = [expense('before', { date: '2026-02-01', paidDate: '2026-02-01' }), expense('after', { date: '2026-10-01', paidDate: '2026-10-01' })];
  const ledger = forecastLedger(s, plan(), { today: TODAY });
  assert.equal(ledger.openingBalance, null); assert.equal(ledger.balanceKnownFrom, '2026-09-01');
  assert.equal(ledger.series[7].closingBalance, null); assert.equal(ledger.series[8].closingBalance, 5000);
  assert.equal(ledger.series[10].actualBalance, 4879); assert.equal(ledger.totals.actualOut, 242);
  assert.equal(ledger.closingBalance, ledger.projection.cashAtHorizon);
});

test('a manual balance anchors the cutoff and does not manufacture prior monthly balances', () => {
  const p = plan(); p.settings.cashBalanceOverride = 2500; p.items = [item('next', { startDate: '2026-12-10' })];
  const ledger = forecastLedger(fixture(), p, { today: TODAY });
  assert.equal(ledger.balanceKnownFrom, TODAY); assert.equal(ledger.openingBalance, null);
  assert.equal(ledger.series[9].closingBalance, null); assert.equal(ledger.series[10].actualBalance, 2500);
  assert.equal(ledger.closingBalance, 2400); assert.equal(ledger.balanceSource, 'manual');
});

test('missing cash configuration preserves cash balances as unknown rather than zero', () => {
  const s = fixture(); s.company = {}; const ledger = forecastLedger(s, plan(), { today: TODAY });
  assert.equal(ledger.cashNow, null); assert.equal(ledger.openingBalance, null); assert.equal(ledger.closingBalance, null);
  assert.ok(ledger.series.every(row => row.closingBalance === null));
});

test('gross cash with VAT remains separate from fiscal profit and operating cost', () => {
  const p = plan(); p.items = [item('next', { startDate: '2026-12-10', amountGross: 121, vatRate: 21, vatDeductible: true })];
  const ledger = forecastLedger(fixture(), p, { today: TODAY });
  assert.equal(ledger.totals.expectedOut, 121); assert.equal(ledger.projection.forecastProfitCost, 100);
  assert.equal(ledger.closingBalance, 879);
});

test('changing tax year keeps twelve selected-year months and retains projected balance source', () => {
  const p = plan(); p.settings.taxYear = 2027; p.settings.horizon = '2027-12-31';
  p.items = [item('next-year', { startDate: '2027-01-10', recurrence: 'once' })];
  const ledger = forecastLedger(fixture(), p, { today: TODAY });
  assert.equal(ledger.months[0].key, '2027-01'); assert.equal(ledger.months[11].key, '2027-12');
  assert.equal(ledger.openingBalance, 1000); assert.equal(ledger.closingBalance, 900);
  assert.ok(ledger.series.every(row => row.actualBalance === null));
});

test('projection itself uses document periods for explicit links and remains future-only', () => {
  const s = fixture(), p = plan(); p.settings.asOf = '2026-10-20'; p.settings.horizon = '2026-11-30';
  s.expenses = [expense('late', { date: '2026-10-10', paidDate: '2026-11-05' })];
  p.items = [item('service', { startDate: '2026-10-10', linkedRecordIds: ['late'] })];
  const projection = planningProjection(s, p, { today: TODAY });
  assert.equal(projection.forecastCashOut, 100); assert.equal(projection.cashAtHorizon, 779);
});

test('a linked accepted quote uses its explicit expected period rather than its creation month', () => {
  const s = fixture(), p = plan(); s.documents = [invoice('quote', { kind: 'quote', status: 'accepted', date: '2026-10-10' })];
  p.settings.collectionDates.quote = '2026-12-15';
  p.items = [item('income', { kind: 'income', startDate: '2026-12-10', amountGross: 999, linkedRecordIds: ['quote'] })];
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.totals.expectedIn, 121); assert.equal(ledger.rows.length, 1);
  assert.equal(cell(ledger, 'forecast:income', '12').expected, 121);
});

test('several future bank movements on the same date keep unique entry IDs and exact signed sums', () => {
  const s = fixture(); s.expenses = [expense('mixed', { cashMovements: [
    { date: '2026-12-05', amount: 100 }, { date: '2026-12-05', amount: -21 }, { date: '2026-12-05', amount: 42 },
  ] })];
  const ledger = forecastLedger(s, plan(), { today: TODAY }), entries = cell(ledger, 'expense:mixed', '12').entries;
  assert.equal(new Set(entries.map(row => row.id)).size, 3);
  assert.equal(ledger.totals.expectedOut, 142); assert.equal(ledger.totals.expectedIn, 21);
  assert.equal(cell(ledger, 'expense:mixed', '12').expected, -121); assert.equal(ledger.closingBalance, 879);
});

test('linking an unconfirmed tax or supplier payment preserves the forecast until payment status is resolved', () => {
  for (const type of ['tax', 'expense']) {
    const s = fixture(), p = plan();
    if (type === 'tax') s.taxRecords = [{ id: 'uncertain', model: '111', date: '2026-12-10', year: 2026, quarter: 4, amount: 60, paymentStatus: 'unconfirmed' }];
    else s.expenses = [expense('uncertain', { date: '2026-12-10', paidDate: null, paymentStatus: 'unconfirmed' })];
    p.items = [item('planned', { recurrence: 'once', amountGross: 60, startDate: '2026-12-10', linkedRecordIds: ['uncertain'] })];
    const ledger = forecastLedger(s, p, { today: TODAY });
    assert.equal(ledger.totals.expectedOut, 60); assert.equal(ledger.closingBalance, 940);
    assert.ok(ledger.unscheduled.some(row => row.id === 'uncertain')); assert.ok(ledger.warnings.some(w => /pago no está confirmado/.test(w)));
  }
});

test('a tax included in a supplier payment uses that bank movement once and replaces its linked forecast', () => {
  const s = fixture(), p = plan(); s.expenses = [expense('bank', { date: '2026-12-10', paidDate: '2026-12-10', base: 60, vatAmount: 0, total: 60, vatDeductibleAmount: 0 })];
  s.taxRecords = [{ id: 'tax', model: '111', year: 2026, quarter: 4, date: '2026-12-10', amount: 60, paymentStatus: 'included', linkedExpenseId: 'bank' }];
  p.items = [item('planned', { recurrence: 'once', amountGross: 60, startDate: '2026-12-10', treatment: 'tax', linkedRecordIds: ['tax'] })];
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.totals.expectedOut, 60); assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].id, 'forecast:planned'); assert.deepEqual(ledger.rows[0].recordIds, ['bank']);
});

test('a manual January first closing balance is not presented as the opening balance before that days movements', () => {
  const s = fixture(), p = plan(); p.settings.asOf = '2026-01-01'; p.settings.cashBalanceOverride = 1000;
  s.documents = [invoice('sale', { date: '2026-01-01' })];
  s.payments = [{ id: 'cash', documentId: 'sale', date: '2026-01-01', amount: 100 }];
  p.settings.collectionDates.sale = '2026-01-05';
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.openingBalance, null); assert.equal(ledger.cashNow, 1000);
  assert.equal(ledger.closingBalance, 1021); assert.equal(ledger.totals.actualIn, 100);
});

test('offsetting bank movements retain their rows, gross totals and detail even when the net amount is zero', () => {
  for (const dates of [['2026-10-15', '2026-11-15'], ['2026-11-15', '2026-11-15']]) {
    const s = fixture(); s.expenses = [expense('offset', { cashMovements: [{ date: dates[0], amount: 100 }, { date: dates[1], amount: -100 }] })];
    const ledger = forecastLedger(s, plan(), { today: TODAY });
    assert.equal(ledger.rows.length, 1); assert.equal(ledger.rows[0].actual, 0);
    assert.equal(ledger.totals.actualIn, 100); assert.equal(ledger.totals.actualOut, 100); assert.equal(ledger.closingBalance, 1000);
    assert.equal(Object.values(ledger.rows[0].months).flatMap(cell => cell.entries).length, 2);
  }
});

test('annual cash view ends in December while the shared scenario projection retains a longer horizon', () => {
  const s = fixture(), p = plan(); p.settings.horizon = '2027-01-31';
  p.items = [item('december', { recurrence: 'once', startDate: '2026-12-10', amountGross: 100 }),
    item('january', { recurrence: 'once', startDate: '2027-01-10', amountGross: 200 })];
  const before = structuredClone(p), ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.year, 2026); assert.equal(ledger.totals.expectedOut, 100); assert.equal(ledger.closingBalance, 900);
  assert.equal(ledger.series[11].closingBalance, 900); assert.equal(ledger.projection.cashAtHorizon, 700);
  assert.equal(ledger.horizon, '2027-01-31'); assert.equal(ledger.projection.horizon, '2027-01-31');
  assert.deepEqual(p, before);
});

test('a horizon ending during the selected year leaves later monthly balances unknown and excludes later forecasts', () => {
  const s = fixture(), p = plan(); p.settings.horizon = '2026-11-30';
  p.items = [item('november', { recurrence: 'once', startDate: '2026-11-28', amountGross: 100 }),
    item('december', { recurrence: 'once', startDate: '2026-12-10', amountGross: 200 })];
  const ledger = forecastLedger(s, p, { today: TODAY });
  assert.equal(ledger.totals.expectedOut, 100); assert.equal(ledger.closingBalance, 900);
  assert.equal(ledger.series[10].closingBalance, 900); assert.equal(ledger.series[11].closingBalance, null);
  assert.equal(ledger.months[11].withinHorizon, false); assert.equal(ledger.closingBalance, ledger.projection.cashAtHorizon);
});

test('VAT reconciliation exposes existing components without counting forecast VAT twice', () => {
  const s = fixture(), p = plan(); s.documents = [invoice('sale', { items: [{ quantity: 1, price: 1000 }] })]; s.expenses = [expense('cost')];
  s.taxRecords = [{ id: 'settled', model: '303', year: 2026, quarter: 3, date: '2026-10-20', paidDate: '2026-11-15', amount: 50, paymentStatus: 'paid' }];
  p.items = [item('cost-plan', { recurrence: 'once', startDate: '2026-12-10', amountGross: 121, vatRate: 21, vatDeductible: true }),
    item('sale-plan', { kind: 'income', recurrence: 'once', startDate: '2026-12-10', amountGross: 121, vatRate: 21 })];
  const { projection } = forecastLedger(s, p, { today: TODAY });
  assert.deepEqual(projection.vatCalculation, { from: '2026-01-01', to: '2026-12-31', outputVAT: 231, inputVAT: 42,
    priorVATCredit: 0, settledVAT: 50, forecastOutputVAT: 21, forecastInputVAT: 21 });
  assert.equal(projection.vatReserve, 139);
  const vat = projection.vatCalculation;
  assert.equal(vat.outputVAT - vat.inputVAT - vat.priorVATCredit - vat.settledVAT, projection.vatReserve);
});
