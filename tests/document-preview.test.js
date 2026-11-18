import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const cssHook = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('/document-preview.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { renderDocumentPreview } = await import('../src/document-preview.js');
cssHook.deregister();

const company = { name: 'Orquivia', iban: 'ES00 0000 0000 0000 0000 0000', paymentTerms: 30 };
const document = overrides => ({
  kind: 'quote', date: '2026-10-15', dueDate: '2026-11-15',
  items: [{ description: 'Servicio de ejemplo', quantity: 1, price: 6000 }],
  vat: 21, ...overrides,
});

test('preview shows immediate document terms alongside method and account without changing totals', () => {
  const html = renderDocumentPreview(document({ paymentTerms: 0 }), { company });
  assert.match(html, /<strong>Plazo de pago<\/strong><span>Pago inmediato<\/span>/);
  assert.match(html, /<strong>Método de pago<\/strong>/);
  assert.match(html, /<strong>Cuenta bancaria<\/strong>/);
  assert.doesNotMatch(html, /30 días desde la factura/);
  assert.match(html, /6\.000,00(?:\s|&nbsp;|\u00a0)*€/);
  assert.match(html, /IVA no incluido/);
});

test('preview follows frozen payment terms and preserves dated legacy invoice terms', () => {
  const quote = renderDocumentPreview(document({ companySnapshot: { paymentTerms: 15 } }), { company });
  assert.match(quote, /15 días desde la factura/);
  const invoice = renderDocumentPreview(document({ kind: 'invoice' }), { company });
  assert.match(invoice, /<strong>Plazo de pago<\/strong><span>Hasta 15 nov 2026<\/span>/);
  const immediate = renderDocumentPreview(document({ kind: 'invoice', paymentTerms: 0 }), { company });
  assert.match(immediate, /<strong>Plazo de pago<\/strong><span>Pago inmediato<\/span>/);
  assert.match(immediate, /Vencimiento de pago: 15 nov 2026/);
});

test('preview renders custom conditions as escaped text for quotes and invoices', () => {
  for (const kind of ['quote', 'invoice']) {
    const doc = document({ kind, paymentTerms: 0, paymentTermsText: '50 % <aceptar> & "confirmar"' });
    const original = structuredClone(doc);
    const html = renderDocumentPreview(doc, { company });
    assert.match(html, /50 % &lt;aceptar&gt; &amp; &quot;confirmar&quot;/);
    assert.doesNotMatch(html, /<aceptar>|Pago inmediato/);
    assert.deepEqual(doc, original);
  }
  const empty = renderDocumentPreview(document({ paymentTermsText: '' }), { company });
  assert.match(empty, /Condiciones de pago por indicar/);
});
