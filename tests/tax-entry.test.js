import test from 'node:test';
import assert from 'node:assert/strict';
import { taxFromFields, taxPaymentLabel } from '../src/tax-entry.js';

const fields = { model: '111', year: '2026', quarter: '3', date: '2026-10-14', amount: '0', reference: ' 1117884732474 ', notes: ' Presentada sin ingreso ', paymentStatus: 'paid', paidDate: '2026-10-14', linkedExpenseId: 'old-fee' };

test('zero declarations archive their result without retaining a prior cash date or expense link', () => {
  const draft = { id: 'tax-1', amount: 74.43, paymentStatus: 'included', linkedExpenseId: 'old-fee', paidDate: '2026-05-05', attachments: [{ id: 'file' }] };
  const next = taxFromFields(draft, fields);
  assert.equal(next.amount, 0);
  assert.equal(next.paymentStatus, 'no-payment');
  assert.equal(next.year, 2026);
  assert.equal(next.quarter, 3);
  assert.equal(next.reference, '1117884732474');
  assert.equal(next.notes, 'Presentada sin ingreso');
  assert.equal(Object.hasOwn(next, 'paidDate'), false);
  assert.equal(Object.hasOwn(next, 'linkedExpenseId'), false);
  assert.equal(taxPaymentLabel(next), 'Sin ingreso');
  assert.equal(draft.amount, 74.43);
  assert.equal(draft.linkedExpenseId, 'old-fee');
});

test('real tax payments, refunds and linked payments keep only the evidence required by their selected status', () => {
  const payment = taxFromFields({ id: 'tax-2', attachments: [] }, { ...fields, model: '303', quarter: '2', amount: '2195.98', date: '2026-07-13', paidDate: '2026-07-20' });
  assert.equal(payment.paidDate, '2026-07-20');
  assert.equal(payment.amount, 2195.98);
  assert.equal(Object.hasOwn(payment, 'linkedExpenseId'), false);
  const refund = taxFromFields(payment, { ...fields, amount: '-48.40', paymentStatus: 'paid' });
  assert.equal(taxPaymentLabel(refund), 'Devolución recibida');
  const linked = taxFromFields(payment, { ...fields, amount: '74.43', paymentStatus: 'included' });
  assert.equal(linked.linkedExpenseId, 'old-fee');
  assert.equal(Object.hasOwn(linked, 'paidDate'), false);
  const unconfirmed = taxFromFields(linked, { ...fields, amount: '74.43', paymentStatus: 'unconfirmed' });
  assert.equal(Object.hasOwn(unconfirmed, 'paidDate'), false);
  assert.equal(Object.hasOwn(unconfirmed, 'linkedExpenseId'), false);
});
