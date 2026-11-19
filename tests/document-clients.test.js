import test from 'node:test';
import assert from 'node:assert/strict';
import { documentClient, syncDocumentClients, resumeDocumentWithClient } from '../src/document-clients.js';
import { createInvoiceFromQuote } from '../src/domain.js';

const client = (extra = {}) => ({ id: 'client-1', name: 'Original', taxId: 'A12345678',
  address: 'Calle original 1', email: 'contact@example.test', billingEmail: 'billing@example.test', ...extra });
const quote = (extra = {}) => ({ id: 'quote-1', kind: 'quote', status: 'ready', clientId: 'client-1',
  number: 'PR-2026-001', date: '2026-11-19', items: [{ description: 'Servicio', quantity: 1, price: 100 }], ...extra });
const invoice = (extra = {}) => ({ ...quote(), id: 'invoice-1', kind: 'invoice', status: 'issued',
  number: 'F-2026-001', deliveryStatus: 'ready', ...extra });
const workspace = (documents, clients = [client()]) => ({ clients, documents });
const revisedClient = () => client({ name: 'Actualizado', taxId: 'B98765432', address: 'Calle nueva 2',
  email: 'new-contact@example.test', billingEmail: 'new-billing@example.test' });

test('resuming an unsaved draft preserves its lines and custom recipient while refreshing the selected party', () => {
  const editor = invoice({ status: 'draft', clientSnapshot: client(), billingEmail: 'custom@example.test',
    items: [{ description: 'Cambio aún sin guardar', quantity: 2, price: 3000 }] });
  const original = structuredClone(editor);
  const resumed = resumeDocumentWithClient(editor, revisedClient(), { previousClient: client(),
    persistedDocument: { ...editor, clientSnapshot: revisedClient(), billingEmail: 'new-billing@example.test' } });
  assert.deepEqual(resumed.items, original.items);
  assert.equal(resumed.billingEmail, 'custom@example.test');
  assert.equal(Object.hasOwn(resumed, 'clientSnapshot'), false);
  assert.deepEqual(editor, original);
});

test('resuming a newly selected client never restores the saved document’s different party or recipient', () => {
  const selected = revisedClient();
  const persisted = invoice({ status: 'draft', clientId: 'different-client', clientSnapshot: { name: 'Otra empresa' }, billingEmail: 'other@example.test' });
  const editor = { ...persisted, clientId: selected.id, billingEmail: client().billingEmail };
  const resumed = resumeDocumentWithClient(editor, selected, { previousClient: client(), persistedDocument: persisted });
  assert.equal(resumed.clientId, selected.id);
  assert.equal(resumed.billingEmail, selected.billingEmail);
  assert.equal(Object.hasOwn(resumed, 'clientSnapshot'), false);
  const prepared = resumeDocumentWithClient(quote(), selected, { previousClient: client(),
    persistedDocument: { ...quote(), clientId: 'different-client', clientSnapshot: { name: 'Otra empresa' } } });
  assert.deepEqual(prepared.clientSnapshot, selected);
});

test('resuming a historical document adopts the canonical frozen party rather than the changed master', () => {
  const persisted = invoice({ clientSnapshot: client(), billingEmail: 'custom@example.test' });
  const resumed = resumeDocumentWithClient(persisted, revisedClient(), { previousClient: client(), persistedDocument: persisted });
  assert.deepEqual(resumed, persisted);
  const prepared = { ...persisted, billingEmail: client().billingEmail };
  const canonical = { ...prepared, billingEmail: revisedClient().billingEmail };
  const ready = resumeDocumentWithClient(prepared, revisedClient(), { previousClient: client(), persistedDocument: canonical });
  assert.deepEqual(ready.clientSnapshot, client());
  assert.equal(ready.billingEmail, revisedClient().billingEmail);
});

test('an explicitly cleared recipient stays empty when returning from an inline master edit', () => {
  for (const status of ['draft', 'issued']) {
    const persisted = invoice({ status, billingEmail: 'custom@example.test', clientSnapshot: client() });
    const editor = { ...persisted };
    delete editor.billingEmail;
    const resumed = resumeDocumentWithClient(editor, revisedClient(), { previousClient: client(), persistedDocument: persisted });
    assert.equal(Object.hasOwn(resumed, 'billingEmail'), false);
  }
});

test('a converted draft discards the source quote party snapshot before any rendering or save', () => {
  const source = quote({ status: 'sent', clientSnapshot: client() });
  const converted = createInvoiceFromQuote(source, [], '2026-11-19');
  assert.equal(Object.hasOwn(converted, 'clientSnapshot'), false);
  assert.deepEqual(source.clientSnapshot, client());
  assert.deepEqual(documentClient(converted, [revisedClient()]), revisedClient());
});

test('an unmailed prepared quote and its linked draft invoice both follow the updated party', () => {
  const source = quote({ clientSnapshot: client() });
  const draft = invoice({ status: 'draft', quoteId: source.id, clientSnapshot: client() });
  const previous = workspace([source, draft]);
  const next = structuredClone(previous);
  next.clients = [revisedClient()];
  syncDocumentClients(previous, next);
  assert.deepEqual(next.documents[0].clientSnapshot, revisedClient());
  assert.equal(Object.hasOwn(next.documents[1], 'clientSnapshot'), false);
  assert.deepEqual(documentClient(next.documents[1], next.clients), revisedClient());
});

test('draft client resolution prefers the live party and historical documents prefer their snapshot', () => {
  const frozen = client({ name: 'Snapshot anterior' }), live = revisedClient();
  for (const kind of ['quote', 'invoice']) {
    assert.equal(documentClient({ kind, status: 'draft', clientId: live.id, clientSnapshot: frozen }, [live]), live);
    assert.equal(documentClient({ kind, status: 'draft', clientId: live.id, clientSnapshot: frozen }, []), frozen);
    assert.equal(documentClient({ kind, status: 'ready', clientId: live.id, clientSnapshot: frozen }, [live]), frozen);
    assert.equal(documentClient({ kind, status: 'ready', clientId: live.id }, [live]), live);
  }
  assert.deepEqual(documentClient({ clientId: 'deleted' }, []), { name: 'Cliente eliminado' });
});

test('saving clears stale copied snapshots from quote and invoice drafts even without a master edit', () => {
  const previous = workspace([quote({ status: 'draft', clientSnapshot: client({ name: 'Obsoleto' }) }),
    invoice({ status: 'draft', clientSnapshot: client({ name: 'Obsoleto' }) })]);
  const next = structuredClone(previous), original = structuredClone(previous);
  assert.equal(syncDocumentClients(previous, next), next);
  for (const doc of next.documents) assert.equal(Object.hasOwn(doc, 'clientSnapshot'), false);
  assert.deepEqual(previous, original);
});

test('ready quotes refresh the full party snapshot on every save and copy it independently', () => {
  const previous = workspace([quote({ clientSnapshot: client({ name: 'Snapshot obsoleto' }), companySnapshot: { name: 'Empresa' } })]);
  const next = structuredClone(previous);
  syncDocumentClients(previous, next);
  assert.deepEqual(next.documents[0].clientSnapshot, client(), 'an ordinary save repairs a stale ready snapshot');
  next.clients = [revisedClient()];
  syncDocumentClients(previous, next);
  assert.deepEqual(next.documents[0].clientSnapshot, revisedClient());
  assert.deepEqual(next.documents[0].companySnapshot, { name: 'Empresa' });
  next.clients[0].name = 'Otro cambio';
  assert.equal(next.documents[0].clientSnapshot.name, 'Actualizado');
});

test('sent, accepted and rejected quotes keep their own snapshot when the master client changes', () => {
  for (const status of ['sent', 'accepted', 'rejected']) {
    const frozen = client({ name: `Cliente ${status}` });
    const previous = workspace([quote({ status, clientSnapshot: frozen })]);
    const next = structuredClone(previous);
    next.clients = [revisedClient()];
    syncDocumentClients(previous, next);
    assert.deepEqual(next.documents[0].clientSnapshot, frozen);
  }
});

test('protected legacy quotes capture the old party and retain a server-provided snapshot', () => {
  const previous = workspace([quote({ status: 'sent' }), invoice()]);
  const next = structuredClone(previous);
  next.clients = [revisedClient()];
  syncDocumentClients(previous, next);
  assert.deepEqual(next.documents[0].clientSnapshot, client());
  assert.equal(Object.hasOwn(next.documents[1], 'clientSnapshot'), false,
    'legacy issued invoice fiscal data must not acquire a snapshot');
  const serverSnapshot = client({ name: 'Snapshot del servidor' });
  next.documents[0].clientSnapshot = serverSnapshot;
  syncDocumentClients(previous, next);
  assert.equal(next.documents[0].clientSnapshot, serverSnapshot);
});

test('in-flight document locks leave a legacy quote unchanged even when it has no snapshot', () => {
  const previous = workspace([quote({ status: 'sent' })]);
  const next = workspace(structuredClone(previous.documents), [revisedClient()]);
  syncDocumentClients(previous, next, { lockedDocumentIds: ['quote-1'] });
  assert.deepEqual(next.documents, previous.documents);
});

test('ready quote history locks, previous sent state and invoice links prevent party refresh', () => {
  const frozen = client({ name: 'Cliente protegido' });
  const cases = [
    { options: { lockedQuoteIds: ['quote-1'] } },
    { options: { lockedDocumentIds: ['quote-1'] } },
    { previousStatus: 'sent' },
    { previousStatus: 'accepted' },
    { previousStatus: 'rejected' },
    { previousInvoice: true },
    { nextInvoice: true },
  ];
  for (const scenario of cases) {
    const previous = workspace([quote({ status: scenario.previousStatus || 'ready', clientSnapshot: frozen })]);
    if (scenario.previousInvoice) previous.documents.push(invoice({ quoteId: 'quote-1' }));
    const next = workspace([quote({ clientSnapshot: frozen })], [revisedClient()]);
    if (scenario.nextInvoice) next.documents.push(invoice({ quoteId: 'quote-1' }));
    syncDocumentClients(previous, next, scenario.options);
    assert.deepEqual(next.documents[0].clientSnapshot, frozen, JSON.stringify(scenario));
  }
});

test('draft invoice billing follows a changed master default while explicit recipients survive', () => {
  for (const billingEmail of [undefined, '', client().billingEmail, 'custom@example.test']) {
    const previous = workspace([invoice({ status: 'draft', billingEmail })]);
    const next = structuredClone(previous);
    next.clients = [revisedClient()];
    syncDocumentClients(previous, next);
    assert.equal(next.documents[0].billingEmail, billingEmail === 'custom@example.test' ? billingEmail : revisedClient().billingEmail);
  }
  const oldClient = client({ billingEmail: '' }), newClient = revisedClient();
  delete newClient.billingEmail;
  const previous = workspace([invoice({ status: 'draft', billingEmail: oldClient.email })], [oldClient]);
  const next = workspace(structuredClone(previous.documents), [newClient]);
  syncDocumentClients(previous, next);
  assert.equal(next.documents[0].billingEmail, newClient.email, 'contact email is the fallback billing default');
});

test('billing is only synchronized after a master edit and preserves a recipient edited in the same save', () => {
  const previous = workspace([invoice({ status: 'draft' })]);
  const next = structuredClone(previous);
  next.clients = [{ billingEmail: client().billingEmail, email: client().email, address: client().address,
    taxId: client().taxId, name: client().name, id: client().id }];
  syncDocumentClients(previous, next);
  assert.equal(Object.hasOwn(next.documents[0], 'billingEmail'), false, 'property order is not a master edit');
  next.clients = [revisedClient()];
  next.documents[0].billingEmail = 'manually-edited@example.test';
  syncDocumentClients(previous, next);
  assert.equal(next.documents[0].billingEmail, 'manually-edited@example.test');
});

test('unsent issued invoices update only the default billing recipient and retain all fiscal fields', () => {
  for (const status of ['issued', 'partial', 'paid', 'overdue']) {
    const previous = workspace([invoice({ status, billingEmail: client().billingEmail,
      clientSnapshot: client(), companySnapshot: { name: 'Empresa original' },
      po: 'PO-001', notes: 'Condiciones', vat: 21, discount: 10, withholding: 15 })]);
    const next = structuredClone(previous), original = structuredClone(previous.documents[0]);
    next.clients = [revisedClient()];
    syncDocumentClients(previous, next);
    assert.deepEqual(next.documents[0], { ...original, billingEmail: revisedClient().billingEmail });
  }
  for (const extra of [{ deliveryStatus: 'sent' }, { deliveryStatus: undefined }, { deliveryStatus: 'ready' }]) {
    const previous = workspace([invoice({ ...extra, billingEmail: client().billingEmail, clientSnapshot: client() })]);
    const next = structuredClone(previous);
    next.clients = [revisedClient()];
    const options = extra.deliveryStatus === 'ready' ? { lockedDocumentIds: ['invoice-1'] } : {};
    syncDocumentClients(previous, next, options);
    assert.deepEqual(next.documents[0], previous.documents[0]);
  }
});

test('conversion drafts resolve the updated client while the original accepted quote remains frozen', () => {
  const accepted = quote({ status: 'accepted', clientSnapshot: client(), companySnapshot: { name: 'Empresa' } });
  const converted = createInvoiceFromQuote(accepted, [], '2026-11-19');
  const previous = workspace([accepted], [revisedClient()]);
  const next = workspace([structuredClone(accepted), converted], [revisedClient()]);
  syncDocumentClients(previous, next);
  assert.equal(Object.hasOwn(converted, 'clientSnapshot'), false);
  assert.equal(documentClient(converted, next.clients), next.clients[0]);
  assert.deepEqual(next.documents[0].clientSnapshot, client());
  assert.deepEqual(accepted.clientSnapshot, client());
});
