import { outstanding, status, totals, todayISO } from './domain.js';

const MAX_MONEY_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

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
  const base = positiveCents(expense.base), vatAmount = positiveCents(expense.vatAmount);
  const deductible = positiveCents(expense.vatDeductibleAmount ?? 0);
  return { base: euros(base), vatAmount: euros(vatAmount), total: euros(base + vatAmount),
    vatDeductibleAmount: euros(deductible > vatAmount ? vatAmount : deductible) };
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
  if (totalCents < 0n || rateHundredths < 0n || rateHundredths > 10000n) throw new Error('Revisa el total y el porcentaje de IVA.');
  const denominator = 10000n + rateHundredths;
  const base = (totalCents * 10000n + denominator / 2n) / denominator;
  return { base: euros(base), vatAmount: euros(totalCents - base), total: euros(totalCents) };
}

/** Mixed rates and real printed rounding use the VAT amount from the source document. */
export function splitExpenseTotalManual(total, vatAmount) {
  requireDecimal(total); requireDecimal(vatAmount);
  const totalCents = cents(total), vatCents = cents(vatAmount);
  if (totalCents < 0n || vatCents < 0n || vatCents > totalCents) throw new Error('El IVA debe estar entre cero y el total del justificante.');
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

/** Invoice/expense registers use issue dates; cash movements use payment dates separately. */
export function quarterlyReport(state, year, quarter) {
  const range = quarterRange(year, quarter), clientMap = new Map((state?.clients ?? []).map((client) => [client.id, client]));
  const allInvoices = issuedInvoices(state), invoiceIds = new Set(allInvoices.map((doc) => doc.id));
  const invoices = allInvoices.filter((doc) => inRange(doc.date, range)).map((doc) => ({
    ...doc, client: doc.clientSnapshot ?? clientMap.get(doc.clientId) ?? { name: '' }, amounts: totals(doc),
  }));
  const expenses = (state?.expenses ?? []).filter((expense) => inRange(expense.date, range))
    .map((expense) => ({ ...expense, amounts: expenseTotals(expense) }));
  const payments = (state?.payments ?? []).filter((payment) => invoiceIds.has(payment.documentId) && inRange(payment.date, range));
  const paidExpenses = (state?.expenses ?? []).filter((expense) => expense.paymentStatus === 'paid' && inRange(expense.paidDate, range));
  const sum = (records, value) => euros(records.reduce((total, record) => total + cents(value(record)), 0n));
  const summary = {
    invoiceCount: invoices.length, expenseCount: expenses.length,
    salesBase: sum(invoices, (entry) => entry.amounts.base), outputVAT: sum(invoices, (entry) => entry.amounts.vatAmount),
    salesWithholding: sum(invoices, (entry) => entry.amounts.withholdingAmount), salesTotal: sum(invoices, (entry) => entry.amounts.total),
    expenseBase: sum(expenses, (entry) => entry.amounts.base), inputVATRecorded: sum(expenses, (entry) => entry.amounts.vatAmount),
    inputVATConfirmed: sum(expenses, (entry) => entry.amounts.vatDeductibleAmount), expenseTotal: sum(expenses, (entry) => entry.amounts.total),
    cashReceived: sum(payments, (entry) => entry.amount), cashPaid: sum(paidExpenses, (entry) => expenseTotals(entry).total),
    reviewCount: invoices.filter((entry) => entry.reviewRequired || entry.paymentReviewNeeded).length
      + expenses.filter((entry) => entry.reviewNeeded).length,
    attachmentsCount: expenses.reduce((total, entry) => total + (entry.attachments?.length ?? 0), 0),
  };
  return { ...range, invoices, expenses, payments, paidExpenses, summary };
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
  const paidCents = (state?.expenses ?? []).filter((expense) => expense.paymentStatus === 'paid' && inCashWindow(expense.paidDate))
    .reduce((sum, expense) => sum + cents(expenseTotals(expense).total), 0n);
  const pendingInvoices = invoices.filter((invoice) => invoice.date <= asOf && invoice.paymentReviewNeeded !== true);
  const pendingReceivablesCents = pendingInvoices.reduce((sum, invoice) => sum + cents(outstanding(invoice, allPayments)), 0n);
  const pendingExpensesCents = (state?.expenses ?? []).filter((expense) => expense.date <= asOf
    && (expense.paymentStatus === 'pending' || (expense.paymentStatus === 'paid' && expense.paidDate > asOf)))
    .reduce((sum, expense) => sum + cents(expenseTotals(expense).total), 0n);
  const openingCents = configured ? cents(company.openingBalance) : 0n;
  const balanceCents = openingCents + receivedCents - paidCents;
  return { asOf, configured, openingBalance: configured ? euros(openingCents) : null,
    openingBalanceDate: configured ? start : null, received: euros(receivedCents), paidExpenses: euros(paidCents),
    netMovement: euros(receivedCents - paidCents), balance: configured ? euros(balanceCents) : null,
    pendingReceivables: euros(pendingReceivablesCents), pendingExpenses: euros(pendingExpensesCents),
    forecastBalance: configured ? euros(balanceCents + pendingReceivablesCents - pendingExpensesCents) : null,
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
export function quarterCSV(state, year, quarter) {
  const report = quarterlyReport(state, year, quarter);
  const headers = ['Tipo', 'Fecha documento', 'Número / referencia', 'Cliente / proveedor', 'NIF', 'Concepto',
    'Base (€)', 'IVA (€)', 'Retención (€)', 'Total (€)', 'IVA soportado confirmado (€)', 'Estado pago actual',
    'Fecha pago gasto', 'Notas', 'Justificantes', 'Revisión pendiente'];
  const rows = report.invoices.map((invoice) => ['Factura emitida', invoice.date, invoice.number,
    invoice.client.name, invoice.client.taxId ?? '', invoice.title || invoice.items.map((entry) => entry.description).join(' | '),
    decimalCSV(invoice.amounts.base), decimalCSV(invoice.amounts.vatAmount), decimalCSV(invoice.amounts.withholdingAmount),
    decimalCSV(invoice.amounts.total), '', ({ review: 'Por confirmar', paid: 'Cobrado', partial: 'Cobro parcial',
      overdue: 'Vencido', issued: 'Pendiente' })[status(invoice, state.payments)] ?? invoice.status, '',
    invoice.notes ?? '', '', invoice.reviewRequired || invoice.paymentReviewNeeded ? 'Sí' : 'No']);
  rows.push(...report.expenses.map((expense) => ['Gasto recibido', expense.date, expense.reference ?? '', expense.supplier,
    expense.supplierTaxId ?? '', expense.description, decimalCSV(expense.amounts.base), decimalCSV(expense.amounts.vatAmount), '0,00',
    decimalCSV(expense.amounts.total), decimalCSV(expense.amounts.vatDeductibleAmount),
    expense.paymentStatus === 'paid' ? 'Pagado' : 'Pendiente', expense.paidDate ?? '', expense.notes ?? '',
    (expense.attachments ?? []).map((attachment) => attachment.name).join(' | '), expense.reviewNeeded ? 'Sí' : 'No']));
  return '\uFEFF' + [headers, ...rows].map((row) => row.map(safeCSV).join(';')).join('\r\n') + '\r\n';
}
