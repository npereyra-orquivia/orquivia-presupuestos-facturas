import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPDF } from '../src/pdf.js';

const company = { name: 'Orquívia', legalName: 'Empresa de prueba', address: 'Calle de prueba, 1', paymentTerms: 30 };
const client = { name: 'Cliente de prueba', address: 'Dirección de prueba, 2' };
const document = (overrides = {}) => ({
  kind: 'quote', status: 'sent', number: 'PR-2026-001', date: '2026-10-15', dueDate: '2026-11-15',
  items: [{ description: 'Servicio de prueba', quantity: 1, price: 6000 }],
  discount: 0, vat: 21, withholding: 0, ...overrides,
});
const plain = value => value.replace(/\s+/g, ' ').trim();

async function readPDF(doc, issuer = company, recipient = client) {
  const generated = createPDF(doc, issuer, recipient);
  const task = getDocument({
    data: new Uint8Array(generated.output('arraybuffer')), useSystemFonts: true,
  });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push({ width: page.view[2], height: page.view[3], items: content.items.filter(item => 'str' in item) });
    }
    return { pages, text: plain(pages.flatMap(page => page.items.map(item => item.str)).join(' ')) };
  } finally { await task.destroy(); }
}

test('quote PDF shows a grouped pre-VAT total and note without altering its stored tax settings', async () => {
  const doc = document({ discount: 10, withholding: 15 });
  const original = structuredClone(doc);
  const { text } = await readPDF(doc);
  assert.match(text, /6\.000,00 €/);
  assert.match(text, /Descuento 10% - 600,00 €/);
  assert.match(text, /Retención 15% - 810,00 €/);
  assert.match(text, /4\.590,00 €/);
  assert.match(text, /IVA no incluido/);
  assert.doesNotMatch(text, /Importe sin IVA|Total sin IVA|Base imponible|IVA 21%|1\.134,00|5\.724,00/);
  assert.deepEqual(doc, original, 'Presentation must not change the stored VAT settings or line values');
});

test('a simple quote only repeats its amount for the line price, line subtotal and final total', async () => {
  const { text } = await readPDF(document());
  assert.equal((text.match(/6\.000,00 €/g) || []).length, 3);
  assert.equal((text.match(/IVA no incluido/g) || []).length, 1);
  assert.doesNotMatch(text, /Importe sin IVA|Total sin IVA|Base imponible/);
});

test('invoice PDF continues to disclose VAT and the full payable total', async () => {
  const { text } = await readPDF(document({ kind: 'invoice', number: '2026-001', status: 'issued' }));
  assert.match(text, /FACTURA/);
  assert.match(text, /Base imponible 6\.000,00 €/);
  assert.match(text, /IVA 21% 1\.260,00 €/);
  assert.match(text, /7\.260,00 €/);
  assert.doesNotMatch(text, /IVA no incluido/);
});

test('large prices stay complete, distinct and inside the page, with quantity centered below its heading', async () => {
  const { pages, text } = await readPDF(document({
    items: [{ description: 'Servicio con un concepto que debe adaptarse al ancho disponible', quantity: 2, price: 9_876_543_210.98 }],
  }));
  assert.match(text, /9\.876\.543\.210,98 €/);
  assert.match(text, /19\.753\.086\.421,96 €/);
  const first = pages[0].items;
  const heading = first.find(item => item.str === 'CANT.');
  const quantity = first.find(item => item.str === '2');
  const price = first.find(item => plain(item.str) === '9.876.543.210,98 €');
  const subtotal = first.find(item => plain(item.str) === '19.753.086.421,96 €');
  assert.ok(heading && quantity && price && subtotal);
  const center = item => item.transform[4] + item.width / 2;
  assert.ok(Math.abs(center(heading) - center(quantity)) < 0.1, 'Quantity and heading share their horizontal center');
  assert.ok(quantity.transform[4] + quantity.width < price.transform[4], 'Quantity must not overlap the price');
  assert.ok(price.transform[4] + price.width < subtotal.transform[4], 'Price must not overlap the subtotal');
  for (const page of pages) for (const item of page.items) {
    assert.ok(item.transform[4] >= 0 && item.transform[4] + item.width <= page.width + 0.1, `Text must stay inside the page: ${item.str}`);
  }
});

test('wrapped concepts continue across pages without losing their end or payment information', async () => {
  const detail = Array.from({ length: 140 }, (_, index) => `Detalle ${index + 1}: información extensa del servicio contratado.`).join('\n');
  const { pages, text } = await readPDF(document({ items: [{ description: 'Servicio extenso', detail, quantity: 1, price: 15000 }] }));
  assert.ok(pages.length > 1);
  assert.match(text, /Detalle 1:/);
  assert.match(text, /Detalle 140:/);
  assert.match(text, /15\.000,00 €/);
  assert.match(text, /IVA no incluido/);
  assert.match(text, /Método de pago/);
  assert.match(text, /Transferencia bancaria/);
  for (let index = 0; index < pages.length; index++) {
    assert.ok(pages[index].items.some(item => item.str === `Página ${index + 1} de ${pages.length}`));
  }
});
