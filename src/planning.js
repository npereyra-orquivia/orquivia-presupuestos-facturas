import { todayISO, totals } from './domain.js';
import { cashSummary, expenseTotals, expenseCashAmount, expenseCashMovements, taxCashMovements, splitExpenseTotal } from './expenses.js';
import { profitLossReport, statementCents as cents, statementEuros as euros, statementValidDate as validDate, statementRecords } from './profit-loss.js';
import { validateAccountantClose } from './accountant-close.js';
import { validatePlanningState } from './planning-state.js';

const ISSUED = new Set(['issued', 'partial', 'paid', 'overdue']);
const FREQUENCIES = new Map([['once', 0], ['monthly', 1], ['quarterly', 3], ['yearly', 12]]);
const ZERO = 0n;
const positive = value => value > ZERO ? value : ZERO;
const addDays = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const dateIn = (date, from, to) => validDate(date) && date >= from && date <= to;
const sum = (rows, field) => rows.reduce((total, row) => total + cents(row[field] || 0), ZERO);
const ratio = (amount, percent) => { const n = amount * cents(percent); return (n + 5000n) / 10000n; };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const money = (value, fallback = 0) => value === undefined || value === '' ? fallback : euros(cents(value));
const nextMonth = (date, steps) => {
  const [year, month, day] = date.split('-').map(Number), target = new Date(Date.UTC(year, month - 1 + steps, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last)); return target.toISOString().slice(0, 10);
};

export const planningTaxRules = Object.freeze({
  year: 2026, checkedAt: '2026-11-25',
  state: [[12450, 9.5], [20200, 12], [35200, 15], [60000, 18.5], [300000, 22.5], [null, 24.5]],
  catalonia: [[12500, 9.5], [22000, 12.5], [33000, 16], [53000, 19], [90000, 21.5], [120000, 23.5], [175000, 24.5], [null, 25.5]],
  savings: [[6000, 19], [50000, 21], [200000, 23], [300000, 27], [null, 30]],
  sources: [
    { label: 'IRPF estatal', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764#a63' },
    { label: 'IRPF de Cataluña', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2024-6951' },
    { label: 'Tipos de Sociedades', url: 'https://sede.agenciatributaria.gob.es/Sede/impuesto-sobre-sociedades/que-base-imponible-se-determina-sociedades/tipo-impositivo.html' },
    { label: 'Cuándo se presenta Sociedades', url: 'https://www3.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/folleto-actividades-economicas/4-impuesto-sobre-sociedades/4_9-declaracion/4_9_1-plazo-presentacion.html' },
    { label: 'Reparto de dividendos', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2010-10544#a273' },
    { label: 'Cuota reducida', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2007-13409#a3-5' },
    { label: 'SMI de 2027', url: 'https://www.boe.es/eli/es/rd/2026/11/18/1013' },
  ],
});

export function defaultPlanning({ today = todayISO() } = {}) {
  if (!validDate(today)) throw new Error('La fecha de la previsión no es válida.');
  const year = Number(today.slice(0, 4));
  const person = (id, name) => ({ id, name, taxProfileKnown: false, externalSalary: 0, employeeSS: 0, retaAnnual: 0,
    otherGeneralIncome: 0, employmentExpense: 2000, otherSavings: 0, sharePercent: 0, isShareholder: false,
    employerContributionRate: 0, retaPeriod: 'initial', retaYear: year });
  return { version: 1, settings: { asOf: today, horizon: `${year}-12-31`, taxYear: year, corporateTaxRate: 15,
    corporateTaxConfirmed: false, legalReservePending: 0, minimumCash: 0, cashBalanceOverride: null,
    profitOverride: null, pendingCosts: 'gross', people: [person('person-1', 'Persona 1'), person('person-2', 'Persona 2')], collectionDates: {} },
  items: [], scenarios: [] };
}

/** Complete a form draft; persisted records additionally pass the shared strict validator. */
export function normalizePlanning(input, { today = todayISO() } = {}) {
  const defaults = defaultPlanning({ today });
  if (input === undefined || input === null) return defaults;
  if (!plain(input)) throw new Error('La previsión no tiene un formato válido.');
  const s = { ...defaults.settings, ...(input.settings || {}) };
  for (const key of ['corporateTaxRate', 'legalReservePending', 'minimumCash']) s[key] = money(s[key]);
  for (const key of ['cashBalanceOverride', 'profitOverride']) s[key] = s[key] === null || s[key] === '' || s[key] === undefined ? null : money(s[key]);
  s.taxYear = Number(s.taxYear);
  s.people = (s.people || defaults.settings.people).map((p, index) => {
    const row = { ...defaults.settings.people[0], id: `person-${index + 1}`, name: `Persona ${index + 1}`, ...p };
    for (const key of ['externalSalary', 'employeeSS', 'retaAnnual', 'otherGeneralIncome', 'employmentExpense', 'otherSavings', 'sharePercent', 'employerContributionRate']) row[key] = money(row[key]);
    row.retaYear = Number(row.retaYear); return row;
  });
  const items = (input.items || []).map(item => ({ label: '', kind: 'expense', amountGross: 0, vatRate: null,
    vatDeductible: false, treatment: 'operating', recurrence: 'once', startDate: s.asOf, endDate: null, active: true, linkedRecordIds: [], ...item,
    amountGross: money(item.amountGross), vatRate: item.vatRate === undefined || item.vatRate === null || item.vatRate === '' ? null : money(item.vatRate) }));
  const scenarios = (input.scenarios || []).map(row => ({ name: '', notes: '', dividendDate: null, ...row,
    people: (row.people || []).map(p => ({ personId: p.personId, workGross: money(p.workGross), dividendGross: money(p.dividendGross) })) }));
  return validatePlanningState({ version: input.version ?? 1, settings: s, items, scenarios });
}

/** Expand from the original anchor, so 31 Jan -> 28 Feb -> 31 Mar never drifts. */
export function expandForecast(items = [], { from, to } = {}) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('El período de previsión no es válido.');
  const result = [];
  for (const item of items) {
    if (item.active === false) continue;
    if (!validDate(item.startDate) || !FREQUENCIES.has(item.recurrence)) throw new Error('Revisa las fechas y la repetición del gasto previsto.');
    const step = FREQUENCIES.get(item.recurrence), end = item.endDate && item.endDate < to ? item.endDate : to;
    for (let occurrence = 0; occurrence < 1201; occurrence++) {
      const date = step ? nextMonth(item.startDate, step * occurrence) : item.startDate;
      if (date > end) break;
      if (date >= from) result.push({ ...item, id: `${item.id}:${date}`, itemId: item.id, date, amount: item.amountGross });
      if (!step) break;
      if (occurrence === 1200) throw new Error('La previsión contiene demasiadas repeticiones.');
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

function pendingAmount(report) {
  return ['pendingExpenseGross', 'pendingClassificationGross', 'pendingVATAmount', 'pendingAdditionalAmount'].reduce((total, key) => total + cents(report?.summary[key] || 0), ZERO);
}
function occurrenceLinked(occurrence, recordById) {
  return (occurrence.linkedRecordIds || []).some(id => {
    const record = recordById.get(id); if (!record) return false;
    if (occurrence.recurrence === 'once') return true;
    const date = record.paidDate || record.date; if (!validDate(date)) return false;
    if (occurrence.recurrence === 'yearly') return date.slice(0, 4) === occurrence.date.slice(0, 4);
    if (occurrence.recurrence === 'quarterly') return date.slice(0, 4) === occurrence.date.slice(0, 4) && Math.floor((Number(date.slice(5, 7)) - 1) / 3) === Math.floor((Number(occurrence.date.slice(5, 7)) - 1) / 3);
    return date.slice(0, 7) === occurrence.date.slice(0, 7);
  });
}
function forecastAmounts(row) {
  const gross = cents(row.amountGross), parts = row.vatRate === null ? null : splitExpenseTotal(row.amountGross, row.vatRate);
  const vat = parts ? cents(parts.vatAmount) : ZERO;
  const base = parts ? cents(parts.base) : gross;
  const taxable = ['operating', 'asset'].includes(row.treatment);
  const inputVAT = row.kind === 'expense' && row.vatDeductible && taxable ? vat : ZERO;
  const cost = row.treatment === 'operating' ? (row.kind === 'income' ? base : gross - inputVAT) : ZERO;
  return { gross, base, vat: taxable ? vat : ZERO, inputVAT, cost };
}

/** Read-only projection: operational records remain untouched. Money aggregates stay in cents. */
export function planningProjection(state, input, { today = todayISO() } = {}) {
  const planning = normalizePlanning(input ?? state.planning, { today }), settings = planning.settings;
  const { asOf, horizon, taxYear } = settings, yearFrom = `${taxYear}-01-01`, yearTo = `${taxYear}-12-31`;
  const warnings = [], issues = [], source = [];
  const documents = statementRecords(state.documents || [], 'documentos'), expenses = statementRecords(state.expenses || [], 'gastos');
  const payments = statementRecords(state.payments || [], 'cobros'), taxRecords = statementRecords(state.taxRecords || [], 'declaraciones');
  const sourceState = { ...state, documents, expenses, payments, taxRecords };
  const closeInput = state.company?.accountantClose;
  const close = closeInput && closeInput.asOf >= yearFrom && closeInput.asOf <= asOf && closeInput.asOf <= yearTo ? validateAccountantClose(closeInput, state.company) : null;
  const cutoff = asOf < yearTo ? asOf : yearTo;
  const reportFrom = close ? addDays(close.asOf, 1) : yearFrom;
  const current = reportFrom <= cutoff ? profitLossReport(sourceState, { from: reportFrom, to: cutoff }) : null;
  let pending = pendingAmount(current), currentProfit = cents(close?.profitLoss.resultBeforeTax || 0) + cents(current?.summary.resultBeforePending || 0);
  if (settings.pendingCosts === 'gross') currentProfit -= pending;
  if (close) source.push({ label: `Cierre del gestor a ${close.asOf}`, amount: close.profitLoss.resultBeforeTax, date: close.asOf });
  if (settings.profitOverride !== null) {
    currentProfit = cents(settings.profitOverride); source.push({ label: 'Resultado a fecha de referencia indicado para la simulación', amount: settings.profitOverride, date: asOf });
    warnings.push('El resultado de partida se ha indicado manualmente; no sustituye la cuenta contable ni incorpora nuevas facturas por sí mismo.');
  }
  const futureTo = horizon < yearTo ? horizon : yearTo, futureFrom = asOf >= yearFrom ? addDays(asOf, 1) : yearFrom;
  const futureActual = futureFrom <= futureTo ? profitLossReport(sourceState, { from: futureFrom, to: futureTo }) : null;
  const futurePending = pendingAmount(futureActual);
  currentProfit += cents(futureActual?.summary.resultBeforePending || 0) - (settings.pendingCosts === 'gross' ? futurePending : ZERO);
  pending += futurePending;
  if (pending) warnings.push(settings.pendingCosts === 'gross' ? 'Los importes pendientes de clasificar o de IVA se restan íntegros como estimación provisional; el gestor puede cambiar su coste y deducibilidad.' : 'Hay gastos o IVA pendientes que no están descontados del beneficio mostrado.');
  const cash = cashSummary(sourceState, asOf);
  const cashNow = settings.cashBalanceOverride === null ? cash.balance : settings.cashBalanceOverride;
  if (cashNow === null) warnings.push('Falta un saldo inicial o saldo bancario confirmado; la caja disponible no se puede calcular.');
  if (settings.cashBalanceOverride !== null) warnings.push('La caja de partida es el saldo indicado para esta simulación, pendiente de conciliación con el banco.');
  const flows = [], receivables = [], addFlow = (id, date, label, amount, kind, extra = {}) => { if (dateIn(date, addDays(asOf, 1), horizon)) flows.push({ id, date, label, amount: euros(amount), kind, ...extra }); };
  const invoiceIds = new Set(documents.filter(d => d.kind === 'invoice' && ISSUED.has(d.status)).map(d => d.id));
  for (const payment of payments) if (invoiceIds.has(payment.documentId)) addFlow(`payment:${payment.id}`, payment.date, 'Cobro registrado con fecha posterior', cents(payment.amount), 'recorded-collection');
  for (const doc of documents) {
    if (doc.kind !== 'invoice' || !ISSUED.has(doc.status) || !validDate(doc.date) || doc.date > horizon) continue;
    const total = cents(totals(doc).total), paidNow = sum(payments.filter(p => p.documentId === doc.id && validDate(p.date) && p.date <= asOf), 'amount');
    const paidAny = sum(payments.filter(p => p.documentId === doc.id && validDate(p.date)), 'amount'), residual = positive(total - paidAny), outstanding = positive(total - paidNow);
    if (!outstanding) continue;
    const override = settings.collectionDates[doc.id], candidate = override || doc.dueDate;
    const date = validDate(candidate) && candidate > asOf ? candidate : null;
    const entry = { id: doc.id, label: `${doc.number || 'Factura'}${doc.title ? ` · ${doc.title}` : ''}`, kind: 'invoice', amount: euros(outstanding), amountScheduled: euros(residual), date, included: Boolean(date && date <= horizon), source: override ? 'manual' : 'due-date' };
    receivables.push(entry);
    if (date) addFlow(`invoice:${doc.id}`, date, entry.label, residual, 'invoice-collection');
    else warnings.push(`Indica una fecha prevista para cobrar ${doc.number || 'la factura pendiente'}; no se supone que entre inmediatamente.`);
  }
  for (const expense of expenses) {
    if (expense.paymentStatus === 'paid') for (const movement of expenseCashMovements(expense)) addFlow(`expense:${expense.id}:${movement.date}`, movement.date, expense.description || expense.supplier || 'Pago registrado', -cents(movement.amount), 'recorded-expense');
    else if (expense.paymentStatus === 'pending') {
      const raw = expense.dueDate || expense.date, date = raw <= asOf ? addDays(asOf, 1) : raw;
      addFlow(`payable:${expense.id}`, date, expense.description || expense.supplier || 'Proveedor pendiente', -cents(expenseCashAmount(expense)), 'payable');
    }
  }
  for (const record of taxRecords) {
    if (record.paymentStatus === 'paid') for (const movement of taxCashMovements(record)) addFlow(`tax:${record.id}`, movement.date, `Modelo ${record.model || ''}`, -cents(movement.amount), 'recorded-tax');
    else if (record.paymentStatus === 'pending') addFlow(`tax:${record.id}`, record.date <= asOf ? addDays(asOf, 1) : record.date, `Modelo ${record.model || ''} pendiente`, -cents(record.amount), 'payable-tax');
  }
  const recordById = new Map([...expenses, ...documents, ...taxRecords].map(r => [r.id, r]));
  const occurrences = horizon > asOf ? expandForecast(planning.items, { from: addDays(asOf, 1), to: horizon }).filter(row => !occurrenceLinked(row, recordById)) : [];
  let forecastCashIn = ZERO, forecastCashOut = ZERO, forecastProfitCost = ZERO, forecastProfitIncome = ZERO, forecastInputVAT = ZERO, forecastOutputVAT = ZERO;
  for (const row of occurrences) {
    const a = forecastAmounts(row), income = row.kind === 'income';
    if (income) forecastCashIn += a.gross; else forecastCashOut += a.gross;
    addFlow(`forecast:${row.id}`, row.date, row.label, income ? a.gross : -a.gross, 'forecast', { itemId: row.itemId, treatment: row.treatment });
    if (dateIn(row.date, yearFrom, yearTo)) {
      if (income) { forecastProfitIncome += a.cost; forecastOutputVAT += a.vat; }
      else { forecastProfitCost += a.cost; forecastInputVAT += a.inputVAT; }
    }
    if (row.treatment === 'asset') warnings.push(`${row.label}: la compra afecta a caja; no se deduce entera del beneficio. La amortización debe incorporarse o confirmarse con el gestor.`);
    if (row.vatRate === null && row.treatment === 'operating') warnings.push(`${row.label}: importe sin desglose de IVA; se utiliza el total provisionalmente.`);
  }
  for (const quote of documents) {
    if (quote.kind !== 'quote' || quote.status !== 'accepted' || documents.some(doc => doc.kind === 'invoice' && ISSUED.has(doc.status) && doc.quoteId === quote.id)) continue;
    const date = settings.collectionDates[quote.id] || null, a = totals(quote);
    receivables.push({ id: quote.id, label: `${quote.number || 'Presupuesto aceptado'}${quote.title ? ` · ${quote.title}` : ''}`, kind: 'accepted-quote', amount: a.total, amountScheduled: a.total, date, included: Boolean(date && dateIn(date, addDays(asOf, 1), horizon)), source: 'manual' });
    if (!dateIn(date, addDays(asOf, 1), horizon)) continue;
    addFlow(`accepted:${quote.id}`, date, quote.number || 'Trabajo aceptado pendiente de facturar', cents(a.total), 'accepted-quote');
    if (dateIn(date, yearFrom, yearTo)) { forecastProfitIncome += cents(a.base); forecastOutputVAT += cents(a.vatAmount); }
    warnings.push(`${quote.number || 'Trabajo aceptado'}: venta futura estimada en la fecha prevista; debe realizarse el trabajo y facturarse.`);
  }
  let outputVAT = forecastOutputVAT, inputVAT = forecastInputVAT;
  const vatFrom = close ? addDays(close.asOf, 1) : yearFrom;
  for (const doc of documents) if (doc.kind === 'invoice' && ISSUED.has(doc.status) && dateIn(doc.date, vatFrom, futureTo)) outputVAT += cents(totals(doc).vatAmount);
  for (const expense of expenses) if (dateIn(expense.date, vatFrom, futureTo)) inputVAT += cents(expenseTotals(expense).vatDeductibleAmount || 0);
  const priorVATCredit = close ? positive(sum(close.balance.assets.filter(row => row.account === '472'), 'amount') - sum(close.balance.liabilities.filter(row => row.account === '477'), 'amount')) : ZERO;
  let settledVAT = ZERO;
  for (const record of taxRecords) {
    const end = record.year && record.quarter ? new Date(Date.UTC(record.year, record.quarter * 3, 0)).toISOString().slice(0, 10) : null;
    const cashDate = record.paymentStatus === 'paid' ? record.paidDate : record.date;
    if (record.model === '303' && record.year === taxYear && end && end >= vatFrom && ['paid', 'pending'].includes(record.paymentStatus) && validDate(cashDate) && cashDate <= horizon) settledVAT += cents(record.amount);
  }
  const vatReserve = positive(outputVAT - inputVAT - priorVATCredit - settledVAT);
  const baseProfit = currentProfit + forecastProfitIncome - forecastProfitCost;
  const cashMovement = sum(flows, 'amount'), cashAtHorizon = cashNow === null ? null : euros(cents(cashNow) + cashMovement);
  const months = new Map();
  for (let index = 0; index <= 120; index++) { const key = nextMonth(`${asOf.slice(0, 7)}-01`, index).slice(0, 7); if (key > horizon.slice(0, 7)) break; months.set(key, { month: key, in: ZERO, out: ZERO }); }
  for (const flow of flows) { const m = months.get(flow.date.slice(0, 7)); if (!m) continue; const n = cents(flow.amount); if (n > ZERO) m.in += n; else m.out -= n; }
  let running = cashNow === null ? null : cents(cashNow);
  const monthly = [...months.values()].map(m => { if (running !== null) running += m.in - m.out; return { month: m.month, inflows: euros(m.in), outflows: euros(m.out), closingCash: running === null ? null : euros(running) }; });
  if (!settings.corporateTaxConfirmed) warnings.push('El tipo de Sociedades es una hipótesis pendiente de confirmar con el gestor.');
  if (taxYear !== planningTaxRules.year) warnings.push(`Las tarifas personales verificadas son de ${planningTaxRules.year}; el IRPF del trabajo de ${taxYear} queda sin calcular hasta confirmar las reglas de ese año.`);
  if (planning.items.some(row => row.treatment === 'tax' && row.active)) warnings.push('Revisa que los pagos fiscales previstos no dupliquen las reservas automáticas de IVA y Sociedades.');
  return { settings, asOf, horizon, taxYear, baseProfit: euros(baseProfit), profitBeforeForecast: euros(currentProfit), cashNow, cashAtHorizon,
    forecastCashIn: euros(forecastCashIn), forecastCashOut: euros(forecastCashOut), forecastProfitCost: euros(forecastProfitCost), forecastProfitIncome: euros(forecastProfitIncome),
    pendingCosts: euros(pending), vatReserve: euros(vatReserve), receivables, occurrences, flows: flows.sort((a, b) => a.date.localeCompare(b.date)), monthly,
    corporateTaxExpectedMonth: `${taxYear + 1}-07`, warnings: [...new Set(warnings)], issues, source, sources: planningTaxRules.sources };
}

function progressive(base, bands) {
  let lower = ZERO, total = ZERO;
  for (const [upper, rate] of bands) {
    const cap = upper === null ? base : cents(upper), span = positive((base < cap ? base : cap) - lower);
    total += ratio(span, rate); if (base <= cap) break; lower = cap;
  }
  return total;
}

/** Personal taxes are incremental final IRPF, never the withholding on a transfer. */
export function simulatePlanningScenario(projection, scenario = {}, suppliedSettings) {
  const settings = suppliedSettings || projection.settings, warnings = [], issues = [];
  const allocations = scenario.people || [], ids = new Set(settings.people.map(person => person.id));
  const entries = new Map(allocations.map(p => [p.personId, p]));
  if (entries.size !== allocations.length || allocations.some(p => !ids.has(p.personId))) throw new Error('Revisa las personas del escenario; no puede haber personas repetidas o desconocidas.');
  const workDate = `${settings.taxYear}-12-31`;
  const defaultDividendDate = `${settings.taxYear + 1}-07-01`, dividendDate = scenario.dividendDate || defaultDividendDate;
  const dividendYear = Number(dividendDate.slice(0, 4));
  let wages = ZERO, employerCosts = ZERO, dividends = ZERO;
  const people = settings.people.map(person => {
    const row = entries.get(person.id) || {}, work = cents(row.workGross || 0), dividend = cents(row.dividendGross || 0);
    if (work < ZERO || dividend < ZERO || work > 100000000000n || dividend > 100000000000n) throw new Error('Los pagos simulados deben ser positivos y estar dentro del límite permitido.');
    const employer = ratio(work, person.employerContributionRate); wages += work; employerCosts += employer; dividends += dividend;
    let workTax = work ? null : ZERO, dividendTax = dividend ? null : ZERO;
    if (person.taxProfileKnown) {
      const base = positive(cents(person.externalSalary) + cents(person.otherGeneralIncome) - cents(person.employeeSS) - cents(person.retaAnnual) - cents(person.employmentExpense));
      if (settings.taxYear === planningTaxRules.year) {
        if (!work || (base >= cents(19747.50) && person.employerContributionRate === 0)) {
          workTax = progressive(base + work, planningTaxRules.state) - progressive(base, planningTaxRules.state)
            + progressive(base + work, planningTaxRules.catalonia) - progressive(base, planningTaxRules.catalonia);
        } else if (person.employerContributionRate > 0) warnings.push(`${person.name}: falta calcular la cotización adicional de la persona trabajadora; el bruto no es su neto.`);
        else warnings.push(`${person.name}: renta baja; hay que confirmar mínimos y reducciones del trabajo con el gestor. El bruto no es el neto.`);
      }
      const savings = cents(person.otherSavings);
      if (!dividend || base >= cents(5550)) dividendTax = progressive(savings + dividend, planningTaxRules.savings) - progressive(savings, planningTaxRules.savings);
      else warnings.push(`${person.name}: puede quedar mínimo personal sin utilizar que afecte al ahorro; el IRPF del dividendo necesita revisión.`);
    }
    const personalTax = workTax === null || dividendTax === null ? null : workTax + dividendTax;
    const retaWarnings = [];
    if (work || dividend) {
      if (person.retaPeriod === 'initial') retaWarnings.push('El período inicial de cuota reducida no se regulariza por superar ingresos, si está correctamente concedido.');
      else if (person.retaPeriod === 'extension') {
        retaWarnings.push(`La prórroga exige rendimientos netos computables inferiores al SMI de cada año natural; ${person.retaYear === 2027 ? '18.004 € en 2027' : 'confirma el SMI del año indicado'}. No es un límite universal de transferencia bruta.`);
      } else retaWarnings.push('La cotización ordinaria depende del rendimiento computable; la variación de RETA no está incluida en este neto.');
      if (person.isShareholder && dividend) retaWarnings.push(`El dividendo puede computar en RETA en ${dividendYear}; no se suma al año ${settings.taxYear} si es exigible más tarde.`);
      if (work && person.retaPeriod !== 'initial') warnings.push(`${person.name}: el neto no incluye una posible regularización o variación de cuota RETA.`);
    }
    if ((work || dividend) && !person.taxProfileKnown) warnings.push(`${person.name}: faltan datos personales confirmados para calcular su IRPF y neto; el bruto no se presenta como neto.`);
    if (dividend && (!person.isShareholder || person.sharePercent <= 0)) issues.push(`${person.name} no tiene una participación de socia confirmada para recibir dividendos.`);
    const simulatedRETAYear = Number(person.retaYear), retaGross = (simulatedRETAYear === settings.taxYear ? work : ZERO) + (simulatedRETAYear === dividendYear && person.isShareholder ? dividend : ZERO);
    const retaThreshold = simulatedRETAYear === 2027 ? 18004 : null;
    if (person.retaPeriod === 'extension' && retaThreshold !== null && retaGross >= cents(retaThreshold)) retaWarnings.push('El bruto simulado de ese año alcanza o supera el SMI; calcula con TGSS el rendimiento neto anual completo antes de contar con la prórroga.');
    return { id: person.id, name: person.name, workGross: euros(work), dividendGross: euros(dividend), employerCosts: euros(employer),
      workTax: workTax === null ? null : euros(workTax), dividendTax: dividendTax === null ? null : euros(dividendTax),
      personalTax: personalTax === null ? null : euros(personalTax), personalNet: personalTax === null ? null : euros(work + dividend - personalTax),
      dividendYear, retaWarnings, retaAssessment: { year: simulatedRETAYear, period: person.retaPeriod, simulatedGross: euros(retaGross), annualSMI: retaThreshold, complete: false } };
  });
  const profit = cents(projection.baseProfit), taxableProfit = profit - wages - employerCosts;
  const corporateTax = ratio(positive(taxableProfit), settings.corporateTaxRate), afterTax = taxableProfit - corporateTax;
  const reserveTarget = positive(cents(settings.legalReservePending)), annualReserve = ratio(positive(afterTax), 10);
  const reserveRequired = reserveTarget < annualReserve ? reserveTarget : annualReserve, distributable = positive(afterTax - reserveRequired);
  if (dividends > distributable) issues.push('Los dividendos superan el beneficio repartible estimado después de la reserva legal indicada.');
  if (dividends) {
    const shareholders = settings.people.filter(p => p.isShareholder && p.sharePercent > 0), shares = shareholders.reduce((n, p) => n + p.sharePercent, 0);
    if (Math.abs(shares - 100) > 0.001) issues.push('Las participaciones confirmadas deben sumar el 100 % para simular un reparto proporcional de dividendos.');
    else for (const person of shareholders) if (abs(cents(entries.get(person.id)?.dividendGross || 0) - ratio(dividends, person.sharePercent)) > 1n) issues.push(`El reparto a ${person.name} no corresponde a su porcentaje de participación; revisa los derechos societarios con el gestor.`);
    if (dividendYear <= settings.taxYear) issues.push('El dividendo ordinario del beneficio de este año se acuerda tras el cierre. Un dividendo a cuenta necesita una revisión específica del gestor.');
    if (dividendYear !== planningTaxRules.year) warnings.push(`El IRPF del dividendo exigible en ${dividendYear} se ilustra con la tarifa verificada de ${planningTaxRules.year}; confirma las reglas de su año antes de pagar.`);
  }
  const retained = afterTax - dividends;
  const divWithin = dateIn(dividendDate, addDays(projection.asOf, 1), projection.horizon) ? dividends : ZERO;
  const workWithin = dateIn(workDate, addDays(projection.asOf, 1), projection.horizon) ? wages + employerCosts : ZERO;
  const cashAtHorizon = projection.cashAtHorizon === null ? null : cents(projection.cashAtHorizon) - workWithin - divWithin;
  const cashAfterDistributions = projection.cashAtHorizon === null ? null : cents(projection.cashAtHorizon) - wages - employerCosts - dividends - corporateTax - cents(projection.vatReserve);
  const available = cashAfterDistributions === null ? null : cashAfterDistributions - cents(settings.minimumCash);
  if (available !== null && available < ZERO) issues.push('El escenario supera la caja estimada después de impuestos, pagos y colchón de trabajo.');
  if (taxableProfit < ZERO) warnings.push('Las remuneraciones y sus costes superan el beneficio previsto y generan una pérdida en esta simulación.');
  if (wages && !workWithin) warnings.push(`El pago de la remuneración se sitúa el ${workDate}, fuera del período de caja seleccionado; el coste fiscal del escenario corresponde a ${settings.taxYear}.`);
  if (!settings.corporateTaxConfirmed) warnings.push('Sociedades se calcula con un tipo aún pendiente de confirmar.');
  const knownTax = people.every(p => p.personalTax !== null), personalTax = knownTax ? sum(people, 'personalTax') : null;
  const personalNet = knownTax ? sum(people, 'personalNet') : null;
  const segments = [{ key: 'company-retained', label: 'Queda en Orquivia', amount: euros(retained) }, { key: 'company-tax', label: 'Sociedades', amount: euros(corporateTax) }];
  if (employerCosts) segments.push({ key: 'employer-costs', label: 'Cotización empresarial', amount: euros(employerCosts) });
  for (const person of people) {
    if (person.personalTax === null) segments.push({ key: `person-pending:${person.id}`, personId: person.id, label: `${person.name} · IRPF pendiente`, amount: euros(cents(person.workGross) + cents(person.dividendGross)), pending: true });
    else {
      segments.push({ key: `person-net:${person.id}`, personId: person.id, label: `${person.name} · neto final`, amount: person.personalNet });
      segments.push({ key: `person-tax:${person.id}`, personId: person.id, label: `${person.name} · IRPF`, amount: person.personalTax });
    }
  }
  return { name: scenario.name || 'Escenario', year: settings.taxYear, companyTax: euros(corporateTax), taxableProfit: euros(taxableProfit), companyRetained: euros(retained),
    profitAfterTaxBeforeDividend: euros(afterTax), workTotal: euros(wages), employerCosts: euros(employerCosts), dividendTotal: euros(dividends),
    totalPersonalNet: personalNet === null ? null : euros(personalNet), totalPersonalTax: personalTax === null ? null : euros(personalTax),
    taxTotal: personalTax === null ? null : euros(personalTax + corporateTax), people, segments,
    reserveRequired: euros(reserveRequired), distributableProfit: euros(distributable),
    cashAtHorizon: cashAtHorizon === null ? null : euros(cashAtHorizon), cashAfterDistributions: cashAfterDistributions === null ? null : euros(cashAfterDistributions),
    cashAfterMinimum: available === null ? null : euros(available), workDate, dividendDate, dividendYear,
    corporateTaxExpectedMonth: projection.corporateTaxExpectedMonth, issues: [...new Set(issues)], warnings: [...new Set(warnings)],
    comparableTotal: euros(profit), valid: issues.length === 0, sources: planningTaxRules.sources };
}
const abs = n => n < ZERO ? -n : n;

/** Suggestions need at least two distinct paid months and are never saved automatically. */
export function suggestForecastItems(state, input, { today = todayISO() } = {}) {
  const planning = normalizePlanning(input ?? state.planning, { today }), groups = new Map();
  const fold = text => String(text || '').trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const monthNumber = date => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
  const hash = text => { let h = 2166136261; for (const char of text) h = Math.imul(h ^ char.codePointAt(0), 16777619); return (h >>> 0).toString(36); };
  const usedIds = new Set(planning.items.map(row => row.id));
  for (const expense of state.expenses || []) {
    if (expense.paymentStatus !== 'paid' || expense.kind === 'credit' || !validDate(expense.paidDate || expense.date)) continue;
    const supplier = String(expense.supplier || '').trim(), date = expense.paidDate || expense.date, amount = expenseCashAmount(expense);
    if (!supplier || amount <= 0 || date > planning.settings.asOf) continue;
    const key = `${fold(supplier)}:${cents(amount)}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ expense, date, amount, supplier });
  }
  const results = [];
  for (const [key, rows] of groups) {
    if (new Set(rows.map(row => row.date.slice(0, 7))).size < 2) continue;
    rows.sort((a, b) => b.date.localeCompare(a.date)); const latest = rows[0];
    if (planning.items.some(item => item.active && item.kind === 'expense' && fold(item.label).includes(fold(latest.supplier)) && cents(item.amountGross) === cents(latest.amount))) continue;
    const months = [...new Set(rows.map(row => monthNumber(row.date)))].sort((a, b) => b - a).slice(0, 7);
    const gaps = months.slice(1).map((month, i) => months[i] - month), step = gaps[0];
    if (![1, 3, 12].includes(step) || gaps.some(gap => gap !== step)) continue;
    const recurrence = step === 12 ? 'yearly' : step === 3 ? 'quarterly' : 'monthly';
    let startDate = nextMonth(latest.date, step); for (let n = 2; startDate <= planning.settings.asOf && n < 121; n++) startDate = nextMonth(latest.date, step * n);
    if (startDate > planning.settings.horizon) continue;
    const a = expenseTotals(latest.expense), knownVAT = !a.vatReviewNeeded && a.base !== null && a.base > 0;
    const vatRate = knownVAT && Number.isFinite(latest.expense.vatRate) ? latest.expense.vatRate : null;
    const idBase = `forecast-${hash(key)}-${startDate}`; let id = idBase;
    for (let n = 2; usedIds.has(id); n++) id = `${idBase}-${n}`; usedIds.add(id);
    results.push({ id, label: latest.supplier, kind: 'expense', amountGross: latest.amount,
      vatRate, vatDeductible: vatRate !== null && knownVAT && cents(a.vatAmount) === cents(a.vatDeductibleAmount || 0), treatment: 'operating', recurrence,
      startDate, endDate: null, active: true, linkedRecordIds: rows.slice(0, 36).map(row => row.expense.id),
      evidence: { key, count: rows.length, months: new Set(rows.map(row => row.date.slice(0, 7))).size, lastDate: latest.date, label: `${rows.length} pagos en ${new Set(rows.map(row => row.date.slice(0, 7))).size} meses; confirmar periodicidad y próxima fecha.` } });
  }
  return results.sort((a, b) => a.label.localeCompare(b.label, 'es'));
}
