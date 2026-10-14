import './financial-summary.css';
import { money, escapeHTML as esc } from './domain.js';

/** Documents and cash remain separate: filing an invoice is not a bank movement. */
export function renderFinancialTotals(report, activity, { overview = false } = {}) {
  const s = report.summary, t = activity.totals;
  const refunds = Number((t.expenseRefunds + t.taxRefunds).toFixed(2));
  const netPaid = Number((t.outflows - refunds).toFixed(2));
  return `<section class="${overview ? 'card financial-overview' : 'financial-overview'}" aria-label="Totales de documentos y dinero">
    ${overview ? `<div class="card-header"><div><h2>Los totales de tu empresa</h2><p>Todo el histórico registrado</p></div><a class="text-button" href="#informes?periodo=all">Ver el histórico</a></div>` : ''}
    <div class="financial-totals">
      <div><span>Total facturado</span><strong>${money(s.salesTotal)}</strong><small>${s.invoiceCount} facturas emitidas · importe final</small></div>
      <div><span>Gastos de proveedores</span><strong>${money(s.expenseTotal)}</strong><small>${s.expenseCount} registros · neto de abonos</small></div>
      <div><span>Cobros de facturas</span><strong>${money(t.receivedInvoices)}</strong><small>Por la fecha en que recibiste el dinero</small></div>
      <div class="financial-outflows"><span>Salidas de dinero</span><strong>${money(t.outflows)}</strong><small>Pagos de gastos e impuestos, antes de devoluciones</small></div>
    </div>
    <div class="financial-cash-bridge" aria-label="Desglose de salidas y devoluciones">
      <div><span>Pagos de gastos</span><strong>${money(t.paidExpenses)}</strong></div>
      <span class="financial-symbol" aria-hidden="true">+</span><div><span>Pagos de impuestos</span><strong>${money(t.paidTaxes)}</strong></div>
      <span class="financial-symbol" aria-hidden="true">−</span><div><span>Devoluciones recibidas</span><strong>${money(refunds)}</strong></div>
      <span class="financial-symbol" aria-hidden="true">=</span><div class="financial-net"><span>Salida neta de dinero</span><strong>${money(netPaid)}</strong></div>
    </div>
    <p class="financial-explanation">Las facturas y los gastos se agrupan por fecha del documento. Los cobros, pagos y devoluciones usan la fecha del movimiento. Los gastos muestran su importe total, con el IVA registrado, y restan los abonos; los impuestos pagados se muestran aparte.${overview ? '' : ` ${esc(report.label)} usa el mismo período para ambos criterios.`}</p>
  </section>`;
}
