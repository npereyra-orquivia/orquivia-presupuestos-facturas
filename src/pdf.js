import { jsPDF } from 'jspdf';
import { totals, documentAmounts, money, formatNumber } from './domain.js';

const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[\u2010-\u2015\u2212]/g, '-');
const date = value => value ? String(value).split('-').reverse().join('/') : '';
const ink = [23, 37, 49], muted = [130, 145, 153], pale = [236, 242, 242];

/** Vector A4 output. All user text wraps and flows before the reserved footer. */
export function createPDF(document, company, client, { logoData, demo = false } = {}) {
  company = document.companySnapshot || company || {};
  client = document.clientSnapshot || client || {};
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const kind = document.kind === 'invoice' ? 'Factura' : 'Presupuesto';
  const number = clean(document.number).trim() || 'Borrador';
  const left = 24, right = 186, width = right - left;
  pdf.setProperties({ title: `${kind} ${number}`, author: clean(company.name || 'Orquívia'), creator: 'Orquívia' });

  function text(value, x, y, size = 9, { color = ink, align = 'left', style = 'normal' } = {}) {
    pdf.setFont('helvetica', style); pdf.setFontSize(size); pdf.setTextColor(...color);
    pdf.text(clean(value), x, y, { align });
  }
  function wrapped(value, maxWidth, size = 9) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(size);
    return pdf.splitTextToSize(clean(value), maxWidth);
  }
  function fit(value, x, y, maxWidth, size = 9, options = {}) {
    pdf.setFont('helvetica', options.style || 'normal'); pdf.setFontSize(size);
    const measured = pdf.getTextWidth(clean(value));
    text(value, x, y, measured > maxWidth ? size * maxWidth / measured : size, options);
  }

  // Reserve space for the actual numbers before wrapping the concept. Prices
  // remain readable when a document has wider amounts than the usual columns.
  const quantity = value => formatNumber(value, { maximumFractionDigits: 6 });
  const itemAmounts = (document.items || []).map(item => ({
    quantity: quantity(item.quantity), price: money(item.price), subtotal: money(totals({ items: [item] }).subtotal),
  }));
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
  const desiredColumns = [
    Math.max(14, ...itemAmounts.map(item => pdf.getTextWidth(item.quantity) + 2)),
    Math.max(24, ...itemAmounts.map(item => pdf.getTextWidth(item.price) + 2)),
    Math.max(26, ...itemAmounts.map(item => pdf.getTextWidth(item.subtotal) + 2)),
  ];
  const columnGaps = 13, minimumConcept = 42;
  const numericBudget = width - columnGaps - minimumConcept;
  const columnScale = Math.min(1, numericBudget / desiredColumns.reduce((sum, size) => sum + size, 0));
  const [quantityWidth, priceWidth, subtotalWidth] = desiredColumns.map(size => size * columnScale);
  const conceptWidth = width - columnGaps - quantityWidth - priceWidth - subtotalWidth;
  const quantityLeft = left + conceptWidth + 5;
  const quantityCenter = quantityLeft + quantityWidth / 2;
  const priceRight = quantityLeft + quantityWidth + 4 + priceWidth;
  const amountSize = Math.min(9, Math.max(6.5, 9 * columnScale));

  // Ordinary privacy notices repeat within a reserved footer. Longer notices
  // are paginated as a final section instead of shrinking or discarding text.
  const privacyLines = company.privacyText ? wrapped(company.privacyText, width, 7) : [];
  const privacyInFooter = privacyLines.length > 0 && privacyLines.length <= 12;
  const privacyTop = 277 - Math.max(0, privacyLines.length - 1) * 3.1;
  const bodyBottom = privacyInFooter ? Math.min(259, privacyTop - 8) : 269;
  let y = 0;
  function tableHeader() {
    if (y + 12 > bodyBottom) continuation(false);
    text('CONCEPTO', left, y, 8); text('CANT.', quantityCenter, y, 7, { align: 'center' });
    text('PRECIO', priceRight, y, 7, { align: 'right' }); text('SUBTOTAL', right, y, 7, { align: 'right' });
    pdf.setDrawColor(...ink); pdf.setLineWidth(.2); pdf.line(left, y + 3, right, y + 3); y += 10;
  }
  function continuation(withTable = true) {
    pdf.addPage();
    fit(company.name || 'Orquívia', left, 20, 65, 11);
    fit(`${kind.toUpperCase()} ${number}`, right, 20, 92, 10, { align: 'right' });
    y = 35;
    if (withTable) tableHeader();
  }
  function flowLines(lines, { size = 9, color = ink, step = 4.5, gap = 8 } = {}) {
    const height = lines.length * step;
    if (height <= bodyBottom - 35 && y + height > bodyBottom) continuation(false);
    for (const line of lines) {
      if (y > bodyBottom) continuation(false);
      text(line, left, y, size, { color }); y += step;
    }
    y += gap;
  }

  if (logoData) {
    const image = pdf.getImageProperties(logoData);
    const ratio = image.width / image.height;
    const imageWidth = Math.min(ratio >= 2 ? 62 : 15, 20 * ratio);
    pdf.addImage(logoData, 'PNG', 25, ratio >= 2 ? 14 : 12, imageWidth, imageWidth / ratio);
  } else fit(company.name || 'Orquívia', left, 24, 68, 18);
  text(kind.toUpperCase(), right, 26, 16, { align: 'right' });
  fit(`Número: ${number}`, right, 34, 87, 9, { align: 'right' });
  text(`Fecha: ${date(document.date)}`, right, 39, 9, { color: muted, align: 'right' });

  const issuer = [company.legalName || company.name, company.taxId, company.address, company.email]
    .filter(Boolean).flatMap(value => wrapped(value, 70, 9));
  const recipient = [client.name, client.taxId, client.address, client.email]
    .filter(Boolean).flatMap(value => wrapped(value, 78, 9));
  let partyIndex = 0;
  do {
    const firstPage = pdf.getNumberOfPages() === 1;
    const labelY = firstPage ? 55 : y;
    text(`${kind} de`, left, labelY, 8, { color: muted }); text('Cliente', 102, labelY, 8, { color: muted });
    const firstLineY = labelY + 9;
    const available = Math.max(1, Math.floor((bodyBottom - firstLineY - 12) / 4.5));
    const count = Math.min(available, Math.max(issuer.length, recipient.length) - partyIndex);
    const recipientChunk = recipient.slice(partyIndex, partyIndex + count);
    pdf.setFillColor(...pale);
    pdf.rect(100, firstLineY - 6, 86, Math.max(25, recipientChunk.length * 4.5 + 8), 'F');
    issuer.slice(partyIndex, partyIndex + count).forEach((line, index) => text(line, left, firstLineY + index * 4.5, 9, { color: partyIndex + index === 0 ? ink : muted }));
    recipientChunk.forEach((line, index) => text(line, 103, firstLineY + index * 4.5, 9, { color: partyIndex + index === 0 ? ink : muted }));
    y = Math.max(firstPage ? 99 : 35, firstLineY + Math.max(1, count) * 4.5 + 15);
    partyIndex += Math.max(1, count);
    if (partyIndex < Math.max(issuer.length, recipient.length)) continuation(false);
  } while (partyIndex < Math.max(issuer.length, recipient.length));
  const firstItem = document.items?.[0];
  if (firstItem) {
    const lineCount = wrapped(clean(firstItem.description).toUpperCase(), conceptWidth, 9).length
      + (firstItem.detail ? 1 + wrapped(firstItem.detail, conceptWidth, 9).length : 0);
    const firstRowHeight = Math.max(lineCount * 4.5, 5) + 9;
    const reserve = firstRowHeight < bodyBottom - 45 ? firstRowHeight : 17;
    if (y + 10 + reserve > bodyBottom) continuation(false);
  }
  tableHeader();

  for (const [itemIndex, item] of (document.items || []).entries()) {
    const lines = [...wrapped(clean(item.description).toUpperCase(), conceptWidth, 9), ...(item.detail ? ['', ...wrapped(item.detail, conceptWidth, 9)] : [])];
    const wholeHeight = Math.max(lines.length * 4.5, 5) + 9;
    if (y + wholeHeight > bodyBottom && wholeHeight < bodyBottom - 45) continuation();
    let consumed = 0, first = true;
    while (consumed < lines.length) {
      const available = Math.floor((bodyBottom - y - 8) / 4.5);
      if (available < 2) { continuation(); continue; }
      const chunk = lines.slice(consumed, consumed + available);
      if (first) {
        fit(itemAmounts[itemIndex].quantity, quantityCenter, y, quantityWidth, amountSize, { align: 'center' });
        fit(itemAmounts[itemIndex].price, priceRight, y, priceWidth, amountSize, { align: 'right' });
        fit(itemAmounts[itemIndex].subtotal, right, y, subtotalWidth, amountSize, { align: 'right' });
      }
      chunk.forEach((line, index) => text(line, left, y + index * 4.5, 9));
      y += Math.max(chunk.length * 4.5, 5) + 9; consumed += chunk.length; first = false;
      pdf.setDrawColor(225, 232, 232); pdf.setLineWidth(.15); pdf.line(left, y - 5, right, y - 5);
      if (consumed < lines.length) continuation();
    }
  }
  if (document.po) flowLines(wrapped(`PO / Orden de pedido: ${document.po}`, width, 9));
  if (document.notes) flowLines(wrapped(document.notes, width, 9), { color: muted });

  const t = documentAmounts(document), rows = [];
  if (t.discountAmount) rows.push(['Subtotal', money(t.subtotal)], [`Descuento ${document.discount}%`, '- ' + money(t.discountAmount)]);
  if (t.vatIncluded) rows.push(['Base imponible', money(t.base)]);
  if (t.vatIncluded) rows.push([`IVA ${document.vat}%`, money(t.vatAmount)]);
  if (t.withholdingAmount) rows.push([`Retención ${document.withholding}%`, '- ' + money(t.withholdingAmount)]);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(16);
  const totalWidth = !t.vatIncluded && !rows.length
    ? Math.min(width, Math.max(40, pdf.getTextWidth(clean(money(t.total))) + 8)) : 82;
  const totalHeight = rows.length * 6 + (t.vatIncluded ? 23 : 14);
  const validity = document.kind === 'invoice'
    ? (document.dueDate ? `Vencimiento de pago: ${date(document.dueDate)}` : 'Vencimiento de pago pendiente de confirmar')
    : (document.dueDate ? `Este presupuesto es válido hasta: ${date(document.dueDate)}` : 'Validez pendiente de confirmar');
  const validityLines = wrapped(validity, width, 8);
  const paymentColumns = [
    { title: 'Plazo de pago', x: left + 2, width: 33, lines: wrapped(document.kind === 'invoice' ? (document.dueDate ? `Hasta ${date(document.dueDate)}` : 'Pendiente de confirmar') : `${company.paymentTerms ?? 30} días desde la factura`, 33, 8) },
    { title: 'Método de pago', x: 63, width: 43, lines: wrapped(document.paymentMethod || 'Transferencia bancaria', 43, 8) },
    { title: 'Cuenta bancaria', x: 111, width: 73, lines: [...wrapped(company.iban || 'IBAN por completar', 73, 8), ...(company.bic ? wrapped(`BIC: ${company.bic}`, 73, 8) : [])] },
  ];
  const paymentRows = Math.max(...paymentColumns.map(column => column.lines.length));
  const paymentHeight = validityLines.length * 4 + 14 + paymentRows * 4;
  const normalTotalY = Math.min(185, bodyBottom - totalHeight - paymentHeight - 12);
  let totalY = Math.max(pdf.getNumberOfPages() === 1 ? normalTotalY : 40, y + 10);
  // Keep the usual totals and payment block together. Unusually long bank or
  // payment text then flows through continuation pages, just like addresses.
  const reservePayment = Math.min(paymentHeight, 50);
  if (totalY + totalHeight + reservePayment + 12 > bodyBottom) {
    continuation(false); totalY = y + 7;
  }
  pdf.setFillColor(...pale); pdf.rect(right - totalWidth, totalY, totalWidth, totalHeight, 'F');
  rows.forEach(([label, value], index) => {
    fit(label, 107, totalY + 8 + index * 6, 42, 10);
    fit(value, 183, totalY + 8 + index * 6, 32, 10, { align: 'right' });
  });
  fit(money(t.total), 183, totalY + totalHeight - (t.vatIncluded ? 6 : 4), totalWidth - 6, 16, { align: 'right' });
  if (!t.vatIncluded) text('IVA no incluido', 183, totalY + totalHeight + 5, 8, { color: muted, align: 'right' });
  y = totalY + totalHeight + 12;
  flowLines(validityLines, { size: 8, color: muted, step: 4, gap: 1 });
  let paymentIndex = 0;
  while (paymentIndex < paymentRows) {
    if (y + 18 > bodyBottom) continuation(false);
    pdf.setDrawColor(...ink); pdf.setLineWidth(.2); pdf.line(left, y, right, y);
    paymentColumns.forEach(column => text(column.title, column.x, y + 8, 9, { style: 'bold' }));
    const available = Math.max(1, Math.floor((bodyBottom - y - 14) / 4) + 1);
    const count = Math.min(available, paymentRows - paymentIndex);
    paymentColumns.forEach(column => column.lines.slice(paymentIndex, paymentIndex + count)
      .forEach((line, index) => text(line, column.x, y + 14 + index * 4, 8, { color: muted })));
    y += 14 + count * 4 + 8; paymentIndex += count;
    if (paymentIndex < paymentRows) continuation(false);
  }
  if (privacyLines.length && !privacyInFooter) flowLines(privacyLines, { size: 7, color: muted, step: 3.1, gap: 0 });

  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    if (document.status === 'draft') {
      pdf.saveGraphicsState(); pdf.setGState(new pdf.GState({ opacity: .16 }));
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(48); pdf.setTextColor(...muted);
      pdf.text('BORRADOR', 105, 164, { align: 'center', angle: 35 }); pdf.restoreGraphicsState();
    }
    if (privacyInFooter) privacyLines.forEach((line, index) => text(line, left, privacyTop + index * 3.1, 7, { color: muted }));
    text(`Página ${page} de ${pages}`, right, 286, 8, { color: muted, align: 'right' });
    if (demo) text('DOCUMENTO DE PRUEBA - DATOS DE DEMOSTRACIÓN', left, 286, 7, { color: muted });
  }
  return pdf;
}

async function loadLogo(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo cargar el logotipo.');
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
  });
}
export async function downloadPDF(document, company, client, { logoUrl, demo = false } = {}) {
  const logoData = logoUrl ? await loadLogo(logoUrl) : null;
  const pdf = createPDF(document, company, client, { logoData, demo });
  const name = (clean(document.number).trim() || 'Borrador').replace(/[^a-zA-Z0-9_.-]/g, '_');
  pdf.save(`${document.kind === 'invoice' ? 'Factura' : 'Presupuesto'}_${name}.pdf`);
}
