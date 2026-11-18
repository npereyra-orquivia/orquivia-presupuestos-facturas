const validDays = value => Number.isInteger(value) && value >= 0 && value <= 365;

/** A document may override the frozen company default; zero means immediate. */
export function documentPaymentTerms(document = {}, company = {}) {
  const days = document.paymentTerms ?? document.companySnapshot?.paymentTerms ?? company.paymentTerms ?? 30;
  return validDays(days) ? days : 30;
}

export function paymentTermsLabel(value) {
  const days = validDays(value) ? value : 30;
  return days === 0 ? 'Pago inmediato' : `${days} ${days === 1 ? 'día' : 'días'} desde la factura`;
}

export function documentPaymentTermsLabel(document = {}, company = {}) {
  if (typeof document.paymentTermsText === 'string') {
    return document.paymentTermsText.trim() || 'Condiciones de pago por indicar';
  }
  return paymentTermsLabel(documentPaymentTerms(document, company));
}
