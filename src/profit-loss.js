import { totals } from './domain.js';
import { expenseTotals, periodRange } from './expenses.js';

const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const ISSUED = new Set(['issued', 'partial', 'paid', 'overdue']);
const TREATMENTS = new Set(['operating', 'financial', 'asset', 'financing', 'transfer', 'tax-settlement', 'pending']);
const EXCLUDED = new Set(['asset', 'financing', 'transfer', 'tax-settlement']);

export function statementValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/** Statement inputs have already been recorded in euros; aggregate exact cents. */
export function statementCents(value) {
  if (!['number', 'string'].includes(typeof value)) throw new Error('El informe contiene un importe no válido.');
  const text = String(value).trim().replace(',', '.');
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match || text.length > 100 || !Number.isFinite(Number(text))) throw new Error('El informe contiene un importe no válido.');
  const sign = match[1] === '-' ? -1n : 1n, fraction = (match[3] || '').padEnd(3, '0');
  const amount = BigInt(match[2]) * 100n + BigInt(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1n : 0n);
  if (amount > MAX_CENTS) throw new Error('El importe supera el límite del informe.');
  return sign * amount;
}

export function statementEuros(value) {
  if (value > MAX_CENTS || value < -MAX_CENTS) throw new Error('La suma supera el límite del informe.');
  return Number(value) / 100;
}

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

/** An identical repeated ID is counted once. Conflicting IDs never silently win. */
export function statementRecords(records = [], name = 'registros') {
  if (!Array.isArray(records)) throw new Error(`La lista de ${name} no es válida.`);
  const byId = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id.trim()) throw new Error(`Falta un identificador en ${name}.`);
    if (byId.has(record.id) && JSON.stringify(stable(byId.get(record.id))) !== JSON.stringify(stable(record))) throw new Error(`Hay versiones distintas del mismo registro en ${name}.`);
    byId.set(record.id, record);
  }
  return [...byId.values()];
}

export function statementRange(state, period) {
  if (period && ('from' in period || 'to' in period)) {
    if (!statementValidDate(period.from) || !statementValidDate(period.to) || period.from > period.to) throw new Error('Selecciona un período válido para el informe.');
    return { type: 'custom', from: period.from, to: period.to, label: `${period.from} a ${period.to}` };
  }
  return periodRange(state, period);
}

const fold = value => String(value || '').trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
function treatmentFor(expense, specified) {
  if (specified !== undefined) {
    if (!TREATMENTS.has(specified)) throw new Error('La clasificación contable indicada no es válida.');
    return specified;
  }
  // Only explicit categories identify capital/transit items. Loan instalments
  // need their principal/interest split; descriptions are not fiscal evidence.
  const category = fold(expense.category);
  if (['gastos financieros', 'intereses', 'intereses de prestamos'].includes(category)) return 'financial';
  if (['inmovilizado', 'inversiones', 'activos fijos'].includes(category)) return 'asset';
  if (['principal de prestamo', 'aportacion de capital', 'aportaciones de capital'].includes(category)) return 'financing';
  if (['traspasos', 'transferencias internas', 'retenciones bancarias temporales'].includes(category)) return 'transfer';
  if (['liquidacion de impuestos', 'liquidaciones fiscales', 'iva y retenciones'].includes(category)) return 'tax-settlement';
  if (['prestamos', 'cuotas de prestamo', 'financiacion'].includes(category) || /constitucion/.test(fold(expense.description))) return 'pending';
  return 'operating';
}

/**
 * Partial accrual-based P&L from application records, never annual accounts.
 * VAT-confirmed=0 in the legacy schema does not prove non-deductibility.
 * Optional expenseTreatments are explicit report inputs, not hidden estimates:
 * { [id]: {treatment, vatTreatment:'recorded'|'deductible'|'non-deductible',
 *           additionalTreatment:'pending'|'expense'|'pass-through'} }.
 */
export function profitLossReport(state, period, { expenseTreatments = {} } = {}) {
  if (!state || typeof state !== 'object' || !expenseTreatments || typeof expenseTreatments !== 'object') throw new Error('Los datos del informe no son válidos.');
  const documents = statementRecords(state.documents, 'documentos'), expenseRecords = statementRecords(state.expenses, 'gastos');
  const taxRecords = statementRecords(state.taxRecords, 'declaraciones'), range = statementRange(state, period);
  const within = date => statementValidDate(date) && range.from && range.to && date >= range.from && date <= range.to;
  const invoices = [], expenses = [], pending = [], excluded = [], linkedTaxesShown = new Set();
  const sums = { salesBase: 0n, operatingExpenses: 0n, financialExpenses: 0n, pendingExpenseGross: 0n, pendingClassificationGross: 0n,
    pendingVATAmount: 0n, pendingAdditionalAmount: 0n, excludedGross: 0n, taxSettlementsGross: 0n };
  const addPending = (entry, type, label, amount = null) => pending.push({ id: `${entry.id}:${type}`, recordId: entry.id, date: entry.date, type, label, amount });
  const invoiceNumbers = new Set();
  for (const doc of documents) {
    if (doc.kind !== 'invoice' || !ISSUED.has(doc.status)) continue;
    if (!statementValidDate(doc.date)) throw new Error('Una factura emitida no tiene fecha válida.');
    if (!within(doc.date)) continue;
    if (doc.number && invoiceNumbers.has(doc.number)) throw new Error('Hay dos facturas emitidas con el mismo número.');
    if (doc.number) invoiceNumbers.add(doc.number);
    if (!Array.isArray(doc.items) || !doc.items.length || doc.items.some(item => !Number.isFinite(Number(item.quantity)) || !Number.isFinite(Number(item.price)) || Number(item.quantity) < 0 || Number(item.price) < 0)) throw new Error('Revisa los conceptos de las facturas del informe.');
    const amount = totals(doc).base;
    sums.salesBase += statementCents(amount);
    invoices.push({ id: doc.id, date: doc.date, number: doc.number || '', description: doc.title || doc.items.map(item => item.description || '').join(' · '), amount });
    if (doc.reviewRequired) addPending(doc, 'invoice-review', `Revisar la factura ${doc.number || doc.id}.`);
  }

  for (const expense of expenseRecords) {
    if (!statementValidDate(expense.date)) throw new Error('Un gasto no tiene fecha válida.');
    if (!within(expense.date)) continue;
    const selection = expenseTreatments[expense.id] || {}, treatment = treatmentFor(expense, selection.treatment);
    const amounts = expenseTotals(expense), gross = statementCents(amounts.total), additional = statementCents(amounts.additionalAmount || 0);
    if (statementCents(expense.total) !== gross) throw new Error('El total de un gasto no coincide con su desglose.');
    const row = { id: expense.id, date: expense.date, description: expense.description || '', supplier: expense.supplier || '', reference: expense.reference || '',
      category: expense.category || 'Otros', treatment, grossTotal: amounts.total, base: amounts.base, vatAmount: amounts.vatAmount, costKnown: null };
    expenses.push(row);
    if (EXCLUDED.has(treatment)) {
      excluded.push({ id: expense.id, recordId: expense.id, date: expense.date, type: treatment, label: expense.description || expense.category || 'Partida ajena al gasto corriente', amount: amounts.total });
      sums.excludedGross += gross;continue;
    }
    if (treatment === 'pending') {
      sums.pendingClassificationGross += gross;
      addPending(expense, 'classification', `Clasificar contablemente: ${expense.description || 'gasto registrado'}.`, amounts.total);continue;
    }
    const vatTreatment = selection.vatTreatment || 'recorded';
    if (!['recorded', 'deductible', 'non-deductible'].includes(vatTreatment)) throw new Error('El tratamiento de IVA indicado no es válido.');
    if (amounts.base === null && vatTreatment === 'non-deductible') {
      // A documented non-deductibility decision permits the gross cost even
      // when the separate VAT amount is unavailable. No VAT amount is invented.
      row.costKnown = statementEuros(gross - additional);
    } else if (amounts.base === null) {
      sums.pendingExpenseGross += gross - additional;
      addPending(expense, 'vat-breakdown', `Base e IVA pendientes: ${expense.description || 'gasto registrado'}.`, statementEuros(gross - additional));
    } else {
      let cost = statementCents(amounts.base), vat = statementCents(amounts.vatAmount), deductible = statementCents(amounts.vatDeductibleAmount);
      if (vatTreatment === 'non-deductible') cost += vat;
      else if (vatTreatment === 'recorded' && vat !== deductible) {
        const unconfirmed = vat - deductible;
        sums.pendingVATAmount += unconfirmed;
        addPending(expense, 'vat-treatment', `Confirmar el tratamiento del IVA: ${expense.description || 'gasto registrado'}.`, statementEuros(unconfirmed));
      }
      row.costKnown = statementEuros(cost);
    }
    if (additional !== 0n) {
      const linkedRecords = taxRecords.filter(record => record.paymentStatus === 'included' && record.linkedExpenseId === expense.id);
      const linkedTax = linkedRecords.reduce((sum, record) => sum + statementCents(record.amount), 0n);
      if (linkedTax < 0n || linkedTax > (additional > 0n ? additional : 0n)) throw new Error('El impuesto vinculado supera el importe adicional del gasto.');
      const other = additional - linkedTax, additionalTreatment = selection.additionalTreatment || 'pending';
      if (!['pending', 'expense', 'pass-through'].includes(additionalTreatment)) throw new Error('El tratamiento de otros importes no es válido.');
      if (linkedTax !== 0n) {
        linkedRecords.forEach(record => linkedTaxesShown.add(record.id));
        excluded.push({ id: `${expense.id}:linked-tax`, recordId: expense.id, date: expense.date, type: 'linked-tax', label: 'Liquidación fiscal incluida en el pago del proveedor', amount: statementEuros(linkedTax) });
      }
      if (other !== 0n && additionalTreatment === 'expense') row.costKnown = statementEuros(statementCents(row.costKnown || 0) + other);
      else if (other !== 0n && additionalTreatment === 'pass-through') excluded.push({ id: `${expense.id}:pass-through`, recordId: expense.id, date: expense.date, type: 'pass-through', label: 'Suplido / importe por cuenta de terceros', amount: statementEuros(other) });
      else if (other !== 0n) {
        sums.pendingAdditionalAmount += other;
        addPending(expense, 'additional', `Clasificar suplidos u otros importes: ${expense.description || 'gasto registrado'}.`, statementEuros(other));
      }
    }
    if (row.costKnown !== null) sums[treatment === 'financial' ? 'financialExpenses' : 'operatingExpenses'] += statementCents(row.costKnown);
    if (!expense.attachments?.length) addPending(expense, 'receipt', `Falta el justificante: ${expense.description || 'gasto registrado'}.`);
    else if (expense.reviewNeeded) addPending(expense, 'receipt-review', `Revisar el justificante: ${expense.description || 'gasto registrado'}.`);
  }

  for (const record of taxRecords.filter(record => within(record.date))) {
    if (!linkedTaxesShown.has(record.id)) excluded.push({ id: record.id, recordId: record.id, date: record.date, type: 'tax-settlement', label: `Liquidación del modelo ${record.model || ''}`, amount: record.amount });
    sums.taxSettlementsGross += statementCents(record.amount);
  }
  const knownExpenses = sums.operatingExpenses + sums.financialExpenses, resultBeforePending = sums.salesBase - knownExpenses;
  const summary = { ...Object.fromEntries(Object.entries(sums).map(([name, amount]) => [name, statementEuros(amount)])),
    knownExpenses: statementEuros(knownExpenses), resultBeforePending: statementEuros(resultBeforePending), netResult: null,
    invoiceCount: invoices.length, expenseCount: expenses.length, pendingCount: pending.length,
    duplicateCount: (state.documents?.length || 0) - documents.length + (state.expenses?.length || 0) - expenseRecords.length };
  return { title: 'Cuenta de pérdidas y ganancias', range, status: 'provisional', summary, invoices, expenses, pending, excluded,
    lines: [
      { id: 'sales', label: 'Ingresos por facturas emitidas, sin IVA', amount: summary.salesBase },
      { id: 'operating-expenses', label: 'Gastos de explotación con importe contable conocido', amount: summary.operatingExpenses },
      { id: 'financial-expenses', label: 'Gastos financieros con importe contable conocido', amount: summary.financialExpenses },
      { id: 'result-before-pending', label: 'Resultado parcial antes de partidas pendientes', amount: summary.resultBeforePending },
      { id: 'final-result', label: 'Resultado contable completo', amount: null },
    ],
    limitations: [
      'Informe provisional de los registros de la aplicación. No constituye unas cuentas anuales ni una cuenta contable cerrada por el gestor.',
      'Criterio de devengo aproximado por fecha de factura o justificante; un movimiento bancario sin documento puede tener una fecha de devengo distinta.',
      'Los presupuestos, cobros, saldos iniciales y liquidaciones de IVA o retenciones no se suman como ventas ni como gastos.',
      'Las partidas sin desglose de IVA o con clasificación pendiente se muestran separadamente. El resultado parcial no incorpora sus importes pendientes.',
      'No constan de forma completa amortizaciones, existencias, periodificaciones, nóminas, deterioros ni impuesto sobre beneficios; deben revisarse con el gestor.',
    ] };
}
