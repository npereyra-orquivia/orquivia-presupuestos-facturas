import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the real UI module while omitting Vite's CSS side-effect in Node.
const moduleURL = new URL('../src/expense-ui.js', import.meta.url);
const source = (await readFile(moduleURL, 'utf8'))
  .replace(/^import '\.\/expenses\.css';\r?\n/, '')
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, moduleURL).href}'`);
const { applyReceiptRegistration, expensesPage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const expense = () => ({ id: 'expense', date: '2026-09-09', description: 'Man Pirenaicas', total: 13,
  base: 10.74, vatAmount: 2.26, vatRate: 21, vatDeductibleAmount: 2.26, vatReviewNeeded: false,
  reviewNeeded: false, paymentStatus: 'paid', paidDate: '2026-09-09', cashAmount: 13,
  cashMovements: [{ date: '2026-09-09', amount: 13 }], notes: 'Ya comunicado al gestor.', attachments: [] });

test('a missing voucher requires deliberate acknowledgement and a bounded nonblank reason', () => {
  for (const settings of [
    { acknowledged: false, reason: 'No se pidió ticket.' },
    { acknowledged: true, reason: '' },
    { acknowledged: true, reason: '   ' },
    { acknowledged: true, reason: 'x'.repeat(2001) },
  ]) assert.throws(() => applyReceiptRegistration(expense(), { hasReceipt: false, ...settings }));
});

test('acknowledgement preserves cash and notes while refusing estimated VAT and deductions', () => {
  const original = expense(), before = structuredClone(original);
  const result = applyReceiptRegistration(original, { hasReceipt: false, acknowledged: true, reason: '  No pedimos ticket en el networking.  ' });
  assert.deepEqual(original, before);
  assert.equal(result.missingReceiptReason, 'No pedimos ticket en el networking.');
  assert.equal(result.total, 13); assert.equal(result.base, 13);
  assert.equal(result.vatAmount, 0); assert.equal(result.vatDeductibleAmount, 0);
  assert.equal(result.vatRate, undefined); assert.equal(result.vatReviewNeeded, true);
  assert.equal(result.vatDocumentStatus, 'not-stated'); assert.equal(result.reviewNeeded, false);
  assert.equal(result.paymentStatus, 'paid'); assert.equal(result.paidDate, before.paidDate);
  assert.equal(result.cashAmount, before.cashAmount); assert.deepEqual(result.cashMovements, before.cashMovements);
  assert.equal(result.notes, before.notes);
  // A separately selected review flag remains deliberate and must not be cleared on save.
  assert.equal(applyReceiptRegistration({ ...original, reviewNeeded: true }, { hasReceipt: false, acknowledged: true, reason: 'Falta ticket.' }).reviewNeeded, true);
});

test('adding a receipt clears the current missing-voucher declaration without discarding files or their VAT data', () => {
  const original = { ...expense(), missingReceiptReason: 'No tenía el ticket.', attachments: [{ id: 'a', name: 'Factura.pdf' }] };
  const result = applyReceiptRegistration(original, { hasReceipt: true, acknowledged: false, reason: '' });
  assert.equal(result.missingReceiptReason, undefined);
  assert.deepEqual(result.attachments, original.attachments);
  assert.equal(result.vatAmount, original.vatAmount);
  assert.equal(result.vatDeductibleAmount, original.vatDeductibleAmount);
  assert.equal(original.missingReceiptReason, 'No tenía el ticket.');
});

test('the list keeps an acknowledged gap visible for the gestor without keeping it operationally pending', () => {
  const registered = applyReceiptRegistration(expense(), { hasReceipt: false, acknowledged: true, reason: '<img onerror="x"> No pedimos ticket.' });
  const html = expensesPage({ expenses: [registered] }, { filter: 'all', query: '' });
  assert.match(html, /Sin justificante · IVA sin confirmar · para el gestor/);
  assert.match(html, /Sin justificante registrado/);
  assert.match(html, /data-expense-filter="review"[^>]*>Por revisar<span>0<\/span>/);
  assert.match(html, /Pagado/);
  assert.ok(!html.includes('<img onerror'));
});
