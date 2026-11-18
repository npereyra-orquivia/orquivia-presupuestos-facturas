import test from 'node:test';
import assert from 'node:assert/strict';
import { documentPaymentTerms, documentPaymentTermsLabel, paymentTermsLabel } from '../src/payment-terms.js';

test('payment days preserve an explicit immediate term and follow document, snapshot and company defaults', () => {
  const cases = [
    [{ paymentTerms: 0, companySnapshot: { paymentTerms: 15 } }, { paymentTerms: 30 }, 0],
    [{ paymentTerms: 7, companySnapshot: { paymentTerms: 15 } }, { paymentTerms: 30 }, 7],
    [{ companySnapshot: { paymentTerms: 0 } }, { paymentTerms: 30 }, 0],
    [{ companySnapshot: { paymentTerms: 15 } }, { paymentTerms: 30 }, 15],
    [{ companySnapshot: {} }, { paymentTerms: 15 }, 15],
    [{}, { paymentTerms: 0 }, 0],
    [{}, { paymentTerms: 30 }, 30],
    [{}, {}, 30],
    [{ paymentTerms: null }, { paymentTerms: 15 }, 15],
  ];
  for (const [document, company, expected] of cases) {
    const original = structuredClone({ document, company });
    assert.equal(documentPaymentTerms(document, company), expected);
    assert.deepEqual({ document, company }, original, 'Resolving a display default never mutates stored settings');
  }
});

test('numeric payment labels distinguish immediate, singular and plural terms', () => {
  assert.equal(paymentTermsLabel(0), 'Pago inmediato');
  assert.equal(paymentTermsLabel(1), '1 día desde la factura');
  assert.equal(paymentTermsLabel(30), '30 días desde la factura');
  assert.equal(paymentTermsLabel(365), '365 días desde la factura');
  assert.equal(documentPaymentTermsLabel({ companySnapshot: { paymentTerms: 15 } }), '15 días desde la factura');
});

test('custom conditions override numeric defaults without losing intentional empty editor values', () => {
  const document = { paymentTerms: 0, paymentTermsText: '  50 % a la aceptación y 50 % al finalizar.  ' };
  const original = structuredClone(document);
  assert.equal(documentPaymentTermsLabel(document, { paymentTerms: 30 }), '50 % a la aceptación y 50 % al finalizar.');
  assert.equal(documentPaymentTermsLabel({ paymentTermsText: '' }), 'Condiciones de pago por indicar');
  assert.equal(documentPaymentTermsLabel({ paymentTermsText: '   ' }), 'Condiciones de pago por indicar');
  assert.deepEqual(document, original);
});

test('malformed legacy numeric values have a safe display fallback', () => {
  for (const paymentTerms of [-1, 366, 1.5, '0', NaN, Infinity]) {
    assert.equal(documentPaymentTerms({ paymentTerms }), 30);
    assert.equal(paymentTermsLabel(paymentTerms), '30 días desde la factura');
  }
});
