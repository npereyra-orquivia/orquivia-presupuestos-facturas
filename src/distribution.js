import { simulatePlanningScenario } from './planning.js';
import { statementCents as cents, statementEuros as euros } from './profit-loss.js';

const WORK = new Set(['salary', 'administrator', 'professional', 'legacy-work']);
const KINDS = new Set([...WORK, 'dividend', 'expense']);
const LABELS = { salary: 'Nómina', administrator: 'Retribución de administradora', professional: 'Honorarios profesionales', dividend: 'Dividendo', expense: 'Gasto de empresa', 'legacy-work': 'Retribución · tipo pendiente' };
const MAX = 100000000000n;
const positive = n => n > 0n ? n : 0n;
const pct = (n, rate) => (n * cents(rate) + 5000n) / 10000n;
const minus = n => n === 0n ? 0 : -euros(n);
const rateOf = (numerator, denominator) => denominator > 0n ? Number((numerator * 10000n + denominator / 2n) / denominator) / 100 : null;
const sum = values => values.reduce((total, n) => total + n, 0n);
const money = value => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Introduce un importe numérico válido para la operación.');
  const n = cents(value);
  if (n < 0n || n > MAX || Math.abs(value * 100 - Math.round(value * 100)) > .00001) throw new Error('El importe de la operación debe ser positivo y tener como máximo dos decimales.');
  return n;
};
const percentage = value => {
  const n = money(value);
  if (n > 10000n) throw new Error('Los porcentajes de la operación deben estar entre 0 y 100.');
  return value;
};
const fingerprint = text => { let h = 2166136261; for (const char of String(text)) h = Math.imul(h ^ char.codePointAt(0), 16777619); return (h >>> 0).toString(36); };

export function newDistributionOperation(kind, personId = null, { label } = {}) {
  if (!KINDS.has(kind)) throw new Error('El tipo de operación no es compatible.');
  if (kind !== 'expense' && (typeof personId !== 'string' || !personId)) throw new Error('Selecciona la persona de esta operación.');
  return { id: globalThis.crypto.randomUUID(), label: label || LABELS[kind], kind, personId: kind === 'expense' ? null : personId,
    amount: 0, deductible: kind !== 'dividend', employeeSSRate: 0, employerSSRate: 0,
    withholdingRate: null, vatRate: null, taxTreatmentConfirmed: !WORK.has(kind) };
}

/** Sidecar or in-memory operations are authoritative; legacy money is never added twice. */
export function scenarioOperations(state, legacyScenario = {}, settings = {}) {
  if (Array.isArray(legacyScenario.operations)) return structuredClone(legacyScenario.operations);
  const saved = state?.planningExtensions?.scenarios?.find(row => row.scenarioId === legacyScenario.id);
  if (saved) return structuredClone(saved.operations);
  const result = [], names = new Map((settings.people || []).map(p => [p.id, p.name]));
  for (const person of legacyScenario.people || []) {
    for (const [field, kind] of [['workGross', 'legacy-work'], ['dividendGross', 'dividend']]) {
      if (!money(person[field] || 0)) continue;
      const name = names.get(person.personId) || 'Persona';
      const op = newDistributionOperation(kind, person.personId, { label: kind === 'dividend' ? `${name} · dividendo` : `${name} · retribución por clasificar` });
      op.id = `legacy-${fingerprint(legacyScenario.id || 'draft')}-${kind}-${fingerprint(person.personId)}`;
      if (kind === 'legacy-work') op.employerSSRate = settings.people?.find(row => row.id === person.personId)?.employerContributionRate || 0;
      op.amount = person[field]; result.push(op);
    }
  }
  return result;
}

export function aggregateDistributionPeople(operations = [], settings = {}) {
  const people = settings.people || [], amounts = new Map(people.map(p => [p.id, { work: 0n, dividend: 0n }]));
  for (const op of operations) {
    if (!KINDS.has(op.kind)) throw new Error('El tipo de operación no es compatible.');
    const n = money(op.amount);
    if (op.kind === 'expense') continue;
    const row = amounts.get(op.personId); if (!row) throw new Error('La operación hace referencia a una persona que no existe.');
    if (op.kind === 'dividend') row.dividend += n; else row.work += n;
  }
  return people.map(p => ({ personId: p.id, workGross: euros(amounts.get(p.id).work), dividendGross: euros(amounts.get(p.id).dividend) }));
}

/** Allocate an annual tax across independent bars without losing a cent or depending on their order. */
function allocate(total, rows, weight) {
  if (total === null) return new Map(rows.map(row => [row.op.id, null]));
  const denominator = sum(rows.map(weight));
  if (!denominator) return new Map(rows.map(row => [row.op.id, 0n]));
  const divided = rows.map(row => {
    const numerator = total * weight(row);
    return { id: row.op.id, amount: numerator / denominator, remainder: numerator % denominator };
  });
  let remainder = total - sum(divided.map(row => row.amount));
  const priority = [...divided].sort((a, b) => a.remainder === b.remainder ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : a.remainder > b.remainder ? -1 : 1);
  for (const row of priority) { if (!remainder) break; row.amount++; remainder--; }
  return new Map(divided.map(row => [row.id, row.amount]));
}

function preparedOperations(operations, settings) {
  if (!Array.isArray(operations) || operations.length > 50) throw new Error('Un escenario admite como máximo 50 operaciones.');
  const people = new Set(settings.people.map(p => p.id)), ids = new Set();
  return operations.map(source => {
    if (!source || !KINDS.has(source.kind) || typeof source.id !== 'string' || !source.id || ids.has(source.id)) throw new Error('Las operaciones necesitan identificadores únicos y un tipo válido.');
    ids.add(source.id);
    if (source.kind === 'expense' ? source.personId !== null : !people.has(source.personId)) throw new Error('Revisa la persona asignada a la operación.');
    const op = structuredClone(source), amount = money(op.amount);
    for (const field of ['employeeSSRate', 'employerSSRate']) percentage(op[field]);
    for (const field of ['withholdingRate', 'vatRate']) if (op[field] !== null) percentage(op[field]);
    if (typeof op.deductible !== 'boolean' || typeof op.taxTreatmentConfirmed !== 'boolean') throw new Error('Confirma los indicadores fiscales de la operación.');
    op.label = typeof op.label === 'string' && op.label.trim() ? op.label.trim() : LABELS[op.kind];
    const isWork = WORK.has(op.kind), isVAT = ['professional', 'expense'].includes(op.kind);
    return { op, amount, isWork, employeeSS: isWork ? pct(amount, op.employeeSSRate) : 0n,
      employerSS: isWork ? pct(amount, op.employerSSRate) : 0n,
      vat: isVAT && op.vatRate !== null ? pct(amount, op.vatRate) : 0n,
      withholding: op.withholdingRate === null ? null : pct(amount, op.withholdingRate) };
  });
}

export function simulateDistribution(projection, scenario = {}, suppliedSettings = projection.settings, peopleExtensions = []) {
  const settings = structuredClone(suppliedSettings), operations = scenario.operations || [], rows = preparedOperations(operations, settings);
  const regions = new Map(peopleExtensions.map(row => [row.personId, row.taxRegion]));
  const warnings = [], issues = [];
  const profit = cents(projection.baseProfit), work = sum(rows.filter(row => row.isWork).map(row => row.amount));
  const employeeSS = sum(rows.map(row => row.employeeSS)), employerSS = sum(rows.map(row => row.employerSS));
  const expense = sum(rows.filter(row => row.op.kind === 'expense').map(row => row.amount));
  const dividends = sum(rows.filter(row => row.op.kind === 'dividend').map(row => row.amount));
  const vatCash = sum(rows.map(row => row.vat));
  const deducted = sum(rows.filter(row => row.op.deductible && row.op.kind !== 'dividend').map(row => row.amount + row.employerSS));
  const taxableProfit = profit - deducted, accountingProfitBeforeTax = profit - work - employerSS - expense;
  const taxRows = settings.people.map(person => {
    const personal = rows.filter(row => row.op.personId === person.id);
    const taxableWork = sum(personal.filter(row => row.isWork).map(row => row.amount - row.employeeSS));
    return { personId: person.id, workGross: euros(taxableWork), dividendGross: euros(sum(personal.filter(row => row.op.kind === 'dividend').map(row => row.amount))) };
  });
  for (const person of settings.people) {
    person.employerContributionRate = 0;
    if (regions.has(person.id) && regions.get(person.id) !== 'catalonia') { person.taxProfileKnown = false; warnings.push(`${person.name}: la región fiscal indicada no es Cataluña; no se aplican automáticamente sus tarifas.`); }
  }
  // The old engine owns tariffs and shareholder checks. Its cash and accounting
  // totals use an artificial base here and are deliberately reconstructed below.
  const effectiveProjection = { ...projection, baseProfit: euros(taxableProfit + work - employeeSS), cashAtHorizon: null, settings };
  const simulation = simulatePlanningScenario(effectiveProjection, { ...scenario, people: taxRows }, settings);
  const companyTax = cents(simulation.companyTax), accountingAfterTax = accountingProfitBeforeTax - companyTax;
  const reserveLimit = positive(cents(settings.legalReservePending)), annualReserve = pct(positive(accountingAfterTax), 10);
  const reserveRequired = reserveLimit < annualReserve ? reserveLimit : annualReserve, distributableProfit = positive(accountingAfterTax - reserveRequired);
  const companyRetained = accountingAfterTax - dividends;
  // These checks refer to the adapter's fiscal fiction; the real budget is below.
  const inheritedIssues = simulation.issues.filter(message => !/beneficio repartible|caja estimada|colchón/.test(message));
  issues.push(...inheritedIssues);
  warnings.push(...simulation.warnings.filter(message => !/superan el beneficio previsto/.test(message)));
  if (dividends > distributableProfit) issues.push('Los dividendos superan el beneficio repartible real del escenario después de la reserva legal.');
  if (companyRetained < 0n) issues.push('Las operaciones superan el beneficio disponible del escenario.');
  for (const row of rows) {
    const { op, amount } = row;
    if (op.kind === 'dividend' && op.deductible) issues.push(`${op.label}: un dividendo no se puede descontar como gasto de Sociedades.`);
    if (!row.isWork && (op.employeeSSRate || op.employerSSRate)) issues.push(`${op.label}: las cotizaciones laborales solo corresponden a retribuciones por trabajo.`);
    if (!['professional', 'expense'].includes(op.kind) && op.vatRate !== null) issues.push(`${op.label}: revisa el IVA; esta clase de operación no lo incorpora.`);
    if (row.isWork && amount && (!op.taxTreatmentConfirmed || op.kind === 'legacy-work')) warnings.push(`${op.label}: confirma el tipo y tratamiento fiscal de la retribución antes de estimar su neto.`);
    if (op.kind === 'expense' && amount && !op.taxTreatmentConfirmed) warnings.push(`${op.label}: la deducibilidad del gasto todavía es una hipótesis del escenario.`);
    if (row.vat) warnings.push(`${op.label}: el IVA se añade a la salida de caja y no es neto personal ni se presume recuperable; confirma su tratamiento.`);
  }
  const taxByOperation = new Map();
  for (const person of settings.people) {
    const result = simulation.people.find(p => p.id === person.id), personalRows = rows.filter(row => row.op.personId === person.id);
    const workRows = personalRows.filter(row => row.isWork), dividendRows = personalRows.filter(row => row.op.kind === 'dividend');
    const workConfirmed = workRows.every(row => !row.amount || row.op.taxTreatmentConfirmed && row.op.kind !== 'legacy-work');
    const dividendsConfirmed = dividendRows.every(row => !row.amount || row.op.taxTreatmentConfirmed);
    const workTax = result.workTax === null || !workConfirmed ? null : cents(result.workTax);
    const dividendTax = result.dividendTax === null || !dividendsConfirmed ? null : cents(result.dividendTax);
    for (const [id, n] of allocate(workTax, workRows, row => row.amount - row.employeeSS)) taxByOperation.set(id, n);
    for (const [id, n] of allocate(dividendTax, dividendRows, row => row.amount)) taxByOperation.set(id, n);
  }
  const bars = [{ id: 'company', label: 'Empresa', kind: 'company', personId: null,
    gross: euros(companyRetained + companyTax), net: euros(companyRetained), tax: euros(companyTax), socialCosts: 0,
    employeeSS: 0, employerSS: 0, vat: 0, transferNet: null, otherCosts: 0,
    companyCost: euros(companyRetained + companyTax), companyCashCost: null, remunerationGross: 0,
    statutoryRate: settings.corporateTaxRate, taxableBase: euros(taxableProfit),
    effectiveRate: rateOf(companyTax, companyRetained + companyTax),
    known: true, positive: euros(positive(companyRetained)), negative: minus(companyTax), loss: euros(positive(-companyRetained)) }];
  for (const row of rows) {
    const { op, amount } = row, isExpense = op.kind === 'expense';
    const tax = isExpense ? 0n : amount === 0n ? 0n : taxByOperation.get(op.id);
    const known = tax !== null && tax !== undefined;
    const net = isExpense ? amount : known ? amount - row.employeeSS - tax : null;
    const transfer = row.withholding === null ? null : amount - row.employeeSS - row.withholding + row.vat;
    if (transfer !== null && transfer < 0n) issues.push(`${op.label}: la retención y la cotización personal superan el importe que se podría transferir.`);
    bars.push({ id: op.id, label: op.label, kind: op.kind, personId: op.personId,
      gross: euros(amount), net: net === null ? null : euros(net), tax: known ? euros(tax) : null,
      socialCosts: euros(row.employeeSS + row.employerSS), employeeSS: euros(row.employeeSS), employerSS: euros(row.employerSS),
      vat: euros(row.vat), transferNet: transfer === null ? null : euros(transfer), otherCosts: isExpense ? euros(amount) : 0,
      companyCost: euros(amount + row.employerSS), companyCashCost: euros(amount + row.employerSS + row.vat), remunerationGross: row.isWork ? euros(amount) : 0,
      effectiveRate: known && amount > 0n ? rateOf(tax, amount) : known ? 0 : null,
      known, positive: net === null ? euros(amount - row.employeeSS) : euros(net), negative: minus((known ? tax : 0n) + row.employeeSS + row.employerSS),
      unknownGross: known ? 0 : euros(amount - row.employeeSS), taxableBase: row.isWork ? euros(amount - row.employeeSS) : euros(amount) });
  }
  const personalBars = bars.filter(bar => bar.kind !== 'company' && bar.kind !== 'expense'), taxesKnown = personalBars.every(bar => bar.known);
  const personalTax = taxesKnown ? sum(personalBars.map(bar => cents(bar.tax))) : null;
  const personalNet = taxesKnown ? sum(personalBars.map(bar => cents(bar.net))) : null;
  const knownPersonalTax = sum(personalBars.filter(bar => bar.known).map(bar => cents(bar.tax)));
  const people = simulation.people.map(person => {
    const ownBars = personalBars.filter(bar => bar.personId === person.id), allKnown = ownBars.every(bar => bar.known);
    const ownWork = ownBars.filter(bar => WORK.has(bar.kind)), ownDividends = ownBars.filter(bar => bar.kind === 'dividend');
    const n = field => euros(sum(ownBars.map(bar => cents(bar[field] || 0))));
    const workTax = ownWork.every(bar => bar.known) ? euros(sum(ownWork.map(bar => cents(bar.tax)))) : null;
    const dividendTax = ownDividends.every(bar => bar.known) ? euros(sum(ownDividends.map(bar => cents(bar.tax)))) : null;
    const workGross = sum(ownWork.map(bar => cents(bar.gross))), dividendGross = sum(ownDividends.map(bar => cents(bar.gross)));
    const profile = settings.people.find(row => row.id === person.id), assessment = person.retaAssessment;
    const retaGross = (assessment.year === settings.taxYear ? workGross : 0n) + (assessment.year === person.dividendYear && profile.isShareholder ? dividendGross : 0n);
    const retaWarnings = person.retaWarnings.filter(message => !message.startsWith('El bruto simulado de ese año'));
    if (assessment.period === 'extension' && assessment.annualSMI !== null && retaGross >= cents(assessment.annualSMI)) retaWarnings.push('El bruto simulado de ese año alcanza o supera el SMI; calcula con TGSS el rendimiento neto anual completo antes de contar con la prórroga.');
    return { ...person, workGross: euros(sum(ownWork.map(bar => cents(bar.gross)))), dividendGross: euros(sum(ownDividends.map(bar => cents(bar.gross)))),
      employerCosts: n('employerSS'), employeeSS: n('employeeSS'), workTax, dividendTax,
      retaAssessment: { ...assessment, simulatedGross: euros(retaGross) }, retaWarnings,
      personalTax: allKnown ? n('tax') : null, personalNet: allKnown ? n('net') : null };
  });
  const cash = projection.cashAtHorizon === null ? null : cents(projection.cashAtHorizon);
  const reservedVAT = cents(projection.vatReserve || 0), minimumCash = cents(settings.minimumCash || 0);
  const eventualCash = cash === null ? null : cash - work - employerSS - expense - dividends - vatCash - companyTax - reservedVAT;
  const afterMinimum = eventualCash === null ? null : eventualCash - minimumCash;
  const workInHorizon = simulation.workDate > projection.asOf && simulation.workDate <= projection.horizon;
  const divInHorizon = simulation.dividendDate > projection.asOf && simulation.dividendDate <= projection.horizon;
  const datedCash = cash === null ? null : cash - (workInHorizon ? work + employerSS + expense + vatCash : 0n) - (divInHorizon ? dividends : 0n);
  const budgetValid = cash !== null && afterMinimum >= 0n && companyRetained >= 0n && dividends <= distributableProfit;
  if (cash === null) warnings.push('Falta una caja de partida confirmada para calcular el máximo de las operaciones.');
  else if (afterMinimum < 0n) issues.push('El escenario supera la caja estimada tras IVA, Sociedades y el colchón indicado.');
  const allocated = sum(bars.map(bar => cents(bar.net === null ? bar.unknownGross : bar.net) + cents(bar.tax || 0) + cents(bar.socialCosts || 0)));
  const allocatedGross = companyRetained + companyTax + work + employerSS + expense + dividends;
  const difference = profit - allocated;
  const classificationConfirmed = rows.every(row => !row.amount || row.op.taxTreatmentConfirmed && row.op.kind !== 'legacy-work');
  return { ...simulation, bars, people, operations: rows.map(row => row.op), legacyPeople: aggregateDistributionPeople(operations, settings),
    baseProfit: euros(profit), taxableProfit: euros(taxableProfit), accountingProfitBeforeTax: euros(accountingProfitBeforeTax), companyTax: euros(companyTax),
    companyRetained: euros(companyRetained), profitAfterTaxBeforeDividend: euros(accountingAfterTax),
    personalNetTotal: personalNet === null ? null : euros(personalNet), totalPersonalNet: personalNet === null ? null : euros(personalNet),
    personalTaxTotal: personalTax === null ? null : euros(personalTax), totalPersonalTax: personalTax === null ? null : euros(personalTax),
    taxTotal: personalTax === null ? null : euros(personalTax + companyTax), knownTaxTotal: euros(knownPersonalTax + companyTax), socialCostsTotal: euros(employeeSS + employerSS),
    employeeSSTotal: euros(employeeSS), employerSSTotal: euros(employerSS), otherCosts: euros(expense), vatCashExtra: euros(vatCash),
    workTotal: euros(work), dividendTotal: euros(dividends), reserveRequired: euros(reserveRequired), distributableProfit: euros(distributableProfit),
    cashAtHorizon: datedCash === null ? null : euros(datedCash), cashAfterDistributions: eventualCash === null ? null : euros(eventualCash),
    cashAfterMinimum: afterMinimum === null ? null : euros(afterMinimum), remainingBudget: afterMinimum === null ? null : euros(afterMinimum),
    budgetValid, valid: budgetValid && issues.length === 0 && taxesKnown && classificationConfirmed,
    issues: [...new Set(issues)], warnings: [...new Set(warnings)],
    conservation: { expected: euros(profit), allocated: euros(allocated), allocatedGross: euros(allocatedGross), difference: euros(difference), exact: difference === 0n && allocated === allocatedGross, taxesKnown },
    taxAllocation: 'IRPF anual repartido proporcionalmente por base entre operaciones de la misma persona y clase, con ajuste exacto de céntimos.' };
}

/** A financial cap only: shareholder proportionality and unknown IRPF never block constructing a draft. */
export function operationMaximum(projection, scenario, settings = projection.settings, peopleExtensions = [], operationId) {
  const operations = scenario.operations || [], index = operations.findIndex(op => op.id === operationId);
  if (index < 0) throw new Error('La operación que quieres ajustar no existe.');
  if (projection.cashAtHorizon === null) return 0;
  const cashBound = positive(cents(projection.cashAtHorizon) - cents(projection.vatReserve || 0) - cents(settings.minimumCash || 0));
  let upper = positive(cents(projection.baseProfit)); if (cashBound < upper) upper = cashBound; if (upper > MAX) upper = MAX;
  const affordable = amount => {
    const next = structuredClone(scenario); next.operations[index].amount = euros(amount);
    return simulateDistribution(projection, next, settings, peopleExtensions).budgetValid;
  };
  if (!affordable(0n)) return 0;
  let lower = 0n;
  while (lower < upper) { const middle = (lower + upper + 1n) / 2n; if (affordable(middle)) lower = middle; else upper = middle - 1n; }
  return euros(lower);
}
