import { todayISO } from './domain.js';
import { cashSummary, expenseCashMovements, taxCashMovements } from './expenses.js';
import { normalizePlanning, planningProjection, expandForecast } from './planning.js';
import { statementCents as cents, statementEuros as euros, statementValidDate as validDate, statementRecords } from './profit-loss.js';

const ISSUED = new Set(['issued', 'partial', 'paid', 'overdue']);
const ZERO = 0n;
const positive = value => value > ZERO ? value : ZERO;
const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const typedID = (type, id) => `${type}:${id}`;
const dayBefore = date => { const result = new Date(`${date}T00:00:00Z`); result.setUTCDate(result.getUTCDate() - 1); return result.toISOString().slice(0, 10); };
const monthEnd = key => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10);

/**
 * Read-only cash ledger. A document is an obligation, and a dated bank movement
 * is cash: their dates and amounts deliberately remain separate.
 * Planning v1 links are retained; there are no inferred matches by supplier/name.
 */
export function forecastLedger(state, input, { today = todayISO(), year } = {}) {
  const p = normalizePlanning(input ?? state.planning, { today });
  year = Number(year ?? p.settings.taxYear);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error('Selecciona un año válido para la previsión.');
  const documents = statementRecords(state.documents || [], 'documentos');
  const expenses = statementRecords(state.expenses || [], 'gastos');
  const payments = statementRecords(state.payments || [], 'cobros');
  const taxRecords = statementRecords(state.taxRecords || [], 'declaraciones');
  const sourceState = { ...state, documents, expenses, payments, taxRecords };
  const projection = planningProjection(sourceState, p, { today });
  const { asOf, horizon } = p.settings, from = `${year}-01-01`, to = `${year}-12-31`;
  const months = MONTHS.map((label, i) => ({ key: `${year}-${String(i + 1).padStart(2, '0')}`, label,
    withinHorizon: `${year}-${String(i + 1).padStart(2, '0')}-01` <= horizon }));
  const warnings = [...projection.warnings], rows = new Map(), recordOwner = new Map();
  const issued = documents.filter(doc => doc.kind === 'invoice' && ISSUED.has(doc.status));
  const invoiceByID = new Map(issued.map(doc => [doc.id, doc]));
  const eligibleRecords = [
    ...issued.map(record => ({ type: 'invoice', record })),
    ...documents.filter(doc => doc.kind === 'quote' && doc.status === 'accepted').map(record => ({ type: 'quote', record })),
    ...expenses.map(record => ({ type: 'expense', record })),
    ...taxRecords.map(record => ({ type: 'tax', record })),
  ];
  const recordLabel = (type, record) => type === 'invoice' || type === 'quote'
    ? [record.number || (type === 'quote' ? 'Presupuesto aceptado' : 'Factura'), record.title].filter(Boolean).join(' · ')
    : type === 'tax' ? `Modelo ${record.model || ''}${record.year ? ` · ${record.year}` : ''}${record.quarter ? ` T${record.quarter}` : ''}`
      : record.description || record.supplier || 'Gasto registrado';
  const recordKind = (type, record) => type === 'invoice' || type === 'quote' ? 'income' : type === 'tax' ? 'tax' : 'expense';
  const addRow = spec => {
    if (!rows.has(spec.id)) rows.set(spec.id, { ...spec, months: Object.fromEntries(months.map(month => [month.key, { actual: ZERO, expected: ZERO, entries: [] }])) });
    return rows.get(spec.id);
  };
  for (const item of p.items) {
    addRow({ id: typedID('forecast', item.id), itemId: item.id, label: item.label,
      kind: item.kind === 'income' ? 'income' : item.treatment === 'tax' ? 'tax' : 'expense',
      source: 'forecast', recordIds: [], recurrence: item.recurrence, active: item.active });
    for (const rawID of item.linkedRecordIds) {
      const matches = eligibleRecords.filter(({ type, record }) => record.id === rawID &&
        (item.kind === 'income' ? ['invoice', 'quote'].includes(type) : ['expense', 'tax'].includes(type)));
      if (matches.length > 1) { warnings.push(`${item.label}: el identificador vinculado coincide con varios registros; revisa el enlace.`); continue; }
      if (!matches.length) continue;
      const { type, record } = matches[0], key = typedID(type, record.id);
      if (recordOwner.has(key) && recordOwner.get(key) !== item.id) {
        warnings.push(`${recordLabel(type, record)} está vinculado a varias previsiones; se muestra una sola vez.`); continue;
      }
      recordOwner.set(key, item.id);
    }
  }
  // A quote's issued invoice takes over the same explicit planning relationship.
  for (const invoice of issued) if (!recordOwner.has(typedID('invoice', invoice.id)) && invoice.quoteId && recordOwner.has(typedID('quote', invoice.quoteId))) {
    recordOwner.set(typedID('invoice', invoice.id), recordOwner.get(typedID('quote', invoice.quoteId)));
  }
  for (const tax of taxRecords) if (tax.paymentStatus === 'included' && tax.linkedExpenseId && recordOwner.has(typedID('tax', tax.id))) {
    const expense = expenses.find(record => record.id === tax.linkedExpenseId);
    if (!expense) continue;
    const key = typedID('expense', expense.id), owner = recordOwner.get(typedID('tax', tax.id));
    if (!recordOwner.has(key)) recordOwner.set(key, owner);
    else if (recordOwner.get(key) !== owner) warnings.push(`${recordLabel('tax', tax)} comparte un pago vinculado a otra previsión; revisa los enlaces.`);
  }
  const rowForRecord = (type, record) => {
    const itemID = recordOwner.get(typedID(type, record.id));
    const row = itemID ? rows.get(typedID('forecast', itemID)) : addRow({ id: typedID(type, record.id), itemId: null,
      label: recordLabel(type, record), kind: recordKind(type, record), source: type, recordIds: [], recurrence: null, active: true });
    if (!row.recordIds.includes(record.id)) row.recordIds.push(record.id);
    return row;
  };
  const addEntry = (row, entry) => {
    if (!validDate(entry.date) || entry.date < from || entry.date > to) return;
    const cell = row.months[entry.date.slice(0, 7)];
    if (!cell) return;
    cell[entry.status] += entry.amount;
    cell.entries.push({ ...entry, amount: euros(entry.amount) });
  };
  const actualEntry = (type, record, movement, index = 0) => {
    if (!validDate(movement.date) || movement.date > asOf) return;
    const amount = type === 'invoice' ? positive(cents(movement.amount)) : -cents(movement.amount);
    const entry = { id: `actual:${type}:${record.id}:${movement.id || `${movement.date}:${index}`}`, recordId: record.id,
      recordType: type, label: recordLabel(type, record), date: movement.date, amount, status: 'actual' };
    if (movement.date >= from && movement.date <= to) addEntry(rowForRecord(type, record), entry);
  };
  for (const payment of payments) {
    const invoice = invoiceByID.get(payment.documentId);
    if (invoice) actualEntry('invoice', invoice, payment);
  }
  for (const expense of expenses) expenseCashMovements(expense).forEach((movement, index) => actualEntry('expense', expense, movement, index));
  for (const record of taxRecords) taxCashMovements(record).forEach((movement, index) => actualEntry('tax', record, movement, index));

  // Reuse the projection's exact future flows, so the cash view and simulator agree.
  const flowRecords = new Map();
  for (const payment of payments) if (invoiceByID.has(payment.documentId)) flowRecords.set(`payment:${payment.id}`, { type: 'invoice', record: invoiceByID.get(payment.documentId) });
  for (const invoice of issued) flowRecords.set(`invoice:${invoice.id}`, { type: 'invoice', record: invoice });
  for (const quote of documents.filter(doc => doc.kind === 'quote')) flowRecords.set(`accepted:${quote.id}`, { type: 'quote', record: quote });
  for (const expense of expenses) {
    flowRecords.set(`payable:${expense.id}`, { type: 'expense', record: expense });
    for (const movement of expenseCashMovements(expense)) flowRecords.set(`expense:${expense.id}:${movement.date}`, { type: 'expense', record: expense });
  }
  for (const record of taxRecords) {
    flowRecords.set(`tax:${record.id}`, { type: 'tax', record });
    flowRecords.set(`payable-tax:${record.id}`, { type: 'tax', record });
  }
  for (const [flowIndex, flow] of projection.flows.entries()) {
    const amount = cents(flow.amount), known = flowRecords.get(flow.id);
    let row;
    if (flow.kind === 'forecast' && flow.itemId) row = rows.get(typedID('forecast', flow.itemId));
    else if (known) row = rowForRecord(known.type, known.record);
    else row = addRow({ id: typedID('flow', flow.id), itemId: null, label: flow.label, kind: amount < ZERO ? 'expense' : 'income', source: flow.kind, recordIds: [], recurrence: null, active: true });
    if (row) addEntry(row, { id: `expected:${flow.id}:${flowIndex}`, recordId: known?.record.id || null,
      recordType: known?.type || 'forecast', label: flow.label, date: flow.date, amount, status: 'expected' });
  }

  const cashNow = projection.cashNow, manualBalance = p.settings.cashBalanceOverride !== null;
  const configured = cashSummary(sourceState, asOf);
  const balanceKnownFrom = cashNow === null ? null : manualBalance ? asOf : configured.openingBalanceDate;
  // A balance confirmed mid-year is an anchor, not proof of January's balance.
  let opening = null;
  if (cashNow !== null && balanceKnownFrom && balanceKnownFrom <= from) {
    if (asOf < from) opening = cents(cashNow) + projection.flows.filter(flow => flow.date < from).reduce((total, flow) => total + cents(flow.amount), ZERO);
    else if (manualBalance) opening = null;
    else if (balanceKnownFrom === from) opening = cents(configured.openingBalance);
    else { const known = cashSummary(sourceState, dayBefore(from)); opening = known.balance === null ? null : cents(known.balance); }
  }
  const resultRows = [...rows.values()].map(row => {
    let actual = ZERO, expected = ZERO;
    const cells = Object.fromEntries(Object.entries(row.months).map(([month, cell]) => {
      actual += cell.actual; expected += cell.expected;
      return [month, { actual: euros(cell.actual), expected: euros(cell.expected), total: euros(cell.actual + cell.expected), entries: cell.entries }];
    }));
    return { ...row, months: cells, actual: euros(actual), expected: euros(expected), total: euros(actual + expected) };
  }).filter(row => row.itemId || Object.values(row.months).some(cell => cell.entries.length));
  const series = months.map(month => {
    let actualIn = ZERO, actualOut = ZERO, expectedIn = ZERO, expectedOut = ZERO;
    for (const row of resultRows) {
      const cell = row.months[month.key];
      for (const entry of cell.entries) {
        const n = cents(entry.amount);
        if (entry.status === 'actual') { if (n >= ZERO) actualIn += n; else actualOut -= n; }
        else { if (n >= ZERO) expectedIn += n; else expectedOut -= n; }
      }
    }
    const actualNet = actualIn - actualOut, expectedNet = expectedIn - expectedOut;
    const end = monthEnd(month.key), actualDate = end < asOf ? end : asOf;
    let closingActual = null, closingExpected = null;
    if (`${month.key}-01` <= asOf && balanceKnownFrom && actualDate >= balanceKnownFrom) {
      closingActual = manualBalance ? actualDate === asOf ? cashNow : null : cashSummary(sourceState, actualDate).balance;
    }
    if (month.withinHorizon && balanceKnownFrom && end >= balanceKnownFrom) {
      if (end <= asOf) closingExpected = closingActual;
      else if (cashNow !== null) {
        const limit = end < horizon ? end : horizon;
        closingExpected = euros(cents(cashNow) + projection.flows.filter(flow => flow.date <= limit).reduce((total, flow) => total + cents(flow.amount), ZERO));
      }
    }
    return { month: month.key, actualIn: euros(actualIn), actualOut: euros(actualOut), expectedIn: euros(expectedIn), expectedOut: euros(expectedOut),
      actualNet: euros(actualNet), expectedNet: euros(expectedNet), net: euros(actualNet + expectedNet),
      actualBalance: closingActual, closingBalance: closingExpected, closingActual, closingExpected };
  });
  const totalsCents = series.reduce((total, row) => {
    for (const key of ['actualIn', 'actualOut', 'expectedIn', 'expectedOut']) total[key] += cents(row[key]);
    return total;
  }, { actualIn: ZERO, actualOut: ZERO, expectedIn: ZERO, expectedOut: ZERO });
  const totals = Object.fromEntries(Object.entries(totalsCents).map(([key, value]) => [key, euros(value)]));
  totals.net = euros(totalsCents.actualIn - totalsCents.actualOut + totalsCents.expectedIn - totalsCents.expectedOut);
  const unscheduled = projection.receivables.filter(row => !row.date).map(row => ({ ...row, reason: 'Falta indicar una fecha de cobro prevista.' }));
  for (const { type, record } of eligibleRecords) if (['expense', 'tax'].includes(type) && record.paymentStatus === 'unconfirmed') {
    const label = recordLabel(type, record);
    unscheduled.push({ id: record.id, kind: type, label, amount: record.amount ?? record.total ?? 0, date: null,
      reason: 'Pago por confirmar: revisa si está pagado o pendiente antes de incorporarlo a caja.' });
    if (recordOwner.has(typedID(type, record.id))) warnings.push(`${label}: su pago no está confirmado; la previsión vinculada se conserva.`);
  }
  const periodMatches = (occurrence, record) => {
    if (occurrence.recurrence === 'once') return true;
    if (!validDate(record.date)) return false;
    if (occurrence.recurrence === 'yearly') return record.date.slice(0, 4) === occurrence.date.slice(0, 4);
    if (occurrence.recurrence === 'quarterly') return record.date.slice(0, 4) === occurrence.date.slice(0, 4) &&
      Math.floor((Number(record.date.slice(5, 7)) - 1) / 3) === Math.floor((Number(occurrence.date.slice(5, 7)) - 1) / 3);
    return record.date.slice(0, 7) === occurrence.date.slice(0, 7);
  };
  const pastTo = asOf < to ? asOf : to;
  const overdueOccurrences = pastTo < from ? [] : expandForecast(p.items, { from, to: pastTo }).filter(occurrence =>
    !eligibleRecords.some(({ type, record }) => {
      if (['expense', 'tax'].includes(type) && !['paid', 'pending', 'included'].includes(record.paymentStatus)) return false;
      const effective = type === 'quote' ? issued.find(doc => doc.quoteId === record.id)
        || { ...record, date: p.settings.collectionDates[record.id] || record.date }
        : type === 'tax' && record.paymentStatus === 'included' ? expenses.find(expense => expense.id === record.linkedExpenseId && ['paid', 'pending'].includes(expense.paymentStatus)) : record;
      if (!effective) return false;
      return recordOwner.get(typedID(type, record.id)) === occurrence.itemId && periodMatches(occurrence, effective);
    })
  ).map(occurrence => ({ id: occurrence.id, itemId: occurrence.itemId, date: occurrence.date, label: occurrence.label,
    kind: occurrence.kind, amount: occurrence.amountGross, recurrence: occurrence.recurrence,
    reason: 'Previsión con fecha pasada sin registro: revisa o reprograma. No se incluye en caja.' }));
  if (overdueOccurrences.length) warnings.push('Hay previsiones con fecha pasada sin registro: revisa o reprograma. No se presuponen deudas ni se descuentan del saldo confirmado.');
  return { year, asOf, horizon, months, rows: resultRows, totals, series, monthly: series,
    cashNow, openingBalance: opening === null ? null : euros(opening),
    closingBalance: [...series].reverse().find(row => row.closingBalance !== null)?.closingBalance ?? null,
    projection, unscheduled, overdueOccurrences, balanceKnownFrom, warnings: [...new Set(warnings)], balanceSource: manualBalance ? 'manual' : 'recorded' };
}
