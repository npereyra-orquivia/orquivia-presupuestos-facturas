import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildPeriodBundle } from '../src/quarter-export.js';
import { money } from '../src/domain.js';

const ORG = 'd1000000-0000-4000-8000-000000000001';
const EXPENSE = 'd2000000-0000-4000-8000-000000000001';
const TAX = 'd3000000-0000-4000-8000-000000000001';
const REFUND = 'd3000000-0000-4000-8000-000000000002';
const ORIGINAL = new TextEncoder().encode('%PDF-1.7\nFictional original evidence\n');
const attachment = (recordId, index) => {
  const id = `d4000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return { id, name: `Original-${index}.pdf`, path: `${ORG}/${recordId}/${id}.pdf`,
    mimeType: 'application/pdf', size: ORIGINAL.length };
};

async function summaryAndZip(result) {
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
  const text = await zip.file('resumen.txt').async('string');
  const summary = new Map(text.split('\r\n').filter(line => line.includes(': ')).map(line => {
    const separator = line.indexOf(': ');
    return [line.slice(0, separator), line.slice(separator + 2)];
  }));
  return { summary, zip };
}

test('quarter exports reconcile gross payments and refunds by bank date while keeping originals in their document/fiscal quarter', async () => {
  const state = {
    company: { name: 'Fictional company', openingBalance: 5000, openingBalanceDate: '2026-08-01' },
    clients: [{ id: 'client', name: 'Fictional client' }],
    documents: [{ id: 'invoice', kind: 'invoice', status: 'paid', number: 'F-2026-TEST', clientId: 'client',
      date: '2026-06-28', dueDate: '2026-07-01', title: 'Fictional service',
      items: [{ description: 'Fictional service', quantity: 1, price: 200.14 }], vat: 0, discount: 0, withholding: 0 }],
    payments: [{ id: 'payment', documentId: 'invoice', date: '2026-07-25', amount: 200.14 }],
    expenses: [{ id: EXPENSE, date: '2026-05-31', description: 'Fictional receipt with undisclosed VAT',
      category: 'Transporte', base: 121, vatAmount: 0, total: 121, vatDeductibleAmount: 0,
      vatReviewNeeded: true, vatDocumentStatus: 'not-stated', paymentStatus: 'paid', paidDate: '2026-07-01',
      cashAmount: 101, cashMovements: [
        { id: 'd5000000-0000-4000-8000-000000000001', date: '2026-07-01', amount: 121 },
        { id: 'd5000000-0000-4000-8000-000000000002', date: '2026-07-05', amount: -20 },
      ], attachments: [attachment(EXPENSE, 1)] }],
    taxRecords: [{ id: TAX, model: '303', year: 2026, quarter: 2, date: '2026-07-13', amount: 30,
      paymentStatus: 'paid', paidDate: '2026-07-20', attachments: [attachment(TAX, 2)] },
    { id: REFUND, model: '303', year: 2026, quarter: 2, date: '2026-07-13', amount: -5,
      paymentStatus: 'paid', paidDate: '2026-07-22', attachments: [attachment(REFUND, 3)] }],
  };
  const requested = [];
  const second = await buildPeriodBundle(state, { type: 'quarter', year: 2026, quarter: 2 }, {
    async downloadLocalReceipt(file) { requested.push(file.path); return new Blob([ORIGINAL], { type: 'application/pdf' }); },
  });
  const t2 = await summaryAndZip(second);
  assert.equal(second.invoiceCount, 1);
  assert.equal(second.receiptCount, 3);
  assert.equal(requested.length, 3);
  assert.equal(t2.summary.get('Total de facturas emitidas'), money(200.14));
  assert.equal(t2.summary.get('Total de gastos'), money(121), 'Unknown VAT cannot remove the receipt gross total');
  assert.equal(t2.summary.get('Base de gastos con IVA revisado'), money(0));
  assert.equal(t2.summary.get('Resultado declarado (no es gasto ni IVA soportado)'), money(25));
  assert.equal(t2.summary.get('Salidas totales antes de devoluciones'), money(0));
  assert.equal(t2.summary.get('Cobros registrados con fecha dentro del período'), money(0));
  const originals = Object.values(t2.zip.files).filter(file => !file.dir
    && /^(?:justificantes|declaraciones)\//.test(file.name));
  assert.equal(originals.length, 3, 'Document-date and fiscal-period originals stay in T2 despite their July bank dates');
  for (const file of originals) assert.deepEqual(await file.async('uint8array'), ORIGINAL);

  const third = await buildPeriodBundle(state, { type: 'quarter', year: 2026, quarter: 3 });
  const t3 = await summaryAndZip(third);
  assert.equal(third.invoiceCount, 0);
  assert.equal(third.receiptCount, 0);
  assert.equal(t3.summary.get('Total de gastos'), money(0), 'The T2 receipt must not be registered again in T3');
  assert.equal(t3.summary.get('Declaraciones fiscales del período fiscal seleccionado'), '0');
  assert.equal(t3.summary.get('Pagos brutos de gastos'), money(121));
  assert.equal(t3.summary.get('Pagos brutos de impuestos'), money(30));
  assert.equal(t3.summary.get('Salidas totales antes de devoluciones'), money(151));
  assert.equal(t3.summary.get('Devoluciones recibidas de proveedores e impuestos'), money(25));
  assert.equal(t3.summary.get('Pagos netos de gastos con fecha dentro del período'), money(101));
  assert.equal(t3.summary.get('Pagos fiscales separados con fecha dentro del período'), money(25));
  assert.equal(t3.summary.get('Salida neta de dinero'), money(126));
  assert.equal(t3.summary.get('Cobros registrados con fecha dentro del período'), money(200.14));
  assert.equal(t3.summary.get('Diferencia de entradas y salidas, sin saldo inicial'), money(74.14));
});
