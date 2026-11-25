import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlanning } from '../src/planning.js';
import { newDistributionOperation, scenarioOperations, aggregateDistributionPeople, simulateDistribution, operationMaximum } from '../src/distribution.js';

const settings = () => {
  const s = defaultPlanning({ today: '2026-11-20' }).settings;
  s.corporateTaxConfirmed = true; s.legalReservePending = 600; s.minimumCash = 500;
  for (const [i, p] of s.people.entries()) Object.assign(p, { name: `Responsable ${i + 1}`, taxProfileKnown: true, externalSalary: 40000, employeeSS: 2500, retaAnnual: 1000, sharePercent: i ? 0 : 100, isShareholder: i === 0 });
  return s;
};
const projection = (s = settings(), extra = {}) => ({ settings: s, baseProfit: 20000, cashAtHorizon: 25000, asOf: '2026-11-20', horizon: '2026-12-31', vatReserve: 1000, corporateTaxExpectedMonth: '2027-07', ...extra });
const op = (id, kind, amount, extra = {}) => ({ ...newDistributionOperation(kind, kind === 'expense' ? null : 'person-1'), id, label: `Operación ${id}`, amount, taxTreatmentConfirmed: true, ...extra });
const scenario = operations => ({ id: 'scenario', name: 'Ejemplo', notes: '', dividendDate: null, people: [], operations });
const cents = n => Math.round(n * 100);
const chartAllocation = result => result.bars.reduce((total, bar) => total + cents(bar.net === null ? bar.unknownGross : bar.net) + cents(bar.tax || 0) + cents(bar.socialCosts || 0), 0);

test('new operations have safe class-specific defaults and unique IDs', () => {
  const a = newDistributionOperation('salary', 'person-1'), b = newDistributionOperation('salary', 'person-1');
  assert.notEqual(a.id, b.id); assert.equal(a.taxTreatmentConfirmed, false); assert.equal(a.withholdingRate, null); assert.equal(a.deductible, true);
  assert.equal(newDistributionOperation('dividend', 'person-1').deductible, false);
  assert.equal(newDistributionOperation('expense', 'ignored').personId, null);
  assert.throws(() => newDistributionOperation('unsupported', 'person-1'));
});

test('legacy conversion is stable and never added to authoritative sidecar operations', () => {
  const s = settings(), legacy = { id: 'old', people: [{ personId: 'person-1', workGross: 900, dividendGross: 100 }] };
  const first = scenarioOperations({}, legacy, s), again = scenarioOperations({}, legacy, s);
  assert.deepEqual(first, again); assert.equal(first[0].kind, 'legacy-work'); assert.equal(first[0].taxTreatmentConfirmed, false);
  assert.deepEqual(aggregateDistributionPeople(first, s)[0], { personId: 'person-1', workGross: 900, dividendGross: 100 });
  const saved = [op('new', 'administrator', 200)];
  assert.deepEqual(scenarioOperations({ planningExtensions: { scenarios: [{ scenarioId: 'old', operations: saved }] } }, legacy, s), saved);
  assert.deepEqual(scenarioOperations({}, { ...legacy, operations: [] }, s), []);
  assert.equal(legacy.people[0].workGross, 900);
});

test('legacy conversion preserves the employer contribution recorded by the previous scenario', () => {
  const s = settings(); s.people[0].employerContributionRate = 30;
  const legacy = { id: 'old-cost', people: [{ personId: 'person-1', workGross: 1000, dividendGross: 0 }] };
  const operations = scenarioOperations({}, legacy, s);
  assert.equal(operations[0].employerSSRate, 30);
  const result = simulateDistribution(projection(s), { ...legacy, operations }, s);
  assert.equal(result.employerSSTotal, 300); assert.equal(result.companyTax, 2805);
  assert.equal(result.companyRetained, 15895); assert.equal(result.conservation.exact, true);
});

test('RETA gross assessment uses the real remuneration before employee contributions', () => {
  const s = settings(); s.taxYear = 2027; s.horizon = '2027-12-31';
  Object.assign(s.people[0], { retaYear: 2027, retaPeriod: 'extension' });
  const result = simulateDistribution(projection(s, { baseProfit: 30000, cashAtHorizon: 40000, horizon: '2027-12-31' }), scenario([op('gross-reta', 'salary', 18004, { employeeSSRate: 10 })]), s);
  assert.equal(result.people[0].retaAssessment.simulatedGross, 18004);
  assert.ok(result.people[0].retaWarnings.some(message => message.startsWith('El bruto simulado de ese año')));
  assert.equal(result.conservation.exact, true);
});

test('salary accounts for employee and employer contributions without taxing withholding again', () => {
  const s = settings(), p = projection(s), sc = scenario([op('salary', 'salary', 1000, { employeeSSRate: 10, employerSSRate: 20, withholdingRate: 15 })]);
  const r = simulateDistribution(p, sc, s), bar = r.bars[1];
  assert.equal(r.taxableProfit, 18800); assert.equal(r.companyTax, 2820); assert.equal(r.companyRetained, 15980);
  assert.equal(bar.employeeSS, 100); assert.equal(bar.employerSS, 200); assert.equal(bar.tax, 313); assert.equal(bar.net, 587);
  assert.equal(bar.transferNet, 750); assert.equal(r.taxTotal, 3133); assert.equal(r.socialCostsTotal, 300);
  assert.equal(bar.companyCost, 1200); assert.equal(bar.companyCashCost, 1200); assert.equal(bar.remunerationGross, 1000);
  assert.equal(r.cashAfterDistributions, 19980); assert.equal(r.cashAtHorizon, 23800);
  assert.equal(r.people[0].workGross, 1000); assert.equal(r.people[0].personalNet, 587);
  assert.equal(chartAllocation(r), 2000000); assert.equal(r.conservation.exact, true);
});

test('deductible and non-deductible costs both consume profit but only one lowers Sociedades', () => {
  const s = settings(), p = projection(s);
  const yes = simulateDistribution(p, scenario([op('cost', 'expense', 1000)]), s);
  const no = simulateDistribution(p, scenario([op('cost', 'expense', 1000, { deductible: false })]), s);
  assert.equal(yes.companyTax, 2850); assert.equal(no.companyTax, 3000);
  assert.equal(yes.companyRetained, 16150); assert.equal(no.companyRetained, 16000);
  assert.equal(yes.otherCosts, 1000); assert.equal(yes.personalNetTotal, 0);
  assert.equal(yes.bars[1].otherCosts, 1000); assert.equal(yes.bars[1].kind, 'expense');
  assert.equal(chartAllocation(yes), 2000000); assert.equal(chartAllocation(no), 2000000);
  const salary = simulateDistribution(p, scenario([op('work', 'administrator', 1000, { deductible: false })]), s);
  assert.equal(salary.companyTax, 3000); assert.equal(salary.companyRetained, 16000);
});

test('professional VAT is separate cash, not personal net, profit or automatically recovered tax', () => {
  const s = settings(), p = projection(s);
  const base = op('fee', 'professional', 1000, { vatRate: 21, withholdingRate: 15 });
  const r = simulateDistribution(p, scenario([base]), s), bar = r.bars[1];
  assert.equal(bar.vat, 210); assert.equal(bar.tax, 350.5); assert.equal(bar.net, 649.5); assert.equal(bar.transferNet, 1060);
  assert.equal(r.companyTax, 2850); assert.equal(r.companyRetained, 16150); assert.equal(r.vatCashExtra, 210); assert.equal(r.cashAfterDistributions, 19940);
  const moreWithholding = simulateDistribution(p, scenario([{ ...base, withholdingRate: 35 }]), s);
  assert.equal(moreWithholding.taxTotal, r.taxTotal); assert.equal(moreWithholding.bars[1].net, bar.net); assert.equal(moreWithholding.bars[1].transferNet, 860);
  assert.ok(r.warnings.some(w => /presume recuperable/.test(w)));
  assert.equal(chartAllocation(r), 2000000);
});

test('multiple remuneration bars share annual IRPF with exact, order-independent cents', () => {
  const s = settings(), p = projection(s), ops = ['c', 'a', 'b'].map(id => op(id, 'salary', .01));
  const r = simulateDistribution(p, scenario(ops), s), reversed = simulateDistribution(p, scenario([...ops].reverse()), s);
  const taxes = result => Object.fromEntries(result.bars.slice(1).map(bar => [bar.id, bar.tax]));
  assert.deepEqual(taxes(r), taxes(reversed));
  assert.equal(r.personalTaxTotal, .01); assert.equal(r.bars.find(bar => bar.id === 'a').tax, .01);
  assert.equal(r.bars.find(bar => bar.id === 'b').tax, 0); assert.equal(r.bars.find(bar => bar.id === 'c').tax, 0);
  assert.equal(r.legacyPeople[0].workGross, .03); assert.equal(chartAllocation(r), 2000000);
});

test('dividends have independent bars, preserve IS and use the real accounting reserve', () => {
  const s = settings(), p = projection(s);
  const r = simulateDistribution(p, scenario([op('d1', 'dividend', 4000), op('d2', 'dividend', 5000)]), s);
  assert.equal(r.companyTax, 3000); assert.equal(r.companyRetained, 8000); assert.equal(r.personalTaxTotal, 1770); assert.equal(r.personalNetTotal, 7230);
  assert.equal(r.cashAtHorizon, 25000); assert.equal(r.cashAfterDistributions, 12000); assert.equal(chartAllocation(r), 2000000);
  const real = simulateDistribution(p, scenario([op('nondeductible', 'expense', 16000, { deductible: false }), op('d', 'dividend', 950)]), s);
  assert.equal(real.companyTax, 3000); assert.equal(real.profitAfterTaxBeforeDividend, 1000); assert.equal(real.reserveRequired, 100); assert.equal(real.distributableProfit, 900);
  assert.equal(real.budgetValid, false); assert.ok(real.issues.some(message => /beneficio repartible real/.test(message)));
});

test('unconfirmed class, unknown personal profile and other fiscal regions never produce fake net', () => {
  const s = settings(), p = projection(s);
  for (const operation of [op('legacy', 'legacy-work', 1000), op('not-confirmed', 'salary', 1000, { taxTreatmentConfirmed: false })]) {
    const r = simulateDistribution(p, scenario([operation]), s);
    assert.equal(r.personalTaxTotal, null); assert.equal(r.bars[1].net, null); assert.equal(r.bars[1].tax, null); assert.equal(r.bars[1].negative, 0);
    assert.equal(r.budgetValid, true); assert.equal(r.valid, false); assert.equal(r.conservation.exact, true);
  }
  const otherRegion = simulateDistribution(p, scenario([op('work', 'salary', 1000)]), s, [{ personId: 'person-1', taxRegion: 'other' }]);
  assert.equal(otherRegion.personalNetTotal, null); assert.ok(otherRegion.warnings.some(w => /no es Cataluña/.test(w)));
  s.people[0].taxProfileKnown = false; assert.equal(simulateDistribution(p, scenario([op('d', 'dividend', 1000)]), s).personalTaxTotal, null);
});

test('unknown IRPF preserves known social contributions and visual profit conservation', () => {
  const s = settings(), p = projection(s), r = simulateDistribution(p, scenario([op('pending', 'salary', 1000, { taxTreatmentConfirmed: false, employeeSSRate: 10, employerSSRate: 20 })]), s);
  assert.equal(r.bars[1].net, null); assert.equal(r.bars[1].tax, null); assert.equal(r.bars[1].unknownGross, 900);
  assert.equal(r.bars[1].positive, 900); assert.equal(r.bars[1].negative, -300); assert.equal(r.bars[1].companyCost, 1200);
  assert.equal(chartAllocation(r), 2000000); assert.equal(r.conservation.allocated, 20000); assert.equal(r.conservation.exact, true);
});

test('company bar distinguishes tax applied to its fiscal base from the effective allocation ratio', () => {
  const s = settings(), r = simulateDistribution(projection(s), scenario([op('dividend', 'dividend', 6000)]), s), company = r.bars[0];
  assert.equal(company.statutoryRate, 15); assert.equal(company.taxableBase, 20000); assert.equal(company.tax, 3000);
  assert.equal(company.gross, 14000); assert.equal(company.effectiveRate, 21.43);
});

test('all work for a person stays pending if one operation classification is unconfirmed', () => {
  const s = settings(), p = projection(s), r = simulateDistribution(p, scenario([op('clear', 'salary', 1000), op('unclear', 'legacy-work', 1000)]), s);
  assert.equal(r.bars[1].tax, null); assert.equal(r.bars[2].tax, null); assert.equal(r.people[0].personalTax, null);
  assert.equal(r.knownTaxTotal, r.companyTax);
});

test('a withholding estimate can be missing even when the annual final tax is known', () => {
  const s = settings(), r = simulateDistribution(projection(s), scenario([op('work', 'administrator', 1000)]), s);
  assert.equal(r.bars[1].tax, 350.5); assert.equal(r.bars[1].transferNet, null); assert.equal(r.bars[1].net, 649.5);
});

test('impossible negative transfers are identified without changing the final annual tax', () => {
  const s = settings(), p = projection(s), r = simulateDistribution(p, scenario([op('work', 'salary', 1000, { employeeSSRate: 80, withholdingRate: 35 })]), s);
  assert.equal(r.bars[1].transferNet, -150); assert.equal(r.valid, false);
  assert.ok(r.issues.some(w => /se podría transferir/.test(w)));
  assert.equal(r.conservation.exact, true); assert.equal(chartAllocation(r), 2000000);
});

test('irrelevant fiscal flags never silently turn dividends into deductible salary', () => {
  const s = settings(), p = projection(s), r = simulateDistribution(p, scenario([op('d', 'dividend', 1000, { deductible: true, employeeSSRate: 10, vatRate: 21 })]), s);
  assert.equal(r.companyTax, 3000); assert.equal(r.socialCostsTotal, 0); assert.equal(r.vatCashExtra, 0); assert.equal(r.valid, false);
  assert.ok(r.issues.some(w => /dividendo/.test(w))); assert.ok(r.issues.some(w => /cotizaciones/.test(w)));
});

test('operation maximum is a budget cap and does not block constructing proportional dividends', () => {
  const s = settings(); for (const p of s.people) Object.assign(p, { isShareholder: true, sharePercent: 50 });
  const p = projection(s), sc = scenario([op('first', 'dividend', 100), op('second', 'dividend', 0, { personId: 'person-2' })]);
  const maximum = operationMaximum(p, sc, s, [], 'first'); assert.equal(maximum, 16400);
  sc.operations[0].amount = maximum; const r = simulateDistribution(p, sc, s);
  assert.equal(r.budgetValid, true); assert.equal(r.valid, false); assert.ok(r.issues.some(w => /porcentaje/.test(w)));
  sc.operations[0].amount += .01; assert.equal(simulateDistribution(p, sc, s).budgetValid, false);
});

test('salary and expense maxima include social costs, VAT and required cash in exact cents', () => {
  const s = settings(), p = projection(s, { cashAtHorizon: 7000 }), sc = scenario([op('work', 'salary', 0, { employerSSRate: 20 }), op('cost', 'expense', 1000, { vatRate: 21 })]);
  const maximum = operationMaximum(p, sc, s, [], 'work'); assert.ok(maximum > 0 && maximum < 5000);
  sc.operations[0].amount = maximum; assert.equal(simulateDistribution(p, sc, s).budgetValid, true);
  sc.operations[0].amount = Math.round((maximum + .01) * 100) / 100; assert.equal(simulateDistribution(p, sc, s).budgetValid, false);
  assert.equal(operationMaximum({ ...p, cashAtHorizon: null }, sc, s, [], 'work'), 0);
});

test('operation simulation is read-only and monetary conservation remains exact with mixed bars', () => {
  const s = settings(), p = projection(s), sc = scenario([op('w', 'salary', 1200.21, { employeeSSRate: 6.5, employerSSRate: 30 }), op('f', 'professional', 300.13, { vatRate: 21 }), op('e', 'expense', 185.91), op('d', 'dividend', 2000.37)]);
  const before = structuredClone({ s, p, sc }), r = simulateDistribution(p, sc, s);
  assert.deepEqual({ s, p, sc }, before); assert.equal(r.conservation.difference, 0); assert.equal(chartAllocation(r), 2000000);
  assert.deepEqual(r.legacyPeople[0], { personId: 'person-1', workGross: 1500.34, dividendGross: 2000.37 });
  assert.throws(() => simulateDistribution(p, scenario([op('same', 'salary', 1), op('same', 'salary', 2)]), s), /únicos/);
});
