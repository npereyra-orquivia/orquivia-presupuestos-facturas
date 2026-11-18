import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPaymentTermsForm } from '../src/payment-terms-form.js';
import { validateDocument } from '../src/domain.js';

test('changing from days to custom conditions replaces the old value and removes form-only data', () => {
  const document = { paymentTerms: 30, paymentTermsChoice: 'custom' };
  applyPaymentTermsForm(document, { choice: 'custom', text: '  100 % el día de la visita  ' });
  assert.deepEqual(document, { paymentTermsText: '100 % el día de la visita' });
  applyPaymentTermsForm(document, { choice: '0', text: 'Texto que ya no se aplica' });
  assert.deepEqual(document, { paymentTerms: 0 });
});

test('editing operational fields on an issued legacy invoice preserves absent fiscal terms', () => {
  const original = { kind: 'invoice', status: 'issued', notes: 'Original' };
  const edited = { ...original, notes: 'Actualizada', paymentTermsChoice: '30', paymentTermsText: '' };
  applyPaymentTermsForm(edited, { choice: '30', text: '' }, original);
  assert.deepEqual(edited, { ...original, notes: 'Actualizada' });
  assert.equal(Object.hasOwn(original, 'paymentTerms'), false);
});

test('issued invoices retain original immediate and custom fields despite disabled form controls', () => {
  for (const terms of [{ paymentTerms: 0 }, { paymentTermsText: '100 % a la aceptación' },
    { paymentTerms: 45, paymentTermsText: 'Condición histórica' }]) {
    const original = { id: 'issued', ...terms };
    const edited = { ...original, paymentTermsChoice: '90', paymentTermsText: 'Cambio no permitido' };
    applyPaymentTermsForm(edited, { choice: '90', text: 'Cambio no permitido' }, original);
    assert.deepEqual(edited, original);
  }
});

test('empty custom conditions cannot be saved as a valid document', () => {
  const document = { kind: 'quote', status: 'draft', clientId: 'c', date: '2026-11-18',
    items: [{ description: 'Servicio', price: 100, quantity: 1 }] };
  applyPaymentTermsForm(document, { choice: 'custom', text: '   ' });
  assert.ok(validateDocument(document).some(message => /pago/i.test(message)));
});
