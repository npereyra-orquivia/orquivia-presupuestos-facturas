import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { buildQuarterBundle } from '../src/quarter-export.js';

const ORG = 'a2000000-0000-4000-8000-000000000001';
const EXPENSE = 'a4000000-0000-4000-8000-000000000001';
const ATTACHMENT = 'a5000000-0000-4000-8000-000000000001';
const INVOICE = 'a6000000-0000-4000-8000-000000000001';
const ORIGINAL_BYTES = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\nOriginal receipt\n'), 0, 255, 3, 10]);

const receipt = (overrides = {}) => ({
  id: ATTACHMENT, name: '..:<> "Factura?.exe', path: `${ORG}/${EXPENSE}/${ATTACHMENT}.pdf`,
  mimeType: 'application/pdf', size: ORIGINAL_BYTES.length, ...overrides,
});

function fixture({ documents = true, attachments = [receipt()] } = {}) {
  const invoice = {
    id: INVOICE, kind: 'invoice', status: 'issued', number: 'F-2025-001', clientId: 'client-1',
    date: '2025-03-31', dueDate: '2025-04-30', title: 'Fictional service',
    items: [{ description: 'Fictional service', quantity: 1, price: 100 }], vat: 21, discount: 0, withholding: 0, total: 121,
    companySnapshot: { name: 'Snapshot Issuer', legalName: 'Snapshot Legal Company', taxId: 'FAKE-SNAPSHOT-NIF' },
    clientSnapshot: { name: 'Snapshot Client', taxId: 'FAKE-CLIENT-NIF' },
  };
  return {
    company: { name: 'Edited Current Issuer' }, clients: [{ id: 'client-1', name: 'Edited Current Client' }], payments: [],
    documents: documents ? [invoice,
      { ...structuredClone(invoice), id: 'draft-1', number: '', status: 'draft' },
      { ...structuredClone(invoice), id: 'quote-1', kind: 'quote', number: 'PR-2025-001', status: 'accepted' },
      { ...structuredClone(invoice), id: 'outside-quarter', number: 'F-2025-002', date: '2025-04-01' },
    ] : [],
    expenses: [{ id: EXPENSE, date: '2025-03-31', supplier: 'Fictional Supplier', supplierTaxId: 'FAKE-SUPPLIER-NIF',
      description: 'Fictional materials', category: 'Material', base: 100, vatRate: 21, vatAmount: 21,
      total: 121, vatDeductibleAmount: 10.5, paymentStatus: 'pending', paidDate: null,
      reference: 'FAKE-REC-01', notes: '', attachments }],
  };
}

async function openBundle(result) {
  assert.ok(result.blob instanceof Blob);
  return JSZip.loadAsync(await result.blob.arrayBuffer());
}

function pdfContent(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const decoded = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { decoded.push(inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')); }
    catch { decoded.push(match[1]); }
  }
  return `${raw}\n${decoded.join('\n')}`;
}

test('quarter ZIP contains exact receipt bytes with portable filenames and one issued invoice from its snapshots', async () => {
  const state = fixture(), progress = [], requested = [];
  const result = await buildQuarterBundle(state, 2025, 1, {
    backend: { async downloadReceipt(attachment) { requested.push(attachment.path); return new Blob([ORIGINAL_BYTES], { type: 'application/pdf' }); } },
    downloadLocalReceipt() { throw new Error('A cloud bundle must use the authenticated backend adapter'); },
    onProgress(event) {
      assert.equal(typeof event.label, 'string');
      progress.push(event);
      // The original state can change while downloading. The export must retain
      // the private immutable snapshot captured before the first async callback.
      state.documents[0].clientSnapshot.name = 'Changed After Export Started';
      state.documents[0].companySnapshot.name = 'Changed After Export Started';
    },
  });
  assert.equal(result.name, 'Orquivia_2025_T1.zip');
  assert.equal(result.invoiceCount, 1);
  assert.equal(result.receiptCount, 1);
  assert.deepEqual(requested, [`${ORG}/${EXPENSE}/${ATTACHMENT}.pdf`]);
  const zip = await openBundle(result);
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  assert.equal(files.length, 4, 'CSV, summary, one invoice and one receipt');
  const receiptEntry = files.find((entry) => entry.name.startsWith('justificantes/'));
  assert.ok(receiptEntry);
  assert.match(receiptEntry.name, new RegExp(`^justificantes/${EXPENSE}/${ATTACHMENT}_.+\\.pdf$`));
  assert.doesNotMatch(receiptEntry.name, /[<>:"|?*]|\.\.|\.exe$/);
  assert.deepEqual(await receiptEntry.async('uint8array'), ORIGINAL_BYTES, 'Original bytes must not be recompressed, transcribed or replaced');
  const invoiceEntry = files.find((entry) => entry.name.startsWith('facturas/'));
  assert.equal(invoiceEntry.name, `facturas/${INVOICE}_F-2025-001.pdf`);
  const invoiceBytes = await invoiceEntry.async('uint8array');
  assert.match(Buffer.from(invoiceBytes).toString('latin1'), /^%PDF-/);
  const content = pdfContent(invoiceBytes);
  assert.match(content, /Snapshot Issuer/);
  assert.match(content, /Snapshot Client/);
  assert.doesNotMatch(content, /Edited Current|Changed After Export Started/);
  const csv = await zip.file('registro-trimestre.csv').async('string');
  assert.match(csv, /Snapshot Client/);
  assert.doesNotMatch(csv, /PR-2025-001|F-2025-002|Edited Current|Changed After Export Started|orquivia-receipts/);
  assert.ok(progress.every((event) => event.total === 4 && event.completed >= 0 && event.completed <= 4));
  assert.equal(progress.at(-1).label, 'Creando archivo ZIP');
  assert.equal(progress.at(-1).completed, 4);
});

test('quarter ZIP keeps recorded VAT and the explicitly confirmed partial VAT distinct', async () => {
  const result = await buildQuarterBundle(fixture({ documents: false, attachments: [] }), 2025, 1);
  const zip = await openBundle(result);
  const summary = await zip.file('resumen.txt').async('string');
  assert.match(summary, /IVA soportado registrado en justificantes: 21,00\s*€/);
  assert.match(summary, /IVA soportado confirmado por la usuaria para revisión del gestor: 10,50\s*€/);
  assert.match(summary, /No presenta una declaración fiscal/i);
  const csv = await zip.file('registro-trimestre.csv').async('string');
  assert.match(csv, /"Gasto recibido"/);
  assert.match(csv, /"100,00";"21,00";"0,00";"121,00";"10,50"/);
  assert.equal(result.invoiceCount, 0);
  assert.equal(result.receiptCount, 0);
});

test('a missing or incomplete receipt aborts the quarter export before any downloadable partial ZIP exists', async () => {
  const secondId = 'a5000000-0000-4000-8000-000000000002';
  const second = receipt({ id: secondId, name: 'Factura ausente.pdf', path: `${ORG}/${EXPENSE}/${secondId}.pdf` });
  const state = fixture({ documents: false, attachments: [receipt(), second] });
  const progress = [], calls = [];
  let returned = false;
  await assert.rejects(buildQuarterBundle(state, 2025, 1, {
    async downloadLocalReceipt(attachment) {
      calls.push(attachment.id);
      if (attachment.id === secondId) throw new Error('Private original unavailable');
      return new Blob([ORIGINAL_BYTES], { type: 'application/pdf' });
    },
    onProgress(event) { progress.push(event.label); },
  }).then((result) => { returned = true; return result; }), /No se pudo incluir el justificante «Factura ausente\.pdf»/);
  assert.equal(returned, false);
  assert.deepEqual(calls, [ATTACHMENT, secondId]);
  assert.ok(!progress.includes('Creando archivo ZIP'));
  await assert.rejects(buildQuarterBundle(fixture({ documents: false }), 2025, 1, {
    async downloadLocalReceipt() { return new Blob(['short']); },
  }), /No se ha creado un archivo parcial/);
});
