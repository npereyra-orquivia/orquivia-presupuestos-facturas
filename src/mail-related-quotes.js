import { escapeHTML as esc, documentAmounts, money } from './domain.js';
import { sortDocumentsNewestFirst } from './document-order.js';

export function relatedQuoteOptions(document, documents = []) {
  if (document?.kind !== 'quote') return [];
  return sortDocumentsNewestFirst(documents.filter(value => value && value.id !== document.id && value.kind === 'quote'
    && value.clientId === document.clientId && ['ready', 'sent'].includes(value.status) && String(value.number || '').trim()));
}

export function validateRelatedQuotes(ids = [], document, options = []) {
  if (!Array.isArray(ids) || ids.length > 4 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Selecciona hasta cuatro presupuestos adicionales distintos.');
  if (ids.length && document?.kind !== 'quote') throw new Error('Los presupuestos adicionales solo se incluyen al enviar un presupuesto.');
  const allowed = new Set(relatedQuoteOptions(document, options).map(value => value.id));
  if (ids.some(id => !allowed.has(id))) throw new Error('Un presupuesto seleccionado ha cambiado o ya no está disponible para este cliente. Vuelve a seleccionarlo.');
  return [...ids].sort();
}

export function unavailableRelatedQuoteIds(document, options = [], ids = []) {
  const allowed = new Set(relatedQuoteOptions(document, options).map(value => value.id));
  return Array.isArray(ids) ? ids.filter(id => !allowed.has(id)) : [];
}

export function renderRelatedQuotes(document, options = [], ids = []) {
  if (document?.kind !== 'quote') return '';
  const available = relatedQuoteOptions(document, options);
  const unavailable = unavailableRelatedQuoteIds(document, options, ids);
  return `<section class="mail-related-quotes" aria-label="Presupuestos del mismo correo"><h3>Presupuestos del mismo correo</h3><p>El presupuesto ${esc(document.number)} se adjunta automáticamente. Puedes incluir hasta cuatro más del mismo cliente.</p>${available.map(value => `<label class="mail-related-choice"><input type="checkbox" data-related-quote value="${esc(value.id)}" ${ids.includes(value.id) ? 'checked' : ''}><span><strong>${esc(value.number)}</strong>${value.title ? `<small>${esc(value.title)}</small>` : ''}</span><b>${esc(money(documentAmounts(value).total))}</b></label>`).join('') || '<p class="field-hint">No hay otros presupuestos preparados o enviados para este cliente.</p>'}${unavailable.length ? '<div class="note-banner mail-related-unavailable" data-unavailable-quotes><p role="alert">Hay presupuestos seleccionados que ya no están disponibles para este envío.</p><button type="button" class="button secondary" data-remove-unavailable-quotes>Quitar presupuestos no disponibles</button></div>' : ''}<p class="field-hint">Cada PDF conserva su número. Un único envío quedará registrado en el historial de todos los presupuestos incluidos.</p></section>`;
}

export function renderRelatedQuotePreviews(documents, preview) {
  return documents.map(value => `<details class="mail-related-preview"><summary>Ver PDF · ${esc(value.number)}</summary>${preview(value)}</details>`).join('');
}
