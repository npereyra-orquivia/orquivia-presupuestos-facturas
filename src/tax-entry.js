export function taxPaymentLabel(record) {
  return ({ 'no-payment': 'Sin ingreso', unconfirmed: 'Pago por confirmar', pending: 'Pendiente de pago', paid: record.amount < 0 ? 'Devolución recibida' : 'Pagado', included: 'Incluido en pago al gestor' })[record.paymentStatus] || 'Por confirmar';
}

/** Only an explicit cash status adds a movement; changing it clears stale links and dates. */
export function taxFromFields(draft, values) {
  const next = { ...draft, model: String(values.model), year: Number(values.year), quarter: Number(values.quarter),
    date: values.date, amount: Number(values.amount), reference: String(values.reference || '').trim(), notes: String(values.notes || '').trim(),
    paymentStatus: Number(values.amount) === 0 ? 'no-payment' : values.paymentStatus };
  delete next.paidDate;
  delete next.linkedExpenseId;
  if (next.paymentStatus === 'paid') next.paidDate = values.paidDate;
  if (next.paymentStatus === 'included') next.linkedExpenseId = values.linkedExpenseId;
  return next;
}
