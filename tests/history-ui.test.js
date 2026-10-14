import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRecordHistory, captureFormDraft, changedRecordFields, compareWorkspaceEdits, renderConflictComparison, renderHistoryEntries, recordHistoryMarkup, captureOperationScope, runScopedOperation } from '../src/history-ui.js';

const workspace = () => ({ company: { name: 'Orquívia' }, clients: [], documents: [{ id: 'd1', number: '2026-001', kind: 'quote', notes: 'Original', items: [{ description: 'Inspección', quantity: 1, price: 100 }] }], payments: [], expenses: [{ id: 'e1', description: 'Gasto', total: 12, paymentStatus: 'paid' }] });

test('comparison distinguishes conflicting fields and preserves unrelated remote edits without merging them', () => {
  const base = workspace(), draft = structuredClone(base), remote = structuredClone(base);
  draft.documents[0].notes = 'Mi cambio'; remote.documents[0].notes = 'Cambio de Liliana'; remote.documents[0].dueDate = '2026-11-01';
  remote.expenses[0].total = 20;
  const before = JSON.stringify({ base, draft, remote }), rows = compareWorkspaceEdits(base, draft, remote);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entityId, 'd1');
  assert.deepEqual(rows[0].localFields, ['notes']);
  assert.deepEqual(rows[0].remoteFields, ['dueDate', 'notes']);
  assert.deepEqual(rows[0].overlappingFields, ['notes']);
  assert.equal(rows[0].latest.notes, 'Cambio de Liliana');
  assert.equal(JSON.stringify({ base, draft, remote }), before);
  assert.match(renderConflictComparison(rows), /editados en ambas sesiones/);
  assert.match(renderConflictComparison(rows), /Mi cambio/);
  assert.match(renderConflictComparison(rows), /Cambio de Liliana/);
});

test('equal changes in two sessions and key ordering do not create false field conflicts', () => {
  const base = workspace(), draft = structuredClone(base), remote = structuredClone(base);
  draft.documents[0].notes = 'Misma nota'; remote.documents[0].notes = 'Misma nota';
  remote.documents[0].items = [{ price: 100, quantity: 1, description: 'Inspección' }];
  const rows = compareWorkspaceEdits(base, draft, remote);
  assert.deepEqual(rows[0].overlappingFields, []);
  assert.deepEqual(rows[0].remoteFields, ['notes']);
  assert.deepEqual(changedRecordFields({ notes: 'A', po: 'Old' }, { notes: 'A' }), ['po']);
});

test('deleted and new records remain explicit in the comparison, including conflicts while issuing a saved draft', () => {
  const base = workspace(), draft = structuredClone(base), remote = structuredClone(base);
  draft.expenses[0].description = 'Mi texto'; remote.expenses = [];
  assert.match(renderConflictComparison(compareWorkspaceEdits(base, draft, remote)), /se ha eliminado/);
  draft.documents.push({ id: 'new', notes: 'Nuevo borrador' });
  assert.ok(compareWorkspaceEdits(base, draft, remote).some(row => row.entityId === 'new' && !row.before));
  assert.equal(compareWorkspaceEdits(base, base, remote, { documentId: 'd1' })[0].entityId, 'd1');
});

test('history and comparison escape source text, label fields, and never display arbitrary secret field values or receipt paths', () => {
  const html = renderHistoryEntries([{ actorEmail: '<img onerror=x>', event: 'issue', entityType: 'document', action: 'updated', changedFields: ['po', 'unknownSecret'], createdAt: '2026-10-14T16:00:00Z', workspaceVersion: 9 }]);
  assert.match(html, /Documento emitido/);
  assert.match(html, /Orden de pedido \(PO\)/);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('unknownSecret'));
  const base = workspace(), draft = structuredClone(base);
  draft.documents[0].unknownSecret = 'Never display this';
  draft.documents[0].items = [{ description: '<script>x</script>', quantity: 2, price: 10 }];
  draft.expenses[0].attachments = [{ id: 'file', name: 'Ticket.pdf', path: 'private/storage/path', size: 1000 }];
  const comparison = renderConflictComparison(compareWorkspaceEdits(base, draft, base));
  assert.ok(!comparison.includes('Never display this') && !comparison.includes('private/storage/path') && !comparison.includes('<script>'));
  assert.match(comparison, /Ticket.pdf/);
  assert.match(comparison, /2 ×/);
  assert.ok(recordHistoryMarkup('document', '"<unsafe>').includes('&quot;&lt;unsafe&gt;'));
});

test('a comparison preserves the paid total while keeping undisclosed VAT and its provisional base unconfirmed', () => {
  const base = workspace(); base.expenses = [];
  const draft = structuredClone(base);
  draft.expenses = [{ id: 'hotel', description: 'Hotel', total: 529, base: 529, vatAmount: 0, vatDeductibleAmount: 0, vatReviewNeeded: true, vatDocumentStatus: 'not-stated', paymentStatus: 'paid', cashAmount: 529 }];
  const html = renderConflictComparison(compareWorkspaceEdits(base, draft, draft));
  assert.match(html, /<th>Base imponible<\/th><td>Sin confirmar<\/td><td>Sin confirmar<\/td>/);
  assert.match(html, /<th>Importe de IVA<\/th><td>Sin confirmar<\/td><td>Sin confirmar<\/td>/);
  assert.match(html, /<th>IVA para el gestor<\/th><td>No confirmado<\/td><td>No confirmado<\/td>/);
  assert.match(html, /<th>Total<\/th><td>529,00/);
  assert.match(html, /<th>Importe pagado<\/th><td>529,00/);
  assert.match(html, /Justificante sin datos de IVA/);
});

function historyFixture() {
  const content = { innerHTML: '' }, refresh = { disabled: false, onclick: null };
  const details = { isConnected: true, open: true, dataset: { entityType: 'expense', entityId: 'e1' }, querySelector: name => name === '[data-history-content]' ? content : refresh };
  let identity = 'nicole', mode = 'cloud', resolve;
  const backend = { recordHistory: () => new Promise(done => resolve = done) };
  const root = { querySelectorAll: () => [details] }, ctx = { getMode: () => mode, getIdentity: () => identity, getBackend: () => backend };
  return { content, refresh, details, root, ctx, finish: entries => resolve(entries), changeAccount: () => identity = 'liliana', lock: () => mode = 'locked' };
}

test('an outstanding history read cannot reveal the prior account history after identity change or modal cleanup', async () => {
  for (const cancel of ['identity', 'cleanup', 'lock']) {
    const fixture = historyFixture(), dispose = bindRecordHistory(fixture.root, fixture.ctx), pending = fixture.refresh.onclick();
    assert.match(fixture.content.innerHTML, /Cargando historial/);
    if (cancel === 'identity') fixture.changeAccount(); else if (cancel === 'cleanup') dispose(); else fixture.lock();
    fixture.finish([{ actorEmail: 'private@example.com', entityType: 'expense', action: 'updated', changedFields: ['notes'], createdAt: '2026-10-14T16:00:00Z' }]);
    await pending;
    assert.ok(!fixture.content.innerHTML.includes('private@example.com'));
  }
});

test('the draft export preserves current form edits and checked values while omitting passwords and file content', () => {
  const input = (name, value, type = 'text', extra = {}) => ({ name, value, type, dataset: {}, getAttribute: () => null, ...extra });
  const controls = [input('notes', 'Último texto sin guardar'), input('alreadyPaid', 'on', 'checkbox', { checked: false }), input('password', 'secret', 'password'), input('receipt', '', 'file', { files: [{ name: 'Ticket.pdf', content: 'private binary' }] })];
  const form = { id: 'expense-form', querySelectorAll: () => controls }, root = { querySelectorAll: () => [form] };
  const result = captureFormDraft(root);
  assert.deepEqual(result[0].fields, [{ name: 'notes', value: 'Último texto sin guardar' }, { name: 'alreadyPaid', value: false }, { name: 'receipt', value: ['Ticket.pdf'] }]);
  assert.ok(!JSON.stringify(result).includes('secret') && !JSON.stringify(result).includes('private binary'));
});

test('late save or issue results after logout and relogin cannot recreate a previous draft, reveal it, or reset the new session busy flag', async () => {
  for (const result of ['conflict', 'success']) for (const switchType of ['other-account', 'same-account-new-session', 'new-backend']) {
    let account = 'nicole', mode = 'cloud', generation = 1, backend = {}, busy = true, state = 'Nicole state', conflict = null;
    const isCurrent = captureOperationScope({ getMode: () => mode, getIdentity: () => account, getBackend: () => backend, getGeneration: () => generation });
    let resolve, reject;
    const response = new Promise((done, failed) => { resolve = done; reject = failed; });
    const pending = runScopedOperation(isCurrent, () => response, {
      onSuccess: value => { state = value; return true; },
      onError: error => { if (error.code === 'VERSION_CONFLICT') conflict = 'Nicole private draft'; return false; },
      onFinally: () => busy = false,
    });
    if (switchType === 'other-account') { account = 'liliana'; generation++; }
    else if (switchType === 'same-account-new-session') generation++;
    else backend = {};
    state = 'Current account state'; busy = true; conflict = null;
    if (result === 'conflict') reject(Object.assign(new Error('VERSION_CONFLICT'), { code: 'VERSION_CONFLICT' })); else resolve('Nicole private state');
    assert.equal(await pending, false);
    assert.equal(state, 'Current account state');
    assert.equal(conflict, null);
    assert.equal(busy, true);
  }
});
