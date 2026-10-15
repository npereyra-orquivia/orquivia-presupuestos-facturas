import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMailRecipients, validateMailDraft, defaultMailDraft, mailRecipientSuggestions, renderMailSignature } from '../src/mail-domain.js';

const draft = (overrides = {}) => ({ to: ['client@example.test'], subject: 'Presupuesto', message: 'Hola,\n\nAdjunto el documento.', ...overrides });

test('recipient parser accepts strings and arrays with comma/semicolon delimiters, preserving first spelling', () => {
  assert.deepEqual(parseMailRecipients(' Nicole@Orquivia.com ; client@example.test, nicole@orquivia.com '), ['Nicole@Orquivia.com', 'client@example.test']);
  assert.deepEqual(parseMailRecipients([' one@example.test ', 'two@example.test; ONE@example.test']), ['one@example.test', 'two@example.test']);
  for (const empty of [undefined, null, '', '   ', []]) assert.deepEqual(parseMailRecipients(empty), []);
});

test('invalid or injected recipient fields are rejected as a whole, including leading/trailing controls', () => {
  const invalid = ['valid@example.test,invalid', ['valid@example.test', 'invalid'], 'Display Name <valid@example.test>',
    'a..b@example.test', 'a@example', 'a@-example.test', 'a@example.test,', ',a@example.test',
    'a@example.test;;b@example.test', [''], ['a@example.test', 42], 42, {},
    '\r\na@example.test', 'a@example.test\n', '\ta@example.test', 'a@example.test\0',
    'a@example.test\r\nBcc: hidden@example.test', 'a@example.test\u0085', 'a@example.test\u2028'];
  for (const value of invalid) {
    assert.throws(() => parseMailRecipients(value), /direcciones/);
    assert.equal(validateMailDraft(draft({ to: value })).ok, false);
    const copied = validateMailDraft(draft({ cc: value }));
    assert.equal(copied.ok, false);
    assert.ok(copied.errors.cc);
  }
});

test('drafts normalize To and CC together without duplicate envelope recipients', () => {
  const result = validateMailDraft(draft({ to: ' Client@example.test ; other@example.test ',
    cc: ['CLIENT@example.test', ' copy@example.test ', 'COPY@example.test'], subject: '  Documento  ', message: 'Hola\r\n\r\nAdjunto.' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { to: ['Client@example.test', 'other@example.test'], cc: ['copy@example.test'],
    subject: 'Documento', message: 'Hola\n\nAdjunto.' });
  assert.deepEqual(result.errors, {});
  assert.deepEqual(validateMailDraft(draft()).value.cc, []);
  assert.equal(validateMailDraft(draft({ to: [], cc: ['copy@example.test'] })).ok, false, 'CC cannot replace the required primary recipient');
  assert.equal(validateMailDraft(null).ok, false);
});

test('twenty distinct recipients is the combined limit after case-insensitive deduplication', () => {
  const recipients = Array.from({ length: 21 }, (_, i) => `person${i}@example.test`);
  assert.equal(validateMailDraft(draft({ to: recipients.slice(0, 20) })).ok, true);
  assert.equal(validateMailDraft(draft({ to: recipients })).ok, false);
  assert.equal(validateMailDraft(draft({ to: recipients.slice(0, 10), cc: recipients.slice(10, 20) })).ok, true);
  assert.equal(validateMailDraft(draft({ to: recipients.slice(0, 10), cc: recipients.slice(10) })).ok, false);
  const duplicated = validateMailDraft(draft({ to: recipients.slice(0, 20), cc: recipients.slice(0, 20).map(value => value.toUpperCase()) }));
  assert.equal(duplicated.ok, true);
  assert.equal(duplicated.value.to.length, 20);
  assert.deepEqual(duplicated.value.cc, []);
});

test('subject headers reject controls before trimming while multiline body remains ordinary content', () => {
  for (const subject of ['\nAsunto', 'Asunto\r', 'Asunto\r\nBcc: hidden@example.test', 'Asunto\u0000', 'Asunto\u0085']) {
    const result = validateMailDraft(draft({ subject }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.subject);
  }
  assert.equal(validateMailDraft(draft({ message: 'Primera línea\nBcc: texto en el cuerpo, no una cabecera\n\tDetalle' })).ok, true);
  assert.equal(validateMailDraft(draft({ message: 'Texto\0oculto' })).ok, false);
});

test('default drafts include CC and suggestions include valid copies in recent-first order', () => {
  const initial = defaultMailDraft({ kind: 'invoice', number: '2026-001' }, { email: 'client@example.test' });
  assert.deepEqual(initial.cc, []);
  assert.deepEqual(initial.to, ['client@example.test']);
  const history = [
    { createdAt: '2026-10-14T09:00:00Z', to: ['older@example.test'], cc: ['copy@example.test'] },
    { created_at: '2026-10-15T09:00:00Z', to: ['CLIENT@example.test'], cc: 'copy@example.test; other@example.test' },
    { createdAt: '2026-10-15T10:00:00Z', to: 'bad\r\nBcc: injected@example.test', cc: ['safe@example.test'] },
  ];
  assert.deepEqual(mailRecipientSuggestions(history), ['safe@example.test', 'CLIENT@example.test', 'copy@example.test', 'other@example.test', 'older@example.test']);
  assert.deepEqual(mailRecipientSuggestions(history, 2), ['safe@example.test', 'CLIENT@example.test']);
});

test('structured signature escapes user content and blocks executable logo or sender attributes', () => {
  const html = renderMailSignature({ name: '<script>alert("name")</script>', role: 'Dirección & "socias"', phone: '+34 600 000 000' },
    { email: 'nicole@example.test', logoUrl: 'javascript:alert(1)' });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('javascript:'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Dirección &amp; &quot;socias&quot;/);
  assert.match(html, /href="tel:\+34600000000"/);
  assert.match(html, /href="mailto:nicole@example.test"/);
  const injected = renderMailSignature({ name: 'Nicole', role: '', phone: '' }, { email: 'x@example.test" onclick="alert(1)', logoUrl: 'https://example.test/logo.png?title=" onerror="alert(1)' });
  assert.ok(!injected.includes('mailto:'));
  assert.ok(!injected.includes(' onerror="'));
});
