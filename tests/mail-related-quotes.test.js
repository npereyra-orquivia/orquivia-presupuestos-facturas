import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedQuoteOptions, validateRelatedQuotes, renderRelatedQuotes, renderRelatedQuotePreviews } from '../src/mail-related-quotes.js';
import { bindMailComposer, renderMailComposer } from '../src/mail-ui.js';

const quote = (id, overrides = {}) => ({ id, kind: 'quote', clientId: 'client-1', status: 'ready', number: `PR-2026-${id}`,
  date: '2026-11-16', vat: 21, discount: 0, withholding: 0, items: [{ description: 'Servicio', quantity: 1, price: 3000 }], ...overrides });
const primary = quote('001');
const profile = { connected: true, email: 'sender@example.test', signature: { name: 'Nombre', role: 'Dirección' } };
const mailDraft = { to: ['client@example.test'], cc: [], subject: 'Alternativas', message: 'Buenos días,\nAdjunto las alternativas.', idempotencyKey: 'related-send' };

test('quote choices are separate prepared or sent documents of the same client in natural newest order', () => {
  const eligible = [quote('002'), quote('010', { status: 'sent' }), quote('003', { date: '2026-11-15' })];
  const documents = [...eligible, primary, quote('foreign', { clientId: 'other' }), quote('invoice', { kind: 'invoice' }),
    quote('draft', { status: 'draft' }), quote('accepted', { status: 'accepted' }), quote('rejected', { status: 'rejected' }), quote('blank', { number: ' ' })];
  const before = JSON.stringify(documents);
  assert.deepEqual(relatedQuoteOptions(primary, documents).map(value => value.id), ['010', '002', '003']);
  assert.equal(JSON.stringify(documents), before, 'Sorting cannot reorder or mutate the workspace');
  assert.deepEqual(relatedQuoteOptions({ ...primary, kind: 'invoice' }, documents), []);
});

test('related IDs are unique, bounded, accessible and sorted for the same idempotent request', () => {
  const options = ['b', 'a', 'c', 'd', 'e'].map(id => quote(id));
  assert.deepEqual(validateRelatedQuotes(['b', 'a'], primary, options), ['a', 'b']);
  assert.deepEqual(validateRelatedQuotes([], { ...primary, kind: 'invoice' }), []);
  for (const ids of [['a', 'a'], ['a', 'b', 'c', 'd', 'e'], [''], [null], 'a']) {
    assert.throws(() => validateRelatedQuotes(ids, primary, options), /cuatro presupuestos adicionales distintos/);
  }
  for (const invalid of [quote('gone', { status: 'draft' }), quote('foreign', { clientId: 'other' }), quote('invoice', { kind: 'invoice' }), primary]) {
    assert.throws(() => validateRelatedQuotes([invalid.id], primary, [...options, invalid]), /ha cambiado o ya no está disponible/);
  }
  assert.throws(() => validateRelatedQuotes(['missing'], primary, options), /ha cambiado o ya no está disponible/);
  assert.throws(() => validateRelatedQuotes(['a'], { ...primary, kind: 'invoice' }, options), /solo se incluyen al enviar un presupuesto/);
});

test('related quote choices preserve pre-VAT prices, escape all source fields and keep official PDFs separate from generic files', () => {
  const hostile = quote('002" onclick="bad', { number: '<script>PR-2026-002</script>', title: '<img onerror=bad>', items: [{ quantity: 1, price: 6000 }] });
  const html = renderRelatedQuotes({ ...primary, number: '<svg>primary</svg>' }, [hostile], [hostile.id]);
  assert.match(html, /6\.000,00/);
  assert.ok(!html.includes('7.260,00'));
  assert.match(html, /&lt;script&gt;PR-2026-002&lt;\/script&gt;/);
  assert.match(html, /&lt;img onerror=bad&gt;/);
  assert.match(html, /value="002&quot; onclick=&quot;bad" checked/);
  assert.ok(!/<(?:script|svg|img)\b/.test(html));
  assert.match(html, /Un único envío quedará registrado/);
  assert.match(renderRelatedQuotes(primary), /No hay otros presupuestos/);
  assert.equal(renderRelatedQuotes({ ...primary, kind: 'invoice' }, [hostile]), '');
  const composer = renderMailComposer({ document: primary, relatedQuotes: [hostile], profile, draft: mailDraft });
  assert.match(composer, /data-related-quote/);
  assert.ok(!composer.includes('data-mail-attachments-input'));
  const preview = renderRelatedQuotePreviews([hostile], value => `<p>Official ${value.id.length}</p>`);
  assert.match(preview, /<details class="mail-related-preview">/);
  assert.match(preview, /&lt;script&gt;/);
  assert.match(preview, /Official/);
});

function relatedBindingFixture({ selected = [], options = [quote('002'), quote('003')], savedDraft = {}, readonly = false } = {}) {
  const saved = [], sent = [], feedback = { textContent: '' }, messagePreview = { innerHTML: '' }, relatedPreviews = { innerHTML: '' };
  const choices = options.map(value => ({ value: value.id, checked: selected.includes(value.id), disabled: false }));
  const elements = Object.fromEntries(['to', 'cc', 'subject', 'message'].map(name => [name, { value: Array.isArray(mailDraft[name]) ? mailDraft[name].join(', ') : mailDraft[name], disabled: false }]));
  const send = { disabled: false, remove() { this.removed = true; } };
  const inputs = [...Object.values(elements), ...choices];
  const form = { dataset: readonly ? { mailReadonly: 'true' } : {}, elements, addEventListener() {}, removeEventListener() {},
    querySelector: selector => selector === '[data-mail-message-preview]' ? messagePreview : null,
    querySelectorAll: () => inputs };
  const selectors = { '#mail-compose-form': form, '[data-send-mail]': send, '[data-mail-feedback]': feedback, '[data-related-mail-previews]': relatedPreviews };
  const root = { querySelector: selector => selectors[selector] || null,
    querySelectorAll: selector => selector === '[data-related-quote]' ? choices : selector.startsWith('button:not') ? [send, ...inputs] : [] };
  let current = true;
  const ctx = { profile, document: primary, relatedQuotes: options, draft: { ...mailDraft, relatedDocumentIds: selected, ...savedDraft },
    relatedPreview: ids => `PDF:${ids.join(',')}`, isCurrent: () => current,
    onDraftChange: value => saved.push(structuredClone(value)), send: async value => { sent.push(value); return { job: { status: 'sent' } }; } };
  const dispose = bindMailComposer(root, ctx);
  return { choices, ctx, form, send, saved, sent, feedback, relatedPreviews, dispose, changeSession: () => { current = false; } };
}

test('selecting another official quote retains current message edits, prepares its preview locally and sends only on explicit Send', async () => {
  const f = relatedBindingFixture();
  f.form.elements.subject.value = 'Dos alternativas revisadas';
  f.form.elements.message.value = 'Texto personal pendiente de envío';
  f.form.oninput();
  f.choices[0].checked = true; f.choices[0].onchange();
  assert.equal(f.sent.length, 0);
  assert.equal(f.saved.at(-1).subject, 'Dos alternativas revisadas');
  assert.equal(f.saved.at(-1).message, 'Texto personal pendiente de envío');
  assert.deepEqual(f.saved.at(-1).relatedDocumentIds, ['002']);
  assert.equal(f.relatedPreviews.innerHTML, 'PDF:002');
  assert.match(f.feedback.textContent, /2 PDF preparados/);
  await f.send.onclick(); await f.send.onclick();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].relatedDocumentIds, ['002']);
  assert.equal(f.sent[0].subject, 'Dos alternativas revisadas');
  assert.equal(f.sent[0].message, 'Texto personal pendiente de envío');
  assert.equal(f.sent[0].idempotencyKey, 'related-send');
  assert.equal(f.sent[0].attachments, undefined);
  assert.equal(f.send.removed, true);
  f.dispose();
});

test('removing a selection is saved explicitly and an ordinary quote send retains the legacy request shape', async () => {
  const f = relatedBindingFixture({ selected: ['002'] });
  f.choices[0].checked = false; f.choices[0].onchange();
  assert.deepEqual(f.saved.at(-1).relatedDocumentIds, []);
  await f.send.onclick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].relatedDocumentIds, undefined);
  assert.equal(f.sent[0].attachments, undefined);
  f.dispose();
});

test('stale saved selections fail closed instead of silently omitting a promised PDF', async () => {
  for (const savedDraft of [{ relatedDocumentIds: ['missing'] }, { relatedDocumentIds: ['002', '002'] }]) {
    const f = relatedBindingFixture({ savedDraft });
    await f.send.onclick();
    assert.equal(f.sent.length, 0);
    assert.match(f.feedback.textContent, /ha cambiado|distintos/);
    assert.equal(f.send.removed, undefined);
    f.dispose();
  }
});

test('the fifth selection is reverted and locked, closed or previous-session composers cannot change selections', () => {
  const options = ['a', 'b', 'c', 'd', 'e'].map(id => quote(id));
  const full = relatedBindingFixture({ options, selected: ['a', 'b', 'c', 'd'] });
  full.choices[4].checked = true; full.choices[4].onchange();
  assert.equal(full.choices[4].checked, false);
  assert.match(full.feedback.textContent, /cuatro/);
  assert.equal(full.saved.length, 0);
  full.dispose();
  for (const reason of ['readonly', 'close', 'session']) {
    const f = relatedBindingFixture({ readonly: reason === 'readonly' });
    if (reason === 'close') f.dispose();
    if (reason === 'session') f.changeSession();
    f.choices[0].checked = true; f.choices[0].onchange();
    assert.equal(f.saved.length, 0);
    assert.equal(f.relatedPreviews.innerHTML, '');
    assert.equal(f.sent.length, 0);
    f.dispose();
  }
});
