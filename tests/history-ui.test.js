import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRecordHistory, captureFormDraft, changedRecordFields, compareWorkspaceEdits, renderConflictComparison, renderHistoryEntries, recordHistoryMarkup, captureOperationScope, runScopedOperation, mergeRecordHistory, renderUnifiedHistory } from '../src/history-ui.js';

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

const change = (overrides = {}) => ({ id: 1, entityType: 'document', entityId: 'quote-1', action: 'updated',
  event: 'save', actorEmail: 'nicole@example.test', changedFields: ['notes'], workspaceVersion: 14,
  createdAt: '2026-10-16T09:00:00Z', ...overrides });
const mailJob = (overrides = {}) => ({ id: 'mail-1', documentId: 'quote-1', sender: 'nicole@example.test',
  to: ['client@example.test'], cc: ['copy@example.test'], subject: 'Presupuesto de prueba', status: 'sent',
  createdAt: '2026-10-16T09:59:00Z', sentAt: '2026-10-16T10:00:00Z', ...overrides });

test('the unified timeline orders edits and every mail outcome by event date with stable identities and safe field projection', () => {
  const changes = [change({ id: 2, createdAt: '2026-10-16T11:00:00Z' }), change()];
  const jobs = [mailJob({ id: 'failed', status: 'failed', sentAt: null, createdAt: '2026-10-16T12:00:00Z' }),
    mailJob({ id: 'uncertain', status: 'uncertain', sentAt: null, createdAt: '2026-10-16T10:30:00Z' }),
    mailJob({ raw: 'PRIVATE_MIME_BYTES', password: 'PRIVATE_PASSWORD', document_snapshot: { notes: 'PRIVATE_SNAPSHOT' } })];
  const before = JSON.stringify({ changes, jobs }), timeline = mergeRecordHistory(changes, jobs);
  assert.deepEqual(timeline.map(entry => entry.id), ['mail:failed', 'change:2', 'mail:uncertain', 'mail:mail-1', 'change:1']);
  assert.deepEqual(mergeRecordHistory([...changes].reverse(), [...jobs].reverse()).map(entry => entry.id), timeline.map(entry => entry.id));
  assert.equal(JSON.stringify({ changes, jobs }), before);
  assert.ok(!JSON.stringify(timeline).includes('PRIVATE_'));
  const html = renderUnifiedHistory(changes, jobs);
  assert.equal((html.match(/<ol\b/g) || []).length, 1, 'Changes and mail belong to one chronological list');
  assert.ok(html.indexOf('mail:failed') < html.indexOf('change:2'));
  assert.match(html, /Correo no enviado/);
  assert.match(html, /Resultado del envío por confirmar/);
  assert.match(html, /client@example.test/);
  assert.match(html, /copy@example.test/);
  assert.match(html, /Presupuesto de prueba/);
  assert.ok(!html.includes('PRIVATE_'));
  assert.throws(() => mergeRecordHistory([], [mailJob({ id: '' })]), /historial de envíos/);
  assert.equal(mergeRecordHistory([], [jobs[0], jobs[0]]).length, 1, 'A duplicate copy of the same job ID is still one mail attempt');
});

test('only a matching automatic status-only email audit is absorbed and its version remains on the mail entry', () => {
  const automatic = change({ id: 90, event: 'email_sent', changedFields: ['status'], createdAt: '2026-10-16T10:00:02Z' });
  const preserved = [change({ id: 91, changedFields: ['status'], createdAt: automatic.createdAt }),
    change({ id: 92, event: 'email_sent', changedFields: ['status', 'po'], createdAt: automatic.createdAt }),
    change({ id: 93, event: 'email_sent', changedFields: ['status'], actorEmail: 'liliana@example.test', createdAt: automatic.createdAt }),
    change({ id: 94, event: 'email_sent', changedFields: ['status'], createdAt: '2026-10-16T10:00:06Z' }),
    change({ id: 95, entityId: 'another-quote', event: 'email_sent', changedFields: ['status'], createdAt: automatic.createdAt })];
  const timeline = mergeRecordHistory([automatic, ...preserved], [mailJob({ sender: 'NICOLE@example.test' })]);
  assert.equal(timeline.length, preserved.length + 1);
  assert.deepEqual(timeline.filter(entry => entry.kind === 'change').map(entry => entry.historyId).sort(), preserved.map(entry => entry.id).sort());
  const mailed = timeline.find(entry => entry.kind === 'mail');
  assert.deepEqual(mailed.stateChange, { historyId: 90, workspaceVersion: 14, actorEmail: 'nicole@example.test',
    changedFields: ['status'], createdAt: automatic.createdAt });
  const html = renderUnifiedHistory([automatic], [mailJob()]);
  assert.match(html, /versión 14/);
  assert.match(html, /data-history-audit-id="90"/);
  assert.ok(!html.includes('Documento actualizado'), 'The automatic state update is represented by its mail, not a redundant generic entry');
  assert.equal(mergeRecordHistory([automatic], [mailJob({ status: 'uncertain', errorCode: 'SMTP_PARTIAL' })]).length, 2);
  assert.equal(mergeRecordHistory([automatic], [mailJob({ id: 'one' }), mailJob({ id: 'two' })]).length, 3, 'An ambiguous pairing must preserve the audit');
});

test('mail audit rendering escapes IDs, sender, recipients and subject and shows partial/archive warnings without inventing success', () => {
  const hostile = mailJob({ id: 'mail-"<unsafe>', sender: '<img onerror=x>', to: ['<script>client</script>'],
    cc: ['copy" onclick="x'], subject: '<svg onload=x>', status: 'uncertain', errorCode: 'SMTP_PARTIAL',
    accepted: ['accepted@example.test'], rejected: ['<img rejected>'] });
  const html = renderUnifiedHistory([], [hostile, mailJob({ id: 'archive', status: 'archive_pending' })]);
  assert.ok(!/<(?:script|img|svg)\b/.test(html));
  assert.match(html, /&lt;img onerror=x&gt;/);
  assert.match(html, /&lt;svg onload=x&gt;/);
  assert.match(html, /mail:mail-&quot;&lt;unsafe&gt;/);
  assert.match(html, /Envío parcial · por revisar/);
  assert.match(html, /accepted@example.test/);
  assert.match(html, /&lt;img rejected&gt;/);
  assert.match(html, /Correo enviado · copia pendiente/);
  assert.ok(!html.includes('guardado su copia en Enviados'), 'Neither a partial attempt nor pending archival confirms a saved copy');
  assert.match(recordHistoryMarkup('document', 'quote-1', { includeMail: true }), /data-include-mail="true"/);
  assert.match(recordHistoryMarkup('document', 'quote-1', { includeMail: true }), /Historial de cambios y envíos/);
  assert.ok(!recordHistoryMarkup('expense', 'expense-1').includes('data-include-mail'));
});

test('invoice mail history projects attachment metadata without raw content and explains preparation limits', () => {
  const job = mailJob({ status: 'failed', errorCode: 'MAIL_STORAGE_LIMIT', attachments: [{ name: '<img bad>.pdf', size: 1000,
    contentType: 'application/pdf', sha256: 'a'.repeat(64), bytes: 'PRIVATE_ATTACHMENT_BYTES', contentBase64: 'PRIVATE_BASE64', path: 'PRIVATE_STORAGE_PATH' }] });
  const projected = mergeRecordHistory([], [job]);
  assert.ok(!JSON.stringify(projected).includes('PRIVATE_'));
  const html = renderUnifiedHistory([], [job]);
  assert.match(html, /Adjuntos adicionales/);assert.match(html, /&lt;img bad&gt;.pdf/);
  assert.match(html, /espacio reservado/);assert.ok(!html.includes('<img bad>'));assert.ok(!html.includes('PRIVATE_'));
});

function unifiedHistoryFixture({ includeMail = true } = {}) {
  const requests = [], content = { innerHTML: '' }, refresh = { disabled: false, onclick: null };
  const details = { isConnected: true, open: true, dataset: { entityType: 'document', entityId: 'quote-1', ...(includeMail ? { includeMail: 'true' } : {}) },
    querySelector: name => name === '[data-history-content]' ? content : refresh };
  const read = source => new Promise((resolve, reject) => requests.push({ source, resolve, reject }));
  let mode = 'cloud', identity = 'nicole', backend = { recordHistory: () => read('audit'), mail: { history: () => read('mail') } };
  const ctx = { getMode: () => mode, getIdentity: () => identity, getBackend: () => backend };
  return { requests, content, refresh, details, ctx, root: { querySelectorAll: () => [details] },
    cancel: reason => {
      if (reason === 'identity') identity = 'liliana';
      else if (reason === 'lock') mode = 'locked';
      else if (reason === 'backend') backend = {};
      else if (reason === 'disconnect') details.isConnected = false;
    } };
}

test('opt-in reads start concurrently and wait for both histories; ordinary record histories never read mail', async () => {
  const fixture = unifiedHistoryFixture();
  const dispose = bindRecordHistory(fixture.root, fixture.ctx), pending = fixture.refresh.onclick();
  assert.deepEqual(fixture.requests.map(request => request.source), ['audit', 'mail']);
  fixture.requests[0].resolve([change()]);
  await Promise.resolve();
  assert.match(fixture.content.innerHTML, /Cargando historial/);
  assert.equal(fixture.refresh.disabled, true);
  fixture.requests[1].resolve([mailJob()]);
  await pending;
  assert.match(fixture.content.innerHTML, /nicole@example.test/);
  assert.match(fixture.content.innerHTML, /Correo enviado/);
  assert.equal(fixture.refresh.disabled, false);
  dispose();
  const ordinary = unifiedHistoryFixture({ includeMail: false });
  bindRecordHistory(ordinary.root, ordinary.ctx);
  const original = ordinary.refresh.onclick();
  assert.deepEqual(ordinary.requests.map(request => request.source), ['audit']);
  ordinary.requests[0].resolve([change()]);
  await original;
  assert.equal(ordinary.content.innerHTML, renderHistoryEntries([change()]));
});

test('late mail/history successes and errors cannot write after identity, backend, lock, disconnect or cleanup changes', async () => {
  for (const reason of ['identity', 'backend', 'lock', 'disconnect', 'cleanup']) for (const failure of [false, true]) {
    const fixture = unifiedHistoryFixture(), dispose = bindRecordHistory(fixture.root, fixture.ctx), pending = fixture.refresh.onclick();
    if (reason === 'cleanup') dispose(); else fixture.cancel(reason);
    fixture.requests[0].resolve([change({ actorEmail: 'PRIOR_ACCOUNT_PRIVATE' })]);
    if (failure) fixture.requests[1].reject(new Error('PRIOR_ACCOUNT_PRIVATE_ERROR'));
    else fixture.requests[1].resolve([mailJob({ subject: 'PRIOR_ACCOUNT_PRIVATE_MAIL' })]);
    await pending;
    assert.ok(!fixture.content.innerHTML.includes('PRIOR_ACCOUNT_PRIVATE'), `${reason}, failure=${failure}`);
  }
});

test('a slower earlier unified-history refresh cannot overwrite a later result or reveal a late error', async () => {
  for (const failure of [false, true]) {
    const fixture = unifiedHistoryFixture();
    bindRecordHistory(fixture.root, fixture.ctx);
    const first = fixture.refresh.onclick(), second = fixture.refresh.onclick();
    fixture.requests[2].resolve([change({ actorEmail: 'CURRENT_ACCOUNT' })]);
    fixture.requests[3].resolve([mailJob({ subject: 'CURRENT_MAIL' })]);
    await second;
    const current = fixture.content.innerHTML;
    assert.match(current, /CURRENT_MAIL/);
    if (failure) fixture.requests[0].reject(new Error('STALE_PRIVATE_ERROR'));
    else fixture.requests[0].resolve([change({ actorEmail: 'STALE_ACCOUNT' })]);
    fixture.requests[1].resolve([mailJob({ subject: 'STALE_MAIL' })]);
    await first;
    assert.equal(fixture.content.innerHTML, current);
    assert.equal(fixture.refresh.disabled, false);
  }
});
