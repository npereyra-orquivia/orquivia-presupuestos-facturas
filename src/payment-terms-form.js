const fields = ['paymentTerms', 'paymentTermsText'];

/** Keep UI choices out of the saved JSON and preserve issued fiscal data exactly. */
export function applyPaymentTermsForm(document, { choice, text = '' }, original = null) {
  delete document.paymentTermsChoice;
  for (const key of fields) delete document[key];
  if (original) {
    for (const key of fields) {
      if (Object.hasOwn(original, key)) document[key] = original[key];
    }
  } else if (choice === 'custom') {
    document.paymentTermsText = text.trim();
  } else {
    document.paymentTerms = Number(choice);
  }
  return document;
}
