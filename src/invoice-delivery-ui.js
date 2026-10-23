import { escapeHTML as esc, invoiceDeliveryStatus, invoiceDeliveryLabel } from './domain.js';

export function invoiceDeliveryBadge(document) {
  const status = invoiceDeliveryStatus(document);
  return `<span class="badge ${status === 'unknown' ? 'neutral' : status}" aria-label="Envío: ${esc(invoiceDeliveryLabel(document))}"><i></i>${esc(invoiceDeliveryLabel(document))}</span>`;
}

export function invoiceDeliveryFilter(value = 'all') {
  return `<label class="field invoice-delivery-filter"><span>Envío de las facturas</span><select id="invoice-delivery-filter">${[['all','Todos los envíos'],['ready','Preparadas'],['sent','Enviadas'],['unknown','Sin indicar']].map(([id,label]) => `<option value="${id}" ${value === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
}

export function invoiceDeliveryPanel(document, client = {}) {
  const status = invoiceDeliveryStatus(document);
  const fallback = client.billingEmail || client.email || '';
  return `<section class="detail-box invoice-delivery-panel"><h4>Envío de la factura</h4><label class="field"><span>Estado de envío</span><select name="invoice-delivery-status">${[['unknown','Sin indicar'],['ready','Preparada'],['sent','Enviada']].map(([id,label]) => `<option value="${id}" ${status === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label><p class="field-hint">Puedes marcarla como enviada si la entregas por otro medio. El envío desde el portal lo actualiza automáticamente.</p>${document.po ? `<p class="invoice-order-reference">Orden de pedido (PO)<strong>${esc(document.po)}</strong></p>` : ''}<form id="invoice-recipient-form"><label class="field"><span>Correo para esta factura (opcional)</span><input name="billingEmail" type="email" maxlength="254" value="${esc(document.billingEmail || '')}" placeholder="${esc(fallback || 'facturacion@cliente.com')}" autocomplete="off"></label><p class="field-hint">Puede ser distinto del contacto del presupuesto. Podrás revisar destinatarios y copias antes de cada envío.</p><button class="button secondary full" type="submit">Guardar correo de facturación</button></form></section>`;
}
