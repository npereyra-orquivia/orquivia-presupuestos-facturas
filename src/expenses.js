import { outstanding, status, totals, todayISO } from './domain.js';

const MAX_MONEY_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

/** Reviewing the voucher and confirming its fiscal VAT breakdown are separate. */
export function expenseNeedsReview(expense) {
  const recordedUnknown = ['included-unitemized', 'not-stated'].includes(expense.vatDocumentStatus);
  const missingAcknowledged = !(expense.attachments || []).length
    && typeof expense.missingReceiptReason === 'string' && Boolean(expense.missingReceiptReason.trim());
  return Boolean(expense.reviewNeeded || (expense.vatReviewNeeded && !recordedUnknown && !missingAcknowledged)
    || (!(expense.attachments || []).length && !missingAcknowledged));
}
export function expenseVATLabel(expense) {
  if (!(expense.attachments || []).length && typeof expense.missingReceiptReason === 'string' && expense.missingReceiptReason.trim()) return 'Sin justificante · IVA sin confirmar · para el gestor';
  if (expense.vatDocumentStatus === 'included-unitemized') return 'IVA incluido, sin desglose · para el gestor';
  if (expense.vatDocumentStatus === 'not-stated') return 'Justificante sin datos de IVA · para el gestor';
  return expense.vatReviewNeeded ? 'Por revisar: base e IVA sin confirmar' : 'Registrado';
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** Decimal arithmetic is done in cents, including half-cent rounding, without binary floats. */
function cents(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) return 0n;
  const source = String(value).trim().replace(',', '.');
  if (source.length > 1000) return 0n;
  const match = source.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match || (!match[2] && !match[3])) return 0n;
  const exponent = Number(match[4] || 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 400) return 0n;
  let numerator = BigInt(`${match[2] || ''}${match[3] || ''}` || '0');
  const scale = (match[3] || '').length - exponent - 2;
  if (scale > 0) {
    const denominator = 10n ** BigInt(scale);
    numerator = (numerator + denominator / 2n) / denominator;
  } else numerator *= 10n ** BigInt(-scale);
  return numerator * (match[1] === '-' ? -1n : 1n);
}

function euros(value) {
  if (value > MAX_MONEY_CENTS || value < -MAX_MONEY_CENTS) throw new Error('La suma supera el límite de importe permitido.');
  return Number(value) / 100;
}

function positiveCents(value) { const result = cents(value); return result > 0n ? result : 0n; }

function requireDecimal(value) {
  const source = String(value).trim().replace(',', '.');
  if (!['number', 'string'].includes(typeof value) || source.length > 1000
    || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(source)
    || !Number.isFinite(Number(source))) throw new Error('Introduce un importe decimal válido.');
}

/** The document's real VAT amount is explicit; an effective rate is not tax deductibility. */
export function expenseTotals(expense = {}) {
  const credit = expense.kind === 'credit';
  const amount = (value) => { const parsed = cents(value); return credit ? (parsed < 0n ? parsed : 0n) : (parsed > 0n ? parsed : 0n); };
  const base = amount(expense.base), vatAmount = amount(expense.vatAmount), additional = amount(expense.additionalAmount ?? 0);
  const deductible = amount(expense.vatDeductibleAmount ?? 0);
  const additionalField = expense.additionalAmount === undefined ? {} : { additionalAmount: euros(additional) };
  // The stored base is only a placeholder until the receipt's VAT is checked.
  // Its gross amount can affect cash, but it must not appear as a confirmed tax base.
  if (expense.vatReviewNeeded === true) return { base: null, vatAmount: null,
    total: euros(base + vatAmount + additional), vatDeductibleAmount: null, vatReviewNeeded: true, ...additionalField };
  return { base: euros(base), vatAmount: euros(vatAmount), total: euros(base + vatAmount + additional),
    vatDeductibleAmount: euros(credit ? (deductible < vatAmount ? vatAmount : deductible) : (deductible > vatAmount ? vatAmount : deductible)),
    ...additionalField };
}

/** Document totals stay intact when credits/promotions change the bank amount. */
export function expenseCashAmount(expense) {
  return expense.cashAmount === undefined ? expenseTotals(expense).total : euros(cents(expense.cashAmount));
}

/** A receipt may have an advance and a later refund on separate real bank dates. */
export function expenseCashMovements(expense) {
  if (expense.paymentStatus !== 'paid') return [];
  const movements = expense.cashMovements ?? [{ date: expense.paidDate, amount: expenseCashAmount(expense) }];
  return movements.filter((entry) => validDate(entry.date)).map((entry) => ({ ...entry, expenseId: expense.id }));
}

/** Filing does not prove a bank payment. Linked supplier payments are counted once. */
export function taxCashMovements(record) {
  if (record.paymentStatus !== 'paid' || !validDate(record.paidDate) || !record.amount) return [];
  return [{ taxRecordId: record.id, date: record.paidDate, amount: record.amount }];
}

/** A convenience for manual entry; callers may replace this with the VAT printed on a receipt. */
export function suggestedExpenseVAT(base, rate = 21) {
  const baseCents = positiveCents(base), rateHundredths = positiveCents(rate);
  const denominator = 10000n;
  return euros((baseCents * rateHundredths + denominator / 2n) / denominator);
}

/** Enter a receipt's gross total first, then split it using the selected single VAT rate. */
export function splitExpenseTotal(total, vatRate = 21) {
  requireDecimal(total); requireDecimal(vatRate);
  const totalCents = cents(total), rateHundredths = cents(vatRate);
  if (rateHundredths < 0n || rateHundredths > 10000n) throw new Error('Revisa el total y el porcentaje de IVA.');
  const denominator = 10000n + rateHundredths;
  const sign = totalCents < 0n ? -1n : 1n;
  const base = ((totalCents * sign * 10000n + denominator / 2n) / denominator) * sign;
  return { base: euros(base), vatAmount: euros(totalCents - base), total: euros(totalCents) };
}

/** Mixed rates and real printed rounding use the VAT amount from the source document. */
export function splitExpenseTotalManual(total, vatAmount) {
  requireDecimal(total); requireDecimal(vatAmount);
  const totalCents = cents(total), vatCents = cents(vatAmount);
  if (totalCents >= 0n ? vatCents < 0n || vatCents > totalCents : vatCents > 0n || vatCents < totalCents) {
    throw new Error('El IVA debe tener el signo del total y no superar su importe.');
  }
  return { base: euros(totalCents - vatCents), vatAmount: euros(vatCents), total: euros(totalCents) };
}

export function quarterRange(year, quarter) {
  const calendarYear = Number(year), period = Number(quarter);
  if (!Number.isInteger(calendarYear) || calendarYear < 1000 || calendarYear > 9999
      || !Number.isInteger(period) || period < 1 || period > 4) {
    throw new Error('Selecciona un año y un trimestre válidos.');
  }
  const startMonth = (period - 1) * 3 + 1, endMonth = period * 3;
  const from = `${calendarYear}-${String(startMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(calendarYear, endMonth, 0)).getUTCDate();
  const to = `${calendarYear}-${String(endMonth).padStart(2, '0')}-${lastDay}`;
  return { year: calendarYear, quarter: period, from, to };
}

function inRange(date, range) { return validDate(date) && date >= range.from && date <= range.to; }
function issuedInvoices(state) {
  return (state?.documents ?? []).filter((doc) => doc?.kind === 'invoice'
    && ['issued', 'partial', 'paid', 'overdue'].includes(doc.status));
}

/** All-history boundaries include payment dates as well as document dates. */
export function periodRange(state, period = {}) {
  if (period.type === 'quarter') {
    const range = quarterRange(period.year, period.quarter);
    return { type: 'quarter', ...range, label: `${range.quarter}.º trimestre de ${range.year}` };
  }
  if (period.type === 'year') {
    const year = Number(period.year);
    if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new Error('Selecciona un año válido.');
    return { type: 'year', year, from: `${year}-01-01`, to: `${year}-12-31`, label: `Año ${year}` };
  }
  if (period.type !== 'all') throw new Error('Selecciona trimestre, año o todo el histórico.');
  const invoices = issuedInvoices(state), invoiceIds = new Set(invoices.map((entry) => entry.id));
  const dates = [...invoices.map((entry) => entry.date), ...(state?.expenses ?? []).map((entry) => entry.date),
    ...(state?.payments ?? []).filter((entry) => invoiceIds.has(entry.documentId)).map((entry) => entry.date),
    ...(state?.expenses ?? []).flatMap(expenseCashMovements).map((entry) => entry.date),
    ...(state?.taxRecords ?? []).map((entry) => entry.date),
    ...(state?.taxRecords ?? []).flatMap(taxCashMovements).map((entry) => entry.date)]
    .filter(validDate).sort();
  return { type: 'all', from: dates[0] ?? null, to: dates.at(-1) ?? null, label: 'Todo el histórico' };
}

/** Invoice/expense registers use issue dates; cash movements use payment dates separately. */
export function periodReport(state, period) {
  const range = periodRange(state, period), clientMap = new Map((state?.clients ?? []).map((client) => [client.id, client]));
  const allInvoices = issuedInvoices(state), invoiceIds = new Set(allInvoices.map((doc) => doc.id));
  const invoices = allInvoices.filter((doc) => inRange(doc.date, range)).map((doc) => ({
    ...doc, client: doc.clientSnapshot ?? clientMap.get(doc.clientId) ?? { name: '' }, amounts: totals(doc),
  }));
  const expenses = (state?.expenses ?? []).filter((expense) => inRange(expense.date, range))
    .map((expense) => ({ ...expense, amounts: expenseTotals(expense) }));
  const taxRecords = (state?.taxRecords ?? []).filter((record) => range.type === 'all'
    || (record.year === range.year && (range.type !== 'quarter' || record.quarter === range.quarter)));
  const payments = (state?.payments ?? []).filter((payment) => invoiceIds.has(payment.documentId) && inRange(payment.date, range));
  const expensePayments = (state?.expenses ?? []).flatMap(expenseCashMovements).filter((entry) => inRange(entry.date, range));
  const taxPayments = (state?.taxRecords ?? []).flatMap(taxCashMovements).filter((entry) => inRange(entry.date, range));
  const paidExpenseIds = new Set(expensePayments.map((entry) => entry.expenseId));
  const paidExpenses = (state?.expenses ?? []).filter((expense) => paidExpenseIds.has(expense.id));
  const sum = (records, value) => euros(records.reduce((total, record) => total + cents(value(record)), 0n));
  const knownVATExpenses = expenses.filter((entry) => entry.vatReviewNeeded !== true);
  const vatReviewExpenses = expenses.filter((entry) => entry.vatReviewNeeded === true);
  const summary = {
    invoiceCount: invoices.length, expenseCount: expenses.length,
    salesBase: sum(invoices, (entry) => entry.amounts.base), outputVAT: sum(invoices, (entry) => entry.amounts.vatAmount),
    salesWithholding: sum(invoices, (entry) => entry.amounts.withholdingAmount), salesTotal: sum(invoices, (entry) => entry.amounts.total),
    expenseBase: sum(knownVATExpenses, (entry) => entry.amounts.base), inputVATRecorded: sum(knownVATExpenses, (entry) => entry.amounts.vatAmount),
    inputVATConfirmed: sum(knownVATExpenses, (entry) => entry.amounts.vatDeductibleAmount), expenseTotal: sum(expenses, (entry) => entry.amounts.total),
    additionalTotal: sum(expenses, (entry) => entry.amounts.additionalAmount ?? 0),
    cashReceived: sum(payments, (entry) => entry.amount), cashPaidExpenses: sum(expensePayments, (entry) => entry.amount),
    cashPaidTaxes: sum(taxPayments, (entry) => entry.amount),
    cashPaid: sum([...expensePayments, ...taxPayments], (entry) => entry.amount),
    taxRecordCount: taxRecords.length, taxDeclaredTotal: sum(taxRecords, (entry) => entry.amount),
    taxUnconfirmedCount: taxRecords.filter((entry) => entry.paymentStatus === 'unconfirmed').length,
    taxAttachmentsCount: taxRecords.reduce((total, entry) => total + (entry.attachments?.length ?? 0), 0),
    reviewCount: invoices.filter((entry) => entry.reviewRequired || entry.paymentReviewNeeded).length
      + expenses.filter(expenseNeedsReview).length,
    vatReviewCount: vatReviewExpenses.length,
    vatReviewTotal: sum(vatReviewExpenses, (entry) => entry.amounts.total),
    vatUndisclosedCount: vatReviewExpenses.filter(entry => Boolean(entry.vatDocumentStatus)).length,
    attachmentsCount: expenses.reduce((total, entry) => total + (entry.attachments?.length ?? 0), 0),
    creditCount: expenses.filter((entry) => entry.kind === 'credit').length,
  };
  // A registered operating comparison, before invoice withholding. Unknown VAT
  // would overstate costs if its provisional gross amount were treated as a base.
  summary.activityDifference = vatReviewExpenses.length ? null : euros(cents(summary.salesBase) - cents(summary.expenseBase));
  return { ...range, invoices, expenses, taxRecords, payments, paidExpenses, expensePayments, taxPayments, summary };
}

export function quarterlyReport(state, year, quarter) {
  return periodReport(state, { type: 'quarter', year, quarter });
}

/** An opening balance is the balance at the beginning of that day, before its movements. */
export function cashSummary(state, asOf = todayISO()) {
  if (!validDate(asOf)) throw new Error('La fecha del saldo no es válida.');
  const company = state?.company ?? {}, start = company.openingBalanceDate;
  const configured = typeof company.openingBalance === 'number' && Number.isFinite(company.openingBalance)
    && validDate(start) && start <= asOf;
  const lowerBound = configured ? start : '0000-01-01';
  const inCashWindow = (date) => validDate(date) && date >= lowerBound && date <= asOf;
  const invoices = issuedInvoices(state), invoiceIds = new Set(invoices.map((entry) => entry.id));
  const allPayments = (state?.payments ?? []).filter((payment) => invoiceIds.has(payment.documentId) && validDate(payment.date) && payment.date <= asOf);
  const receivedCents = allPayments.filter((payment) => inCashWindow(payment.date)).reduce((sum, payment) => sum + positiveCents(payment.amount), 0n);
  const paidCents = (state?.expenses ?? []).flatMap(expenseCashMovements).filter((entry) => inCashWindow(entry.date))
    .reduce((sum, entry) => sum + cents(entry.amount), 0n);
  const taxPaidCents = (state?.taxRecords ?? []).flatMap(taxCashMovements).filter((entry) => inCashWindow(entry.date))
    .reduce((sum, entry) => sum + cents(entry.amount), 0n);
  const pendingInvoices = invoices.filter((invoice) => invoice.date <= asOf && invoice.paymentReviewNeeded !== true);
  const pendingReceivablesCents = pendingInvoices.reduce((sum, invoice) => sum + cents(outstanding(invoice, allPayments)), 0n);
  const pendingExpensesCents = (state?.expenses ?? []).filter((expense) => expense.date <= asOf)
    .reduce((sum, expense) => sum + (expense.paymentStatus === 'pending' ? cents(expenseCashAmount(expense))
      : expenseCashMovements(expense).filter((entry) => entry.date > asOf).reduce((remaining, entry) => remaining + cents(entry.amount), 0n)), 0n);
  const openingCents = configured ? cents(company.openingBalance) : 0n;
  const pendingTaxCents = (state?.taxRecords ?? []).filter((record) => record.date <= asOf)
    .reduce((sum, record) => sum + (record.paymentStatus === 'pending' ? positiveCents(record.amount)
      : taxCashMovements(record).filter(entry => entry.date > asOf).reduce((future, entry) => future + cents(entry.amount), 0n)), 0n);
  const balanceCents = openingCents + receivedCents - paidCents - taxPaidCents;
  return { asOf, configured, openingBalance: configured ? euros(openingCents) : null,
    openingBalanceDate: configured ? start : null, received: euros(receivedCents), paidExpenses: euros(paidCents), paidTaxes: euros(taxPaidCents),
    netMovement: euros(receivedCents - paidCents - taxPaidCents), balance: configured ? euros(balanceCents) : null,
    pendingReceivables: euros(pendingReceivablesCents), pendingExpenses: euros(pendingExpensesCents), pendingTaxes: euros(pendingTaxCents),
    forecastBalance: configured ? euros(balanceCents + pendingReceivablesCents - pendingExpensesCents - pendingTaxCents) : null,
    unconfirmedInvoices: invoices.filter((invoice) => invoice.date <= asOf && invoice.paymentReviewNeeded === true).length,
  };
}

function safeCSV(value) {
  let text = String(value ?? '');
  // Spreadsheets can evaluate formulas even inside quoted CSV cells. Treat user text as text.
  if (/^[\s\u0000-\u001f\u007f\uFEFF]*[=+@-]/u.test(text) || /^[\u0000-\u001f\u007f]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function decimalCSV(value) { return Number(value ?? 0).toFixed(2).replace('.', ','); }

/** One CSV for the gestor, with receipts and issued invoices; totals do not constitute a tax return. */
export function reportCSV(state, period) {
  const report = periodReport(state, period);
  const headers = ['Tipo', 'Fecha documento', 'Número / referencia', 'Cliente / proveedor', 'NIF', 'Concepto',
    'Base (€)', 'IVA (€)', 'Retención (€)', 'Total (€)', 'IVA soportado confirmado (€)', 'Estado pago actual',
    'Fecha pago gasto', 'Notas', 'Justificantes', 'Revisión pendiente', 'Estado IVA', 'Suplidos / otros importes sin IVA (€)',
    'Importe de caja del registro (€)', 'Movimientos de caja del registro', 'Motivo de falta de justificante',
    'Modelo fiscal', 'Ejercicio fiscal', 'Trimestre fiscal'];
  const rows = report.invoices.map((invoice) => ['Factura emitida', invoice.date, invoice.number,
    invoice.client.name, invoice.client.taxId ?? '', invoice.title || invoice.items.map((entry) => entry.description).join(' | '),
    decimalCSV(invoice.amounts.base), decimalCSV(invoice.amounts.vatAmount), decimalCSV(invoice.amounts.withholdingAmount),
    decimalCSV(invoice.amounts.total), '', ({ review: 'Por confirmar', paid: 'Cobrado', partial: 'Cobro parcial',
      overdue: 'Vencido', issued: 'Pendiente' })[status(invoice, state.payments)] ?? invoice.status, '',
    invoice.notes ?? '', '', invoice.reviewRequired || invoice.paymentReviewNeeded ? 'Sí' : 'No', 'Registrado', '', '', '', '', '', '', '']);
  rows.push(...report.expenses.map((expense) => [expense.kind === 'credit' ? 'Abono de proveedor' : 'Gasto recibido', expense.date, expense.reference ?? '', expense.supplier ?? '',
    expense.supplierTaxId ?? '', expense.description,
    expense.vatReviewNeeded ? '' : decimalCSV(expense.amounts.base), expense.vatReviewNeeded ? '' : decimalCSV(expense.amounts.vatAmount), '0,00',
    decimalCSV(expense.amounts.total), expense.vatReviewNeeded ? '' : decimalCSV(expense.amounts.vatDeductibleAmount),
    expense.kind === 'credit' ? (expense.paymentStatus === 'paid' ? 'Reembolsado' : 'Reembolso pendiente')
      : (expense.paymentStatus === 'paid' ? 'Pagado' : 'Pendiente'), expense.paidDate ?? '', expense.notes ?? '',
    (expense.attachments ?? []).map((attachment) => attachment.name).join(' | '), expenseNeedsReview(expense) ? 'Sí' : 'No',
    expenseVATLabel(expense), decimalCSV(expense.amounts.additionalAmount ?? 0),
    decimalCSV(expenseCashAmount(expense)), expenseCashMovements(expense).map((entry) =>
      `${entry.date}: ${decimalCSV(entry.amount)}${entry.reference ? ` (${entry.reference})` : ''}`).join(' | '), expense.missingReceiptReason ?? '', '', '', '']));
  rows.push(...report.taxRecords.map((record) => ['Declaración fiscal', record.date, record.reference ?? '', 'Agencia Tributaria', '',
    `Modelo ${record.model} · ${record.year} T${record.quarter}`, '', '', '', decimalCSV(record.amount), '',
    ({ 'no-payment': 'Sin ingreso: resultado cero', unconfirmed: 'Pago por confirmar', pending: 'Pendiente de pago',
      paid: record.amount < 0 ? 'Devolución cobrada' : 'Pagado', included: 'Incluido en otro gasto' })[record.paymentStatus],
    record.paidDate ?? '', [record.notes, record.linkedExpenseId ? `Pago incluido en gasto ${record.linkedExpenseId}` : ''].filter(Boolean).join(' | '),
    (record.attachments ?? []).map(attachment => attachment.name).join(' | '), record.paymentStatus === 'unconfirmed' ? 'Sí' : 'No',
    'Declaración fiscal · fuera del IVA de gastos', '', decimalCSV(record.paymentStatus === 'paid' ? record.amount : 0),
    taxCashMovements(record).map(entry => `${entry.date}: ${decimalCSV(entry.amount)}`).join(' | '), '', record.model, record.year, record.quarter]));
  return '\uFEFF' + [headers, ...rows].map((row) => row.map(safeCSV).join(';')).join('\r\n') + '\r\n';
}

export function quarterCSV(state, year, quarter) {
  return reportCSV(state, { type: 'quarter', year, quarter });
}
