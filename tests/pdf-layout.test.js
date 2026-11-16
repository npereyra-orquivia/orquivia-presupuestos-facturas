import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPDF } from '../src/pdf.js';

const company = { name: 'Orquivia', legalName: 'Empresa de prueba', address: 'Calle de prueba, 1', paymentTerms: 30 };
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

test('quotes and invoices keep the complete closing block at the same bottom position on one or two pages', async () => {
  const issuer = { ...company, privacyText: 'Aviso de privacidad del ejemplo.' };
  const items = Array.from({ length: 9 }, (_, index) => ({
    description: `Servicio ${index + 1}: planificación y ejecución`, quantity: 1, price: 125,
    detail: 'Preparación de materiales, coordinación de los trabajos y revisión del servicio realizado.',
  }));
  for (const kind of ['quote', 'invoice']) {
    const short = await readPDF(document({ kind }), issuer);
    const long = await readPDF(document({ kind, items }), issuer);
    assert.equal(short.pages.length, 1);
    assert.equal(long.pages.length, 2);
    const firstPayment = short.pages[0].items.find(item => item.str === 'Método de pago');
    const lastPage = long.pages.at(-1);
    const lastPayment = lastPage.items.find(item => item.str === 'Método de pago');
    assert.ok(firstPayment && lastPayment);
    assert.ok(firstPayment.transform[5] < short.pages[0].height / 4, 'Payment information belongs to the bottom quarter');
    assert.ok(Math.abs(firstPayment.transform[5] - lastPayment.transform[5]) < 0.1, 'Closing position stays fixed when concepts span two pages');
    assert.ok(long.pages.slice(0, -1).every(page => !page.items.some(item => item.str === 'Método de pago' || item.str === 'IVA no incluido')));
    assert.match(long.text, /Servicio 9:/i);
    assert.match(lastPage.items.map(item => item.str).join(' '), /Cuenta bancaria/);
  }
});

test('long legal and payment text remains complete before a final closing block without off-page text', async () => {
  const issuer = {
    ...company,
    privacyText: Array.from({ length: 80 }, (_, index) => `Aviso legal ${index + 1}`).join('\n'),
    iban: Array.from({ length: 110 }, (_, index) => `Dato de cuenta ${index + 1}`).join('\n'),
  };
  const { pages, text } = await readPDF(document(), issuer);
  assert.match(text, /Aviso legal 1 /);
  assert.match(text, /Aviso legal 80 /);
  assert.match(text, /Dato de cuenta 1 /);
  assert.match(text, /Dato de cuenta 110 /);
  assert.ok(pages.at(-1).items.some(item => item.str === 'IVA no incluido'));
  assert.ok(pages.slice(0, -1).every(page => !page.items.some(item => item.str === 'IVA no incluido')));
  for (const page of pages) for (const item of page.items) {
    assert.ok(item.transform[5] >= 0 && item.transform[5] <= page.height, `Text must stay inside the page: ${item.str}`);
  }
});

const compactNoteIssuer = {
  ...company, taxId: 'B00000000', email: 'empresa@example.test',
  address: 'Calle de prueba 123, planta segunda, puerta cuatro, 08000 Ciudad, Provincia',
  iban: 'ES00 0000 0000 0000 0000 0000', bic: 'TESTESMMXXX',
  privacyText: [
    'PRIVACIDAD 1: conservación conforme a la finalidad declarada.',
    'PRIVACIDAD 2: acceso restringido al personal autorizado.',
    'PRIVACIDAD 3: ejercicio de derechos mediante contacto con la empresa.',
    'PRIVACIDAD 4: información de ejemplo para las pruebas.',
  ].join('\n'),
};
const compactNoteClient = {
  name: 'Cliente de prueba', taxId: 'B11111111', email: 'cliente@example.test',
  address: 'Calle del cliente 456, planta primera, puerta segunda, 08000 Ciudad, Provincia',
};

test('a three-item quote retains structured conditions on one page above its anchored closing block', async () => {
  const scope = 'Incluye retirada del sellado existente, visita de medición y desplazamientos, suministro del material de revestimiento de 9 mm, corte y adaptación de las piezas, colocación y unión de juntas no visibles. La superficie se comprobará antes de colocar el material y se coordinará el acceso a las tres unidades con la persona responsable del centro. Se incluyen los medios auxiliares necesarios para una instalación correcta.';
  const notes = ['ALTERNATIVA CON EJECUCIÓN PRIORITARIA', scope,
    'La fecha prioritaria requiere aceptación antes del plazo indicado.',
    'El importe es orientativo según plano, con ajuste aprobado tras la medición definitiva.',
    'La opción es excluyente respecto a la alternativa ordinaria. FINNOTAS.',
  ].join('\n');
  const doc = document({ notes, items: [
    { description: 'Servicio principal: preparación y colocación de material en dos accesos', quantity: 1, price: 1110 },
    { description: 'Servicio de revestimiento en una apertura', quantity: 1, price: 2220 },
    { description: 'Servicio de revestimiento en otra apertura', quantity: 1, price: 3330 },
  ] });
  const original = structuredClone(doc);
  const { pages, text } = await readPDF(doc, compactNoteIssuer, compactNoteClient);
  assert.equal(pages.length, 1, 'A moderate structured note must not strand the closing block on another sheet');
  assert.ok(text.includes(plain(notes)), 'Every condition and paragraph must remain present');
  const page = pages[0], lastNote = page.items.find(item => item.str.includes('FINNOTAS'));
  const total = page.items.find(item => plain(item.str) === '6.660,00 €');
  const payment = page.items.find(item => item.str === 'Método de pago');
  const privacy = page.items.find(item => item.str.includes('PRIVACIDAD 4'));
  assert.ok(lastNote && total && payment && privacy);
  assert.ok(Math.abs(lastNote.transform[0] - 8) < 0.01, 'Quote conditions use a readable eight-point font');
  assert.ok(lastNote.transform[5] - total.transform[5] > 35, 'The complete note remains separated from the total');
  assert.ok(payment.transform[5] < page.height / 4 && payment.transform[5] > privacy.transform[5], 'Payment stays at the bottom above the privacy footer');
  assert.match(text, /TESTESMMXXX/);
  assert.deepEqual(doc, original, 'Layout changes never rewrite notes or financial values');
});

test('quote note compaction leaves invoice note typography unchanged', async () => {
  for (const [kind, expectedSize] of [['quote', 8], ['invoice', 9]]) {
    const { pages } = await readPDF(document({ kind, notes: 'TIPOGRAFIADEPRUEBA' }));
    const note = pages.flatMap(page => page.items).find(item => item.str === 'TIPOGRAFIADEPRUEBA');
    assert.ok(note);
    assert.ok(Math.abs(note.transform[0] - expectedSize) < 0.01);
  }
});

test('genuinely long quote notes paginate completely without hiding their end or payment information', async () => {
  const notes = Array.from({ length: 160 }, (_, index) => `CONDICION${index + 1}: revisar y confirmar los detalles de ejecución del servicio.`).join('\n');
  const { pages, text } = await readPDF(document({ notes }), compactNoteIssuer, compactNoteClient);
  assert.ok(pages.length > 1);
  assert.match(text, /CONDICION1:/);
  assert.match(text, /CONDICION160:/);
  assert.ok(pages.at(-1).items.some(item => item.str === 'IVA no incluido'));
  assert.ok(pages.slice(0, -1).every(page => !page.items.some(item => item.str === 'Método de pago' || item.str === 'IVA no incluido')));
  for (const page of pages) for (const item of page.items) {
    assert.ok(item.transform[5] >= 0 && item.transform[5] <= page.height, `Text stays on-page: ${item.str}`);
  }
});
