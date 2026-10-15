import './document-preview.css';
import { money, formatNumber, escapeHTML as esc, documentAmounts, totals } from './domain.js';

const dateFormatter = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
});

function displayDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '—';
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.valueOf()) ? '—' : dateFormatter.format(date);
}

/** A responsive document view; download/print layout is rendered independently. */
export function renderDocumentPreview(d = {}, { company = {}, client = {}, logoUrl = '', demo = false } = {}) {
  const invoice = d.kind === 'invoice';
  const amounts = documentAmounts(d);
  const items = Array.isArray(d.items) ? d.items : [];
  return `<article class="paper doc-preview" aria-label="Vista previa del ${invoice ? 'documento de factura' : 'presupuesto'}">
    <header class="paper-header">
      <img class="document-brand" src="${esc(logoUrl)}" alt="Orquívia">
      <div class="paper-document-meta">
        <h2>${invoice ? 'FACTURA' : 'PRESUPUESTO'}</h2>
        <p>Número: <strong>${esc(d.number || 'Borrador')}</strong><br>Fecha: ${esc(displayDate(d.date))}</p>
      </div>
    </header>
    <div class="paper-parties">
      <div><small>${invoice ? 'Factura de' : 'Presupuesto de'}</small><strong>${esc(company.legalName || company.name)}</strong><span>${esc(company.taxId || 'NIF / CIF por completar')}</span><span>${esc(company.address || 'Dirección por completar')}</span><span>${esc(company.email)}</span></div>
      <div class="paper-client"><small>Cliente</small><strong>${esc(client.name)}</strong><span>${esc(client.taxId)}</span><span>${esc(client.address)}</span><span>${esc(client.email)}</span></div>
    </div>
    <table class="paper-table" aria-label="Conceptos del documento">
      <thead><tr><th scope="col">CONCEPTO</th><th scope="col" class="paper-quantity">CANT.</th><th scope="col" class="paper-price">PRECIO</th><th scope="col" class="paper-line-total">SUBTOTAL</th></tr></thead>
      <tbody>${items.map(item => `<tr><td class="paper-concept"><strong>${esc(item.description || 'Tu concepto')}</strong>${item.detail ? `<p>${esc(item.detail)}</p>` : ''}</td><td class="paper-quantity" data-column="Cant."><span>${esc(formatNumber(item.quantity || 0))}</span></td><td class="paper-price" data-column="Precio"><span>${money(item.price || 0)}</span></td><td class="paper-line-total" data-column="Subtotal"><span>${money(totals({ items: [item] }).subtotal)}</span></td></tr>`).join('')}</tbody>
    </table>
    ${invoice && d.po ? `<p class="paper-note">PO: ${esc(d.po)}</p>` : ''}
    <div class="paper-totals">
      ${amounts.discountAmount ? `<div><span>Subtotal</span><span>${money(amounts.subtotal)}</span></div><div><span>Descuento ${esc(d.discount || 0)} %</span><span>−${money(amounts.discountAmount)}</span></div>` : ''}
      <div><span>${invoice ? 'Base imponible' : 'Importe sin IVA'}</span><span>${money(amounts.base)}</span></div>
      ${invoice ? `<div><span>IVA ${esc(d.vat || 0)} %</span><span>${money(amounts.vatAmount)}</span></div>` : ''}
      ${amounts.withholdingAmount ? `<div><span>Retención ${esc(d.withholding || 0)} %</span><span>−${money(amounts.withholdingAmount)}</span></div>` : ''}
      <strong class="paper-grand-total"><span class="paper-total-label">Total${invoice ? '' : ' sin IVA'}</span><span>${money(amounts.total)}</span></strong>
      ${invoice ? '' : '<p class="paper-vat-note">IVA no incluido</p>'}
    </div>
    ${d.notes ? `<p class="paper-note">${esc(d.notes)}</p>` : ''}
    <p class="paper-valid">${invoice ? 'Vencimiento de pago' : 'Válido hasta'}: ${esc(displayDate(d.dueDate))}</p>
    <footer class="paper-footer"><div><strong>Método de pago</strong><span>${esc(d.paymentMethod || 'Transferencia bancaria')}</span></div><div><strong>Cuenta bancaria</strong><span>${esc(company.iban || 'IBAN por completar')}</span></div></footer>
    ${demo ? '<div class="paper-demo">DOCUMENTO DE PRUEBA</div>' : ''}
  </article>`;
}
