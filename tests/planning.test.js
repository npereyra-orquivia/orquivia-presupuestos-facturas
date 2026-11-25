import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlanning, normalizePlanning, expandForecast, planningProjection, simulatePlanningScenario, suggestForecastItems } from '../src/planning.js';

// Synthetic identities, dates and financial examples only; no company records.
const TODAY = '2026-11-20';
const state = () => ({ company: { name: 'Ejemplo', openingBalance: 20000, openingBalanceDate: '2026-01-01' }, clients: [], documents: [], expenses: [], payments: [], taxRecords: [] });
const invoice = (id, date, base, extra = {}) => ({ id, kind: 'invoice', number: id, date, dueDate: '2026-12-10', status: 'issued', items: [{ quantity: 1, price: base }], vat: 21, withholding: 0, discount: 0, ...extra });
const expense = (id, date, base, extra = {}) => ({ id, date, paidDate: date, supplier: 'Proveedor ejemplo', description: 'Servicio sintético', category: 'Servicios', base, vatAmount: base * .21,
  vatDeductibleAmount: base * .21, total: Math.round(base * 121) / 100, paymentStatus: 'paid', attachments: [{ id: 'example' }], ...extra });
const plan = () => {
  const p = defaultPlanning({ today: TODAY }); p.settings.profitOverride = 12000; p.settings.corporateTaxConfirmed = true; p.settings.legalReservePending = 600;
  Object.assign(p.settings.people[0], { name: 'Responsable A', taxProfileKnown: true, externalSalary: 40000, employeeSS: 2500, retaAnnual: 1000, isShareholder: true, sharePercent: 100 });
  p.settings.people[1].name = 'Responsable B'; return p;
};
const item = (id, extra = {}) => ({ id, label: 'Previsión sintética', kind: 'expense', amountGross: 121, vatRate: 21, vatDeductible: true, treatment: 'operating',
  recurrence: 'monthly', startDate: '2026-12-10', endDate: null, active: true, linkedRecordIds: [], ...extra });
const allocation = (workGross = 0, dividendGross = 0, personId = 'person-1') => ({ personId, workGross, dividendGross });
const scenario = (people, extra = {}) => ({ id: 'case-1', name: 'Escenario sintético', notes: '', dividendDate: null, people, ...extra });
const totalSegments = result => Math.round(result.segments.reduce((n, row) => n + row.amount, 0) * 100) / 100;

test('defaults contain no inferred salary, shareholding, cash or tax confirmation', () => {
  const p = defaultPlanning({ today: TODAY });
  assert.equal(p.settings.horizon, '2026-12-31'); assert.equal(p.settings.cashBalanceOverride, null);
  assert.equal(p.settings.people[0].taxProfileKnown, false); assert.equal(p.settings.people[0].externalSalary, 0);
  assert.equal(p.settings.people[0].isShareholder, false); assert.equal(p.settings.corporateTaxConfirmed, false);
  assert.deepEqual(normalizePlanning(undefined, { today: TODAY }), p);
  assert.throws(() => normalizePlanning({ ...p, settings: { ...p.settings, minimumCash: -1 } }), /importe|mínimo|negativ|inválid/i);
});

test('calendar recurrence preserves original month-end and leap anchors', () => {
  const monthly = expandForecast([item('month', { startDate: '2027-01-31' })], { from: '2027-01-01', to: '2027-04-30' });
  assert.deepEqual(monthly.map(r => r.date), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  const yearly = expandForecast([item('year', { startDate: '2024-02-29', recurrence: 'yearly' })], { from: '2024-01-01', to: '2028-12-31' });
  assert.deepEqual(yearly.map(r => r.date), ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  const quarterly = expandForecast([item('quarter', { startDate: '2026-01-31', recurrence: 'quarterly', endDate: '2026-07-31' })], { from: '2026-02-01', to: '2026-12-31' });
  assert.deepEqual(quarterly.map(r => r.date), ['2026-04-30', '2026-07-31']);
});

test('forecast is future-only, recurrence is bounded and no input is mutated', () => {
  const s = state(), p = plan(); p.items = [item('old', { startDate: '2026-10-10' }), item('disabled', { active: false })];
  const before = structuredClone({ s, p }), r = planningProjection(s, p, { today: TODAY });
  assert.deepEqual(r.occurrences.map(row => row.date), ['2026-12-10']);
  assert.equal(r.forecastCashOut, 121); assert.equal(r.forecastProfitCost, 100);
  assert.deepEqual({ s, p }, before);
  p.settings.horizon = TODAY; assert.equal(planningProjection(s, p).occurrences.length, 0);
});

test('asset purchases affect cash, operating VAT costs depend on explicit deductibility', () => {
  const s = state(), p = plan();
  p.items = [item('equipment', { amountGross: 1210, recurrence: 'once', treatment: 'asset' }), item('phone'), item('not-deductible', { vatDeductible: false })];
  const r = planningProjection(s, p);
  assert.equal(r.forecastCashOut, 1452); assert.equal(r.forecastProfitCost, 221);
  assert.equal(r.baseProfit, 11779); assert.equal(r.cashAtHorizon, 18548);
  assert.ok(r.warnings.some(w => /amortización/.test(w)));
  p.items = [item('tax', { amountGross: 100, treatment: 'tax', vatDeductible: true })];
  const tax = planningProjection(s, p); assert.equal(tax.baseProfit, 12000); assert.equal(tax.vatReserve, 0); assert.equal(tax.forecastCashOut, 100);
});

test('an explicitly linked future expense replaces the same recurring occurrence once', () => {
  const s = state(), p = plan(); s.expenses = [expense('booked', '2026-12-15', 100, { paymentStatus: 'pending' })];
  p.items = [item('future', { linkedRecordIds: ['booked'] })];
  const r = planningProjection(s, p);
  assert.equal(r.occurrences.length, 0); assert.equal(r.forecastCashOut, 0);
  assert.equal(r.cashAtHorizon, 19879); assert.equal(r.baseProfit, 11900);
});

test('issued invoices, recorded future payments and accepted quotes never double count', () => {
  const s = state(), p = plan();
  s.documents = [invoice('invoice', '2026-10-10', 100), invoice('accepted', '2026-10-01', 100, { kind: 'quote', status: 'accepted' }),
    invoice('unaccepted', '2026-10-01', 500, { kind: 'quote', status: 'sent' }),
    invoice('converted', '2026-10-01', 300, { kind: 'quote', status: 'accepted' }), invoice('child', '2026-10-02', 300, { quoteId: 'converted' })];
  s.payments = [{ id: 'old', documentId: 'invoice', date: '2026-10-20', amount: 21 }, { id: 'future', documentId: 'invoice', date: '2026-12-05', amount: 40 }];
  p.settings.collectionDates = { invoice: '2026-12-10', accepted: '2026-12-12', converted: '2026-12-12', unaccepted: '2026-12-12' };
  const r = planningProjection(s, p);
  assert.equal(r.receivables.some(row => row.id === 'converted'), false); assert.equal(r.receivables.some(row => row.id === 'unaccepted'), false);
  assert.equal(r.receivables.find(row => row.id === 'invoice').amount, 100); assert.equal(r.receivables.find(row => row.id === 'invoice').amountScheduled, 60);
  const collections = r.flows.filter(row => ['invoice-collection', 'recorded-collection', 'accepted-quote'].includes(row.kind));
  assert.equal(collections.reduce((n, row) => n + row.amount, 0), 584);
  assert.equal(r.forecastProfitIncome, 100);
});

test('overdue invoices need an explicit date and quotes not yet converted remain dated forecasts', () => {
  const s = state(), p = plan(); s.documents = [invoice('past', '2026-09-02', 100, { dueDate: '2026-10-01' })];
  const r = planningProjection(s, p); assert.equal(r.receivables[0].date, null); assert.equal(r.flows.length, 0);
  assert.ok(r.warnings.some(w => /fecha prevista/.test(w)));
  p.settings.collectionDates.past = '2026-11-30'; const dated = planningProjection(s, p);
  assert.equal(dated.flows[0].amount, 121); assert.equal(dated.cashAtHorizon, 20121);
});

test('identical repeated records are counted once, conflicting duplicates fail', () => {
  const s = state(), p = plan(), d = invoice('one', '2026-10-10', 100);
  s.documents = [d, structuredClone(d)]; s.payments = [{ id: 'payment', documentId: 'one', date: '2026-10-12', amount: 121 }]; s.payments.push(structuredClone(s.payments[0]));
  assert.equal(planningProjection(s, p).cashNow, 20121);
  s.documents[1].items[0].price = 200; assert.throws(() => planningProjection(s, p), /versiones distintas/);
});

test('accountant close is used once and later unknown VAT is a visible gross estimate', () => {
  const s = state(), p = plan(); p.settings.profitOverride = null;
  s.company.taxId = 'B00000000'; s.company.accountantClose = {
    format: 'orquivia-accountant-close', version: 1, from: '2026-01-01', asOf: '2026-09-30', issuedAt: '2026-10-01', taxId: 'B00000000', source: 'Cierre sintético',
    sources: [{ name: 'example.pdf', sha256: 'a'.repeat(64) }], notes: [], taxFilings: [], profitLoss: { sales: 10000, expenses: [{ account: '623', label: 'Servicios', amount: 1000 }], resultBeforeTax: 9000, result: 9000, corporateTax: null },
    balance: { assets: [{ account: '572', label: 'Banco', amount: 12000 }], liabilities: [], equity: [{ account: '100', label: 'Capital', amount: 3000 }, { account: '129', label: 'Resultado', amount: 9000 }] },
  };
  s.documents = [invoice('old', '2026-09-01', 10000), invoice('later', '2026-10-10', 200)];
  s.expenses = [expense('unknown', '2026-10-15', 50, { total: 50, base: 50, vatAmount: 0, vatDeductibleAmount: 0, vatReviewNeeded: true })];
  assert.equal(planningProjection(s, p).baseProfit, 9150);
  p.settings.pendingCosts = 'exclude'; assert.equal(planningProjection(s, p).baseProfit, 9200);
  assert.equal(planningProjection(s, p).pendingCosts, 50);
});

test('future year costs affect cash without reducing this year profit', () => {
  const p = plan(); p.settings.horizon = '2027-02-28'; p.items = [item('next-year', { startDate: '2027-01-05', recurrence: 'once' })];
  const r = planningProjection(state(), p); assert.equal(r.baseProfit, 12000); assert.equal(r.forecastCashOut, 121); assert.equal(r.forecastProfitCost, 0);
  assert.equal(r.corporateTaxExpectedMonth, '2027-07');
});

test('progressive incremental tax crosses only the affected brackets and reduces corporate tax', () => {
  const p = plan(), projection = planningProjection(state(), p), r = simulatePlanningScenario(projection, scenario([allocation(1000)]));
  assert.equal(r.people[0].personalTax, 350.5); assert.equal(r.people[0].personalNet, 649.5);
  assert.equal(r.companyTax, 1650); assert.equal(r.companyRetained, 9350); assert.equal(r.taxTotal, 2000.5);
  assert.equal(totalSegments(r), projection.baseProfit);
  assert.equal(simulatePlanningScenario(projection, scenario([])).companyTax - r.companyTax, 150);
});

test('unknown or low-income profiles never pretend gross is personal net', () => {
  const p = plan(), q = planningProjection(state(), p);
  const unknown = simulatePlanningScenario(q, scenario([allocation(6000, 0, 'person-2')]));
  assert.equal(unknown.people[1].personalTax, null); assert.equal(unknown.totalPersonalNet, null);
  assert.ok(unknown.segments.find(row => row.personId === 'person-2' && row.pending)); assert.equal(totalSegments(unknown), 12000);
  Object.assign(p.settings.people[1], { taxProfileKnown: true, externalSalary: 0 });
  const low = simulatePlanningScenario(q, scenario([allocation(6000, 0, 'person-2')]), p.settings);
  assert.equal(low.people[1].workTax, null); assert.ok(low.warnings.some(w => /renta baja/.test(w)));
  const lowDividend = simulatePlanningScenario(q, scenario([allocation(0, 100, 'person-2')]), p.settings);
  assert.equal(lowDividend.people[1].dividendTax, null); assert.ok(lowDividend.warnings.some(w => /mínimo personal/.test(w)));
});

test('employer costs reduce company profit and are not invented as personal contributions', () => {
  const p = plan(); p.settings.people[0].employerContributionRate = 10;
  const r = simulatePlanningScenario(planningProjection(state(), p), scenario([allocation(1000)]));
  assert.equal(r.employerCosts, 100); assert.equal(r.companyTax, 1635); assert.equal(r.companyRetained, 9265);
  assert.equal(r.people[0].personalTax, null); assert.equal(totalSegments(r), 12000);
});

test('dividends do not reduce corporate tax and occur after the year-end in cash', () => {
  const p = plan(), q = planningProjection(state(), p), r = simulatePlanningScenario(q, scenario([allocation(0, 9000)]));
  assert.equal(r.companyTax, 1800); assert.equal(r.people[0].dividendTax, 1770); assert.equal(r.people[0].personalNet, 7230);
  assert.equal(r.cashAtHorizon, 20000); assert.equal(r.cashAfterDistributions, 9200); assert.equal(r.dividendYear, 2027);
  assert.equal(totalSegments(r), 12000); assert.ok(r.warnings.some(w => /2027/.test(w)));
  p.settings.horizon = '2027-07-02'; const later = simulatePlanningScenario(planningProjection(state(), p), scenario([allocation(0, 9000)]));
  assert.equal(later.cashAtHorizon, 11000);
  const premature = simulatePlanningScenario(q, scenario([allocation(0, 100)], { dividendDate: '2026-12-20' }));
  assert.equal(premature.valid, false); assert.ok(premature.issues.some(w => /tras el cierre/.test(w)));
});

test('shareholder eligibility, proportional shares, reserves and cash prevent false valid payouts', () => {
  const p = plan(); Object.assign(p.settings.people[0], { sharePercent: 60 }); Object.assign(p.settings.people[1], { isShareholder: true, sharePercent: 40 });
  const q = planningProjection(state(), p), shared = simulatePlanningScenario(q, scenario([allocation(0, 600), allocation(0, 400, 'person-2')]));
  assert.equal(shared.issues.length, 0); assert.equal(shared.totalPersonalTax, null);
  assert.ok(simulatePlanningScenario(q, scenario([allocation(0, 1000)])).issues.some(w => /porcentaje/.test(w)));
  p.settings.people[1].isShareholder = false;
  assert.ok(simulatePlanningScenario(q, scenario([allocation(0, 100, 'person-2')]), p.settings).issues.some(w => /participación/.test(w)));
  const all = simulatePlanningScenario(q, scenario([allocation(12000)])); assert.equal(all.companyTax, 0); assert.equal(all.distributableProfit, 0);
  const small = simulatePlanningScenario(q, scenario([allocation(11500)])); assert.equal(small.reserveRequired, 42.5);
  p.settings.minimumCash = 25000; assert.ok(simulatePlanningScenario(q, scenario([]), p.settings).issues.some(w => /colchón/.test(w)));
  assert.throws(() => simulatePlanningScenario(q, scenario([allocation(1), allocation(2)])), /repetidas/);
});

test('tax year and RETA periods remain explicit rather than applying current rules to future income', () => {
  const p = plan(); p.settings.taxYear = 2027; p.settings.horizon = '2027-12-31'; p.settings.people[0].retaPeriod = 'extension'; p.settings.people[0].retaYear = 2027;
  const q = planningProjection(state(), p), r = simulatePlanningScenario(q, scenario([allocation(1000, 100)]));
  assert.equal(r.people[0].workTax, null); assert.ok(q.warnings.some(w => /tarifas personales/.test(w)));
  assert.ok(r.people[0].retaWarnings.some(w => /18.004/.test(w)));
});

test('recurring suggestions require multiple paid months and explicit acceptance', () => {
  const s = state(), p = plan(); s.expenses = [expense('a', '2026-10-10', 60, { vatRate: 21 }), expense('b', '2026-11-10', 60, { vatRate: 21 }), expense('one-off', '2026-11-02', 320, { supplier: 'Proveedor puntual' })];
  const original = structuredClone(s), suggestions = suggestForecastItems(s, p);
  assert.equal(suggestions.length, 1); assert.equal(suggestions[0].startDate, '2026-12-10'); assert.equal(suggestions[0].amountGross, 72.6);
  assert.equal(suggestions[0].evidence.months, 2); assert.equal(p.items.length, 0); assert.deepEqual(s, original);
  const { evidence, ...accepted } = suggestions[0]; p.items.push(accepted);
  assert.equal(suggestForecastItems(s, p).length, 0);
  assert.equal(planningProjection(s, p).occurrences.length, 1);
});
