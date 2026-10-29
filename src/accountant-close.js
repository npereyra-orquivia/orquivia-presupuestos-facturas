import { profitLossReport, statementCents as cents, statementEuros as euros, statementValidDate as validDate } from './profit-loss.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 500) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('El cierre necesita textos y fuentes válidos.'); return value.trim(); };
const number = value => { if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12 || Math.abs(value * 100 - Math.round(value * 100)) > 0.0001) throw new Error('El cierre contiene un importe inválido.'); return euros(cents(value)); };
const sum = rows => rows.reduce((total, row) => total + cents(row.amount), 0n);
const nextDay = value => { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); };
const taxId = value => String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();

/** A sourced report is a reference, never a replacement for operational records. */
export function validateAccountantClose(input, company = {}) {
  if (!object(input) || input.format !== 'orquivia-accountant-close' || input.version !== 1) throw new Error('Selecciona un archivo de cierre contable compatible.');
  if (![input.from, input.asOf, input.issuedAt].every(validDate) || input.from > input.asOf || input.issuedAt < input.asOf || input.from !== `${input.asOf.slice(0, 4)}-01-01`) throw new Error('Las fechas del cierre no son válidas. Se requiere un cierre acumulado desde enero.');
  if (!taxId(input.taxId) || (company.taxId && taxId(company.taxId) !== taxId(input.taxId))) throw new Error('El NIF del cierre no coincide con el de la empresa.');
  const rows = (value, nonnegative = false) => {
    if (!Array.isArray(value) || value.length > 300) throw new Error('Las partidas del cierre no son válidas.');
    const accounts = new Set();
    return value.map(row => {
      if (!object(row) || typeof row.account !== 'string' || !/^\d{3,12}$/.test(row.account) || accounts.has(row.account)) throw new Error('Las cuentas contables deben ser válidas y únicas en cada grupo.');
      accounts.add(row.account); const amount = number(row.amount);
      if (nonnegative && amount < 0) throw new Error('Los costes del cierre deben indicarse como importes positivos.');
      return { account: row.account, label: text(row.label, 200), amount };
    });
  };
  if (!object(input.profitLoss) || !object(input.balance)) throw new Error('El archivo debe incluir pérdidas y ganancias y balance.');
  const p = input.profitLoss;
  const profitLoss = { sales: number(p.sales), expenses: rows(p.expenses, true), resultBeforeTax: number(p.resultBeforeTax), result: number(p.result), corporateTax: p.corporateTax === null ? null : number(p.corporateTax) };
  if (cents(profitLoss.sales) - sum(profitLoss.expenses) !== cents(profitLoss.resultBeforeTax) || cents(profitLoss.resultBeforeTax) - cents(profitLoss.corporateTax ?? 0) !== cents(profitLoss.result)) throw new Error('Las sumas de pérdidas y ganancias no coinciden con el resultado del cierre.');
  const balance = { assets: rows(input.balance.assets), liabilities: rows(input.balance.liabilities), equity: rows(input.balance.equity) };
  if (!balance.assets.length || !balance.equity.length || sum(balance.assets) !== sum(balance.liabilities) + sum(balance.equity)) throw new Error('El activo no coincide con el patrimonio neto más el pasivo del informe.');
  if (!balance.equity.some(row => row.account === '129' && cents(row.amount) === cents(profitLoss.result))) throw new Error('El resultado del balance no coincide con pérdidas y ganancias.');
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 12) throw new Error('Faltan las referencias de los documentos originales.');
  const sources = input.sources.map(source => { if (!object(source) || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) throw new Error('La referencia de un original no es válida.'); return { name: text(source.name, 240), sha256: source.sha256 }; });
  const notes = input.notes ?? [];
  if (!Array.isArray(notes) || notes.length > 20) throw new Error('Las observaciones del cierre no son válidas.');
  const filings = input.taxFilings ?? [];
  if (!Array.isArray(filings) || filings.length > 12) throw new Error('Las declaraciones del cierre no son válidas.');
  const taxFilings = filings.map(row => {
    if (!object(row) || !['303', '111'].includes(row.model) || row.year !== Number(input.asOf.slice(0, 4)) || !Number.isInteger(row.quarter) || row.quarter < 1 || row.quarter > 4 || new Date(Date.UTC(row.year, row.quarter * 3, 0)).toISOString().slice(0,10) > input.asOf) throw new Error('El período fiscal no está incluido en el cierre.');
    return { model: row.model, year: row.year, quarter: row.quarter, result: number(row.result), ...Object.fromEntries(['vatCharged', 'vatDeductible', 'priorCreditApplied'].filter(key => row[key] !== undefined).map(key => [key, number(row[key])])) };
  });
  if (new Set(taxFilings.map(row => `${row.model}-${row.quarter}`)).size !== taxFilings.length) throw new Error('Hay declaraciones repetidas en el cierre.');
  return { format: input.format, version: 1, from: input.from, asOf: input.asOf, issuedAt: input.issuedAt, taxId: taxId(input.taxId), source: text(input.source), sources, profitLoss, balance, taxFilings, notes: notes.map(note => text(note, 1500)) };
}

export function forecastInputs(input = {}) {
  const result = {};
  for (const key of ['futureSales', 'futureCosts', 'payrollCost', 'taxProvision']) {
    const raw = input[key]; if (raw === undefined || raw === null || String(raw).trim() === '') { result[key] = key === 'taxProvision' ? null : 0; continue; }
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(String(raw).trim())) throw new Error('Las previsiones deben ser importes positivos con un máximo de dos decimales.');
    result[key] = number(Number(String(raw).replace(',', '.')));
  }
  return result;
}

export function accountantAlignment(state, period, { actualThrough = new Date().toISOString().slice(0, 10) } = {}) {
  if (!state.company?.accountantClose) return null;
  const close = validateAccountantClose(state.company.accountantClose, state.company);
  const application = profitLossReport(state, { from: close.from, to: close.asOf });
  if (!validDate(actualThrough)) throw new Error('La fecha de referencia de la previsión no es válida.');
  const through = [period.to, actualThrough, `${close.asOf.slice(0,4)}-12-31`].sort()[0];
  const later = through > close.asOf ? profitLossReport(state, { from: nextDay(close.asOf), to: through }) : null;
  const forecast = forecastInputs(state.company.accountantForecast);
  const costs = euros(sum(close.profitLoss.expenses));
  const beforeTax = euros(cents(close.profitLoss.resultBeforeTax) + cents(later?.summary.resultBeforePending ?? 0) + cents(forecast.futureSales) - cents(forecast.futureCosts) - cents(forecast.payrollCost));
  return { close, application, later, costs, through, forecast, beforeTax,
    afterTax: forecast.taxProvision === null || later?.pending.length ? null : euros(cents(beforeTax) - cents(forecast.taxProvision)),
    pendingGross: later ? euros(cents(later.summary.pendingExpenseGross) + cents(later.summary.pendingClassificationGross) + cents(later.summary.pendingVATAmount) + cents(later.summary.pendingAdditionalAmount)) : 0,
    comparison: [{ label: 'Ventas sin IVA', accountant: close.profitLoss.sales, application: application.summary.salesBase }, { label: 'Gastos con coste identificado', accountant: costs, application: application.summary.knownExpenses }].map(row => ({ ...row, difference: euros(cents(row.accountant) - cents(row.application)) })) };
}

/** Use the close once; only subsequent records can change the accrued result. */
export function alignStatements(state, period, profitLoss, balance, options = {}) {
  const alignment = accountantAlignment(state, period, options);
  if (!alignment) return { profitLoss, balance, alignment: null };
  const c = alignment.close, applies = period.from === c.from && period.to >= c.asOf && period.to.slice(0, 4) === c.asOf.slice(0, 4);
  if (!applies) return { profitLoss, balance, alignment };
  const p = period.to === c.asOf ? null : profitLossReport(state, { from: nextDay(c.asOf), to: period.to }, options);
  const note = `Referencia del gestor a ${c.asOf}: ${c.source}`;
  const summary = { ...profitLoss.summary, ...Object.fromEntries(['pendingExpenseGross','pendingClassificationGross','pendingVATAmount','pendingAdditionalAmount','excludedGross','taxSettlementsGross'].map(key=>[key,0])), ...(p?.summary || {}), operatingExpenses: euros(cents(alignment.costs)+cents(p?.summary.operatingExpenses??0)), financialExpenses:p?.summary.financialExpenses??0, salesBase: euros(cents(c.profitLoss.sales) + cents(p?.summary.salesBase ?? 0)), knownExpenses: euros(cents(alignment.costs) + cents(p?.summary.knownExpenses ?? 0)), resultBeforePending: euros(cents(c.profitLoss.resultBeforeTax) + cents(p?.summary.resultBeforePending ?? 0)), netResult: p ? null : c.profitLoss.result, pendingCount: p?.pending.length ?? 0 };
  const lines = [{ id: 'accountant-result', label: `Resultado antes de impuestos según gestor a ${c.asOf}`, amount: c.profitLoss.resultBeforeTax, source: c.source }, ...(p ? [{ id: 'later-sales', label: 'Ventas posteriores al cierre, sin IVA', amount: p.summary.salesBase }, { id: 'later-costs', label: 'Costes posteriores identificados', amount: -p.summary.knownExpenses }, { id: 'result-before-pending', label: 'Resultado acumulado antes de impuestos y partidas pendientes', amount: summary.resultBeforePending }] : [{ id: 'sales', label: 'Ventas sin IVA según gestor', amount: c.profitLoss.sales }, ...c.profitLoss.expenses.map(row => ({ id: row.account, label: `${row.account} · ${row.label}`, amount: -row.amount })), { id: 'final-result', label: 'Resultado del ejercicio mostrado por el gestor', amount: c.profitLoss.result }])];
  profitLoss = { ...profitLoss, status: p ? 'provisional' : 'accountant-reference', summary, lines, invoices: p?.invoices || [], expenses: p?.expenses || [], pending: p?.pending || [], excluded: p?.excluded || [], accountantClose: c, limitations: [note, 'Los registros anteriores al cierre no se suman otra vez. Los informes agregados del gestor no cambian el tratamiento individual de los justificantes.', 'Resultado antes de decidir retribuciones o dividendos; el informe del gestor no acredita una provisión de Impuesto sobre Sociedades cuando esta no aparece desglosada.', ...(p?.limitations || []), ...c.notes] };
  if (!p) {
    const make = group => c.balance[group].map(row => ({ id: row.account, label: `${row.account} · ${row.label}`, amount: row.amount, source: c.source }));
    const assets = make('assets'), liabilities = make('liabilities'), equity = make('equity');
    balance = { ...balance, status: 'accountant-reference', assets, liabilities, equity, missing: [], pending: [], limitations: [note, ...c.notes], summary: { ...balance.summary, knownAssets: euros(sum(assets)), knownLiabilities: euros(sum(liabilities)), equity: euros(sum(equity)), bankBalance: c.balance.assets.find(row => row.account === '572')?.amount ?? null, arithmeticDifference: 0, balanced: true, complete: true, pendingCount: 0 } };
  }
  return { profitLoss, balance, alignment };
}
