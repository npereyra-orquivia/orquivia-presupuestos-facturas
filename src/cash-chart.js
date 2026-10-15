import './cash-chart.css';
import { money, formatNumber, escapeHTML as esc } from './domain.js';

const COST_COLORS = ['#b8624f', '#c97e5b', '#a76f7a', '#d8a171', '#967687', '#be8e83', '#a58d67'];
const CUSTOMER_COLOR = '#285d48';
const REFUND_COLOR = '#8bad83';
const TAX_COLOR = '#b59748';
const monthFormatter = new Intl.DateTimeFormat('es-ES', { month: 'short', timeZone: 'UTC' });
const longMonthFormatter = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const numberFormatter = { format: amount => formatNumber(amount, { maximumFractionDigits: 0 }) };
const value = amount => Number.isFinite(Number(amount)) ? Math.max(0, Number(amount)) : 0;

function monthLabel(month, full = false) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) return String(month ?? '');
  const date = new Date(`${month}-15T12:00:00Z`);
  return (full ? longMonthFormatter : monthFormatter).format(date).replace(/\.$/, '');
}

function axisLimit(maximum) {
  if (maximum <= 0) return 100;
  const power = 10 ** Math.floor(Math.log10(maximum));
  const normalized = maximum / power;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * power;
}

function monthDescription(month) {
  const refunds = value(month.expenseRefunds) + value(month.taxRefunds);
  const categories = (month.categories || []).filter(category => value(category.amount) > 0).map(category => `${category.name}: ${money(category.amount)}`).join('; ');
  return `${monthLabel(month.month, true)}. Cobros de clientes: ${money(month.receivedInvoices)}. Devoluciones recibidas: ${money(refunds)}. Pagos de gastos: ${money(month.paidExpenses)}.${categories ? ` Por categoría: ${categories}.` : ''} Impuestos pagados: ${money(month.paidTaxes)}. Salidas totales: ${money(month.outflows)}. Diferencia: ${money(month.net)}.`;
}

function plotMarkup(months, colors, compact) {
  const limit = axisLimit(Math.max(...months.flatMap(month => [value(month.inflows), value(month.outflows)]), 0));
  const halfHeight = compact ? 145 : 170;
  const top = 15;
  const zero = top + halfHeight;
  const bottom = zero + halfHeight;
  const height = bottom + 66;
  const columnWidth = months.length <= 12 ? 66 : 58;
  const width = Math.max(compact ? 460 : 600, months.length * columnWidth + 20);
  const step = width / months.length;
  const barWidth = Math.min(months.length <= 3 ? 82 : 36, step * .5);
  const ticks = [limit, limit / 2, 0, -limit / 2, -limit];
  const position = amount => zero - amount / limit * halfHeight;
  const axis = `<svg class="cash-activity-axis" viewBox="0 0 78 ${height}" preserveAspectRatio="none" aria-hidden="true">${ticks.map(tick => `<text x="70" y="${position(tick) + 4}" text-anchor="end" class="${tick === 0 ? 'is-zero' : ''}">${tick < 0 ? '−' : ''}${numberFormatter.format(Math.abs(tick))} €</text>`).join('')}</svg>`;
  const grids = ticks.map(tick => `<line x1="0" x2="${width}" y1="${position(tick)}" y2="${position(tick)}" class="cash-activity-grid ${tick === 0 ? 'is-zero' : ''}" />`).join('');
  const labels = [];
  const columns = months.map((month, index) => {
    const x = (index + .5) * step;
    const barX = x - barWidth / 2;
    let positive = 0;
    let negative = 0;
    const inflows = [
      { amount: value(month.receivedInvoices), color: CUSTOMER_COLOR },
      { amount: value(month.expenseRefunds) + value(month.taxRefunds), color: REFUND_COLOR },
    ];
    const outflows = (month.categories || []).map(category => ({ amount: value(category.amount), color: colors.get(String(category.name)) || COST_COLORS[0] }));
    outflows.push({ amount: value(month.paidTaxes), color: TAX_COLOR });
    const above = inflows.filter(segment => segment.amount > 0).map(segment => {
      const segmentHeight = segment.amount / limit * halfHeight;
      positive += segmentHeight;
      return `<rect x="${barX}" y="${zero - positive}" width="${barWidth}" height="${segmentHeight}" fill="${segment.color}" />`;
    }).join('');
    const below = outflows.filter(segment => segment.amount > 0).map(segment => {
      const segmentHeight = segment.amount / limit * halfHeight;
      const y = zero + negative;
      negative += segmentHeight;
      return `<rect x="${barX}" y="${y}" width="${barWidth}" height="${segmentHeight}" fill="${segment.color}" />`;
    }).join('');
    const year = String(month.month ?? '').slice(0, 4);
    const showYear = index === 0 || year !== String(months[index - 1]?.month ?? '').slice(0, 4);
    const left = (index + .5) / months.length * 100;
    // HTML labels keep their font size when the SVG bars adapt to a small screen.
    labels.push(`${value(month.inflows) ? `<span class="cash-activity-value is-income" style="left:${left}%;top:${Math.max(0, zero - positive - 18)}px">${money(month.inflows)}</span>` : ''}${value(month.outflows) ? `<span class="cash-activity-value is-cost" style="left:${left}%;top:${zero + negative + 6}px">${money(month.outflows)}</span>` : ''}<span class="cash-activity-month-label" style="left:${left}%;top:${bottom + 30}px">${esc(monthLabel(month.month))}</span>${showYear ? `<span class="cash-activity-year-label" style="left:${left}%;top:${bottom + 46}px">${esc(year)}</span>` : ''}`);
    return `<g class="cash-activity-month" tabindex="0" role="img" aria-label="${esc(monthDescription(month))}"><title>${esc(monthDescription(month))}</title><rect class="cash-activity-hit" x="${index * step + 3}" y="${top}" width="${step - 6}" height="${halfHeight * 2}" rx="6" />${above}${below}</g>`;
  }).join('');
  return `<div class="cash-activity-chart" style="--cash-plot-height:${height}px"><div class="cash-activity-side">${axis}</div><div class="cash-activity-scroll" tabindex="0" role="region" aria-label="Gráfico mensual: desplázate horizontalmente si no caben todos los meses"><div class="cash-activity-surface" style="--cash-plot-width:${width}px;--cash-mobile-width:${Math.max(220, months.length * 72)}px"><svg class="cash-activity-plot" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Cobros y salidas de dinero por mes">${grids}${columns}</svg><div class="cash-activity-labels" aria-hidden="true">${labels.join('')}</div></div></div></div>`;
}

function percentageShare(amount, total) {
  const percent = total > 0 ? amount / total * 100 : 0;
  if (percent > 0 && percent < .1) return '&lt;0,1';
  return percent > 0 && percent < 1 ? percent.toFixed(1).replace('.', ',') : String(Math.round(percent));
}

function breakdownMarkup(activity, colors) {
  const totals = activity.totals || {};
  const categories = (activity.categories || []).filter(category => value(category.amount) > 0).map(category => ({ name: String(category.name), amount: value(category.amount), color: colors.get(String(category.name)) || COST_COLORS[0] }));
  if (value(totals.paidTaxes)) categories.push({ name: 'Impuestos pagados', amount: value(totals.paidTaxes), color: TAX_COLOR });
  categories.sort((a, b) => b.amount - a.amount);
  if (!categories.length) return '<p class="cash-activity-no-cost">No hay salidas de dinero registradas en este período.</p>';
  const total = value(totals.outflows);
  const largest = Math.max(...categories.map(category => category.amount), 1);
  return `<div class="cash-activity-costs"><div class="cash-activity-cost-heading"><h3>En qué se ha gastado</h3><span>Salidas brutas · IVA incluido</span></div><ul>${categories.map(category => `<li><div class="cash-activity-cost-label"><span><i style="--cash-color:${category.color}" aria-hidden="true"></i>${esc(category.name)}</span><strong>${money(category.amount)}<small>${percentageShare(category.amount, total)} %</small></strong></div><div class="cash-activity-cost-track" aria-hidden="true"><span style="width:${Math.min(100, category.amount / largest * 100)}%;--cash-color:${category.color}"></span></div></li>`).join('')}</ul></div>`;
}

function dataTableMarkup(months) {
  return `<details class="cash-activity-data"><summary>Ver datos por mes</summary><div class="cash-activity-table-wrap" tabindex="0" role="region" aria-label="Datos de movimientos por mes"><table><caption class="visually-hidden">Cobros, devoluciones y salidas según la fecha del movimiento</caption><thead><tr><th scope="col">Mes</th><th scope="col">Cobros de clientes</th><th scope="col">Devoluciones</th><th scope="col">Pagos de gastos</th><th scope="col">Impuestos</th><th scope="col">Salidas totales</th><th scope="col">Diferencia</th></tr></thead><tbody>${months.map(month => `<tr><th scope="row">${esc(monthLabel(month.month, true))}</th><td>${money(month.receivedInvoices)}</td><td>${money(value(month.expenseRefunds) + value(month.taxRefunds))}</td><td>${money(month.paidExpenses)}</td><td>${money(month.paidTaxes)}</td><td>${money(month.outflows)}</td><td class="${Number(month.net) < 0 ? 'is-negative' : 'is-positive'}">${money(month.net)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

/** Render the cash basis supplied by monthlyCashActivity; invoices are shown only once collected. */
export function renderCashActivityChart(activity = {}, { compact = false, showTotals = true } = {}) {
  const months = Array.isArray(activity.months) ? activity.months : [];
  const categories = Array.isArray(activity.categories) ? activity.categories : [];
  const totals = activity.totals || {};
  const colors = new Map(categories.map((category, index) => [String(category.name), COST_COLORS[index % COST_COLORS.length]]));
  const refunds = value(totals.expenseRefunds) + value(totals.taxRefunds);
  const hasMovements = months.some(month => value(month.inflows) || value(month.outflows));
  const totalsMarkup = showTotals ? `<div class="cash-activity-totals"><div><span>Cobrado a clientes</span><strong>${money(totals.receivedInvoices)}</strong></div><div><span>Salidas de dinero</span><strong>${money(totals.outflows)}</strong><small>Gastos e impuestos pagados</small></div><div><span>Diferencia de entradas y salidas</span><strong class="${Number(totals.net) < 0 ? 'is-negative' : 'is-positive'}">${money(totals.net)}</strong><small>${refunds ? `Incluye ${money(refunds)} de devoluciones` : 'Sin sumar el saldo inicial'}</small></div></div>` : '';
  return `<section class="card cash-activity ${compact ? 'is-compact' : ''}"><div class="cash-activity-header"><div><h2>Cobros y salidas de dinero por mes</h2><p>Por encima del cero entra dinero; por debajo, sale.</p></div>${activity.range?.label ? `<span class="cash-activity-period">${esc(activity.range.label)}</span>` : ''}</div>${totalsMarkup}${hasMovements ? `${plotMarkup(months, colors, compact)}<div class="cash-activity-legend" aria-label="Leyenda del gráfico"><span><i style="--cash-color:${CUSTOMER_COLOR}" aria-hidden="true"></i>Cobros de clientes</span>${refunds ? `<span><i style="--cash-color:${REFUND_COLOR}" aria-hidden="true"></i>Devoluciones recibidas</span>` : ''}<span><i class="cash-activity-cost-swatch" aria-hidden="true"></i>Pagos de gastos por categoría</span>${value(totals.paidTaxes) ? `<span><i style="--cash-color:${TAX_COLOR}" aria-hidden="true"></i>Impuestos pagados</span>` : ''}</div>` : '<div class="cash-activity-empty"><span aria-hidden="true">↕</span><p>Los cobros y pagos aparecerán aquí cuando los registres.</p></div>'}<p class="cash-activity-note">Todos los importes usan la fecha real de cobro o pago. Las salidas incluyen IVA y los impuestos registrados por separado; las devoluciones se muestran como entradas. ${hasMovements ? 'Las barras comparten la misma escala en euros.' : ''}</p>${breakdownMarkup(activity, colors)}${months.length ? dataTableMarkup(months) : ''}</section>`;
}
