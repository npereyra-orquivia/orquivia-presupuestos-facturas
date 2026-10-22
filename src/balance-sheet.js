import { totals } from './domain.js';
import { cashSummary, expenseCashAmount, expenseCashMovements } from './expenses.js';
import { statementCents as cents, statementEuros as euros, statementValidDate as validDate, statementRecords } from './profit-loss.js';

const ISSUED = new Set(['issued', 'paid', 'partial', 'overdue']);

/**
 * Known balance-sheet items, never a fabricated balanced accounting statement.
 * `bankBalance` may be an explicitly reconciled bank-statement value at asOf.
 * `adjustments` are documented report inputs {id,section,label,amount,source};
 * they are not inferred from the difference between assets and liabilities.
 */
export function balanceSheetReport(state, { asOf } = {}, { bankBalance, bankSource = '', capitalFundingPending = false, adjustments = [] } = {}) {
  if (!state || typeof state !== 'object' || !validDate(asOf)) throw new Error('Indica una fecha válida para el balance.');
  if (!Array.isArray(adjustments)) throw new Error('Los datos contables adicionales no son válidos.');
  const documents = statementRecords(state.documents, 'documentos'), expenses = statementRecords(state.expenses, 'gastos');
  const payments = statementRecords(state.payments, 'cobros'), taxRecords = statementRecords(state.taxRecords, 'declaraciones');
  const assets = [], liabilities = [], equity = [], missing = [], pending = [];
  const add = (collection, id, label, amount, source) => collection.push({ id, label, amount: euros(amount), source });
  const through = date => validDate(date) && date <= asOf;
  const withinCash = cashSummary({ ...state, documents, expenses, payments, taxRecords }, asOf);
  const bank = bankBalance === undefined || bankBalance === null ? withinCash.balance : euros(cents(bankBalance));
  if (bank === null) missing.push({ id: 'bank', label: 'Saldo bancario / caja al cierre sin conciliar', amount: null });
  else if (bank >= 0) add(assets, 'bank', 'Banco / caja según la fuente indicada', cents(bank), bankBalance === undefined || bankBalance === null ? 'Saldo inicial y movimientos registrados en la aplicación; pendiente de conciliación bancaria.' : bankSource || 'Saldo bancario aportado para este informe.');
  else add(liabilities, 'bank-overdraft', 'Saldo bancario acreedor / descubierto', -cents(bank), bankSource || 'Saldo según los registros; confirmar clasificación y conciliación.');
  if (bank !== null && (bankBalance === undefined || bankBalance === null)) pending.push({ id: 'bank-reconciliation', label: 'Conciliar el saldo calculado con el extracto bancario a la fecha del balance.', amount: bank });
  else if (bank !== null && withinCash.balance !== null && cents(bank) !== cents(withinCash.balance)) pending.push({ id: 'bank-difference', label: 'Diferencia entre el saldo del extracto aportado y el saldo calculado con los movimientos registrados; revisar la conciliación.', amount: euros(cents(bank) - cents(withinCash.balance)) });

  let receivables = 0n, payables = 0n, supplierRefunds = 0n;
  const invoiceNumbers = new Set();
  for (const invoice of documents) {
    if (invoice.kind !== 'invoice' || !ISSUED.has(invoice.status)) continue;
    if (!validDate(invoice.date)) throw new Error('Una factura emitida no tiene fecha válida.');
    if (!through(invoice.date)) continue;
    if (invoice.number && invoiceNumbers.has(invoice.number)) throw new Error('Hay dos facturas emitidas con el mismo número.');
    if (invoice.number) invoiceNumbers.add(invoice.number);
    const total = cents(totals(invoice).total);
    const collected = payments.filter(payment => payment.documentId === invoice.id && through(payment.date))
      .reduce((sum, payment) => sum + cents(payment.amount), 0n);
    if (collected < 0n) throw new Error('Un cobro registrado no puede ser negativo.');
    const outstanding = total > collected ? total - collected : 0n;
    receivables += outstanding;
    if (invoice.paymentReviewNeeded) pending.push({ id: `${invoice.id}:collection-review`, recordId: invoice.id, label: `Confirmar los cobros de ${invoice.number || 'una factura importada'}.`, amount: euros(outstanding) });
    if (collected > total) pending.push({ id: `${invoice.id}:overpayment`, recordId: invoice.id, label: `Clasificar el cobro superior al total de ${invoice.number || 'la factura'}.`, amount: euros(collected - total) });
  }
  add(assets, 'customers', 'Clientes pendientes de cobro', receivables, 'Facturas emitidas hasta el cierre, menos cobros registrados hasta esa fecha; importes finales con IVA y retenciones.');

  for (const expense of expenses) {
    if (!validDate(expense.date)) throw new Error('Un gasto no tiene fecha válida.');
    if (!through(expense.date)) continue;
    let remaining;
    if (expense.paymentStatus === 'pending') remaining = cents(expenseCashAmount(expense));
    else if (expense.paymentStatus === 'paid') {
      // Future instalments/refunds remain open at a historical closing date.
      remaining = expenseCashMovements(expense).filter(movement => movement.date > asOf)
        .reduce((sum, movement) => sum + cents(movement.amount), 0n);
      if (!validDate(expense.paidDate)) pending.push({ id: `${expense.id}:payment-date`, recordId: expense.id, label: `Revisar la fecha de pago de ${expense.description || 'un gasto'}.`, amount: expense.total });
    } else throw new Error('El estado de pago de un gasto no es válido.');
    if (remaining > 0n) payables += remaining;
    else if (remaining < 0n) supplierRefunds -= remaining;
  }
  add(liabilities, 'suppliers', 'Proveedores pendientes de pago', payables, 'Gastos registrados hasta el cierre, pendientes o con pagos posteriores; no incluye deudas que no se hayan registrado.');
  if (supplierRefunds) add(assets, 'supplier-refunds', 'Abonos / reembolsos de proveedores pendientes', supplierRefunds, 'Abonos o reembolsos registrados cuya devolución no se había cobrado al cierre.');

  const adjustmentIds = new Set();
  for (const adjustment of adjustments) {
    if (!adjustment || typeof adjustment.id !== 'string' || !adjustment.id.trim() || adjustmentIds.has(adjustment.id)
      || !['asset', 'liability', 'equity'].includes(adjustment.section) || typeof adjustment.label !== 'string' || !adjustment.label.trim()
      || typeof adjustment.source !== 'string' || !adjustment.source.trim()) throw new Error('Cada dato contable adicional necesita identificador, clasificación y fuente únicos.');
    adjustmentIds.add(adjustment.id);
    const collection = adjustment.section === 'asset' ? assets : adjustment.section === 'liability' ? liabilities : equity;
    const amount = cents(adjustment.amount);
    if (['declared-capital', 'declared-financing', 'capital-social', 'financial-debt'].includes(adjustment.id) && amount < 0n) throw new Error('El capital y la financiación declarados no pueden ser negativos.');
    add(collection, `manual:${adjustment.id}`, adjustment.label.trim(), amount, adjustment.source.trim());
  }
  const capitalDeclared = adjustmentIds.has('declared-capital') || adjustmentIds.has('capital-social');
  const financingDeclared = adjustmentIds.has('declared-financing') || adjustmentIds.has('financial-debt');
  if (capitalDeclared && capitalFundingPending) pending.push({ id: 'capital-funding', label: 'Acreditar el desembolso y la trazabilidad del capital declarado. Reservar parte de una venta no acredita una aportación adicional de la socia.', amount: null });
  missing.push(
    { id: 'fixed-assets', label: 'Inmovilizado y amortizaciones acumuladas', amount: null },
    { id: 'inventory', label: 'Existencias y otros activos no registrados', amount: null },
    { id: 'tax-balances', label: 'Saldos con Hacienda y Seguridad Social, incluido IVA pendiente', amount: null },
    ...(!financingDeclared ? [{ id: 'financing', label: 'Préstamos, financiación y otras deudas al cierre', amount: null }] : []),
    { id: 'equity', label: capitalDeclared
      ? 'Reservas y resultados de ejercicios anteriores; capital declarado por separado' : 'Capital, reservas y resultados de ejercicios anteriores', amount: null },
    { id: 'current-result', label: 'Resultado contable completo del ejercicio', amount: null },
    { id: 'accruals', label: 'Periodificaciones y demás ajustes de cierre del gestor', amount: null },
  );
  const total = collection => collection.reduce((sum, entry) => sum + cents(entry.amount), 0n);
  const knownAssets = total(assets), knownLiabilities = total(liabilities), recordedEquity = total(equity);
  const summary = { knownAssets: euros(knownAssets), knownLiabilities: euros(knownLiabilities), bankBalance: bank,
    receivables: euros(receivables), payables: euros(payables), supplierRefunds: euros(supplierRefunds),
    netAssetsKnown: euros(knownAssets - knownLiabilities), equity: equity.length ? euros(recordedEquity) : null,
    arithmeticDifference: equity.length ? euros(knownAssets - knownLiabilities - recordedEquity) : null,
    balanced: false, complete: false, pendingCount: missing.length + pending.length };
  return { title: 'Balance de situación', asOf, status: 'provisional', assets, liabilities, equity, missing, pending, summary,
    lines: [
      { id: 'known-assets', label: 'Activos identificados en los registros', amount: summary.knownAssets },
      { id: 'known-liabilities', label: 'Pasivos identificados en los registros', amount: summary.knownLiabilities },
      { id: 'recorded-equity', label: 'Patrimonio neto documentado para el informe', amount: summary.equity },
      { id: 'complete-balance', label: 'Balance contable completo', amount: null },
    ],
    limitations: [
      'Estado provisional e incompleto. Los activos y pasivos identificados no constituyen el balance contable completo de la sociedad.',
      'El saldo bancario y los movimientos de caja no permiten deducir el capital, las reservas, el beneficio ni el importe pendiente de los préstamos.',
      'La diferencia entre activos y pasivos conocidos no se ha presentado como patrimonio neto ni se ha utilizado para forzar que el balance cuadre.',
      'Faltan datos contables y ajustes de cierre que debe aportar o revisar el gestor. Un valor no disponible no equivale a cero.',
    ] };
}
