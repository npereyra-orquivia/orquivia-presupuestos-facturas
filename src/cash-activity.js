import { periodReport } from './expenses.js';

const MONEY_FIELDS = ['receivedInvoices', 'expenseRefunds', 'taxRefunds', 'inflows',
  'paidExpenses', 'paidTaxes', 'outflows', 'net'];
const CATEGORY_LABELS = new Map([
  ['Servicios', 'Servicios profesionales'], ['Material', 'Material y equipos'],
  ['Transporte', 'Transporte'], ['Suministros', 'Suministros'],
  ['Comidas', 'Comidas y dietas'], ['Otros', 'Otros gastos'],
]);
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

// Keep source decimal amounts in cents until the final display values are built.
function cents(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) return 0n;
  const source = String(value).trim().replace(',', '.');
  if (source.length > 1000) return 0n;
  const match = source.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match || (!match[2] && !match[3])) return 0n;
  const exponent = Number(match[4] || 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 400) return 0n;
  let amount = BigInt(`${match[2] || ''}${match[3] || ''}` || '0');
  const scale = (match[3] || '').length - exponent - 2;
  if (scale > 0) {
    const denominator = 10n ** BigInt(scale);
    amount = (amount + denominator / 2n) / denominator;
  } else amount *= 10n ** BigInt(-scale);
  return match[1] === '-' ? -amount : amount;
}

function euros(amount) {
  if (amount > MAX_CENTS || amount < -MAX_CENTS) throw new Error('La suma supera el límite de importe permitido.');
  return Number(amount) / 100;
}

function accumulator() {
  return { ...Object.fromEntries(MONEY_FIELDS.map(field => [field, 0n])), categories: new Map() };
}

function categoryName(expense) {
  const value = typeof expense?.category === 'string' ? expense.category.trim() : '';
  return CATEGORY_LABELS.get(value) || value || 'Otros gastos';
}

function displayedCategories(categories) {
  return [...categories].sort(([nameA, amountA], [nameB, amountB]) => amountA === amountB
    ? nameA.localeCompare(nameB, 'es') : amountA > amountB ? -1 : 1)
    .map(([name, amount]) => ({ name, amount: euros(amount) }));
}

function displayedAmounts(entry) {
  return Object.fromEntries(MONEY_FIELDS.map(field => [field, euros(entry[field])]));
}

function monthIndex(date) { return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1; }
function monthKey(index) { return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`; }

/**
 * Real cash activity, independent of the opening balance and document VAT review.
 * All returned amounts are euros. Receipts/refunds and gross outgoing payments are
 * positive; net = inflows - outflows. Categories contain outgoing supplier cash
 * only, so refunds and separately paid taxes never erase or inflate a category.
 * The report supplies payment-date boundaries and the validated movement helpers.
 * Gaps are filled through 120 months; wider histories contain active months only.
 */
export function monthlyCashActivity(state, period) {
  const report = periodReport(state, period);
  const range = { from: report.from, to: report.to, label: report.label };
  const months = new Map(), total = accumulator();
  const expenses = new Map((state?.expenses ?? []).map(expense => [expense.id, expense]));
  const monthFor = date => {
    const key = date.slice(0, 7);
    if (!months.has(key)) months.set(key, accumulator());
    return months.get(key);
  };
  const add = (date, field, amount, category) => {
    if (amount <= 0n) return;
    const month = monthFor(date);
    for (const entry of [month, total]) {
      entry[field] += amount;
      if (category) entry.categories.set(category, (entry.categories.get(category) || 0n) + amount);
    }
  };

  // periodReport already excludes drafts/quotes and uses real payment dates.
  for (const payment of report.payments) add(payment.date, 'receivedInvoices', cents(payment.amount));
  // expensePayments comes from expenseCashMovements: advances, bank adjustments
  // and refunds retain their own dates rather than the receipt's issue date.
  for (const movement of report.expensePayments) {
    const amount = cents(movement.amount);
    if (amount < 0n) add(movement.date, 'expenseRefunds', -amount);
    else add(movement.date, 'paidExpenses', amount, categoryName(expenses.get(movement.expenseId)));
  }
  // taxPayments comes from taxCashMovements, excluding unconfirmed, pending,
  // zero and supplier-included declarations to avoid counting a payment twice.
  for (const movement of report.taxPayments) {
    const amount = cents(movement.amount);
    add(movement.date, amount < 0n ? 'taxRefunds' : 'paidTaxes', amount < 0n ? -amount : amount);
  }

  if (range.from && range.to) {
    const first = monthIndex(range.from), last = monthIndex(range.to);
    if (last - first < 120) for (let index = first; index <= last; index++) {
      const key = monthKey(index);
      if (!months.has(key)) months.set(key, accumulator());
    }
  }
  for (const entry of [...months.values(), total]) {
    entry.inflows = entry.receivedInvoices + entry.expenseRefunds + entry.taxRefunds;
    entry.outflows = entry.paidExpenses + entry.paidTaxes;
    entry.net = entry.inflows - entry.outflows;
  }
  return {
    range,
    months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, entry]) => ({
      month, ...displayedAmounts(entry), categories: displayedCategories(entry.categories),
    })),
    totals: displayedAmounts(total),
    categories: displayedCategories(total.categories),
  };
}
