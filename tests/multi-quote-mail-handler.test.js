import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentMailHandler } from '../supabase/functions/_shared/document-mail-handler.js';
import { MAIL_ATTACHMENT_LIMITS } from '../src/mail-attachments.js';

const user = '10000000-0000-4000-8000-000000000001';
const organization = '20000000-0000-4000-8000-000000000001';
const jobId = '30000000-0000-4000-8000-000000000001';
const signature = { name: 'Synthetic sender', role: '', phone: '' };
const encoder = new TextEncoder();
const mimeBytes = encoder.encode('the-exact-server-prepared-message');
const primary = { id: 'quote-main', kind: 'quote', status: 'ready', number: 'PR-FIXTURE-001', clientId: 'client-main' };
const fields = { documentId: primary.id, expectedWorkspaceVersion: 7, idempotencyKey: jobId,
  to: ['client@example.test'], subject: 'Two quote alternatives', message: 'Synthetic message.' };
const pdfFor = (id, size) => {
  const prefix = encoder.encode(`%PDF-1.7\nCanonical server document: ${id}\n%%EOF`);
  if (!size) return prefix;
  const bytes = new Uint8Array(size); bytes.set(prefix); return bytes;
};
const token = () => `header.${Buffer.from(JSON.stringify({ sub: user, exp: Math.floor(Date.now() / 1000) + 3600, aal: 'aal2' })).toString('base64url')}.signature`;
const request = payload => new Request('https://example.test', { method: 'POST',
  headers: { authorization: `Bearer ${token()}`, origin: 'https://npereyra-orquivia.github.io' },
  body: JSON.stringify({ action: 'send', organizationId: organization, expectedUserId: user, ...fields, ...payload }) });

function fixture({ existing = false, claimError, smtpError, archiveError = false, renderError, pdfSize } = {}) {
  const calls = [], renders = [], built = [], sends = [], archives = [];
  let status = 'sending';
  const company = { name: 'Canonical company' }, client = { id: 'client-main', name: 'Canonical client' };
  const db = { rpc: async (name, parameters) => {
    calls.push({ name, parameters });
    if (name === 'orquivia_mail_profile') return { data: { email: 'sender@example.test', connected: true, signature,
      ...(parameters.p_secrets ? { password: 'fixture-only-secret', sentFolder: 'Sent' } : {}) }, error: null };
    if (name === 'orquivia_mail_claim') {
      if (claimError) return { data: null, error: { message: claimError } };
      const related = parameters.p_related_documents || [];
      return { data: { existing, document: primary, company, client,
        relatedDocuments: related.map((id, index) => ({ document: { ...primary, id, number: `PR-FIXTURE-${index + 2}` }, company, client })),
        job: { id: jobId, status, createdAt: '2026-01-15T12:00:00Z' } }, error: null };
    }
    if (name === 'orquivia_mail_store_message') return { data: null, error: null };
    if (name === 'orquivia_mail_complete') {
      status = parameters.p_status;
      return { data: { job: { id: jobId, status,
        ...(parameters.p_delivery ? { errorCode: parameters.p_delivery.errorCode, accepted: parameters.p_delivery.accepted, rejected: parameters.p_delivery.rejected } : {}) },
        ...(status === 'archive_pending' ? { workspace: { state: { canonical: true }, version: 8 } } : {}) }, error: null };
    }
    if (name === 'orquivia_mail_archive_claim') return { data: { messageId: '<fixture-multi@example.test>',
      ...(parameters.p_include_raw === false ? {} : { raw: Buffer.from(mimeBytes).toString('base64') }) }, error: null };
    throw new Error(`Unexpected RPC: ${name}`);
  } };
  const mail = {
    buildMessage: async value => { built.push(value); return { raw: mimeBytes, messageId: '<fixture-multi@example.test>', envelope: { from: 'sender@example.test', to: fields.to } }; },
    sendRaw: async (_connection, raw, envelope) => {
      sends.push({ raw, envelope });
      if (smtpError) throw Object.assign(new Error('Provider private detail'), smtpError);
    },
    appendSent: async (_connection, folder, raw, id) => {
      archives.push({ folder, raw, id });
      if (archiveError) throw new Error('Private archival detail');
    },
  };
  const handler = createDocumentMailHandler({ db, auth: { getUser: async () => ({ data: { user: { id: user, email: 'sender@example.test' } } }) }, mail,
    renderDocumentPdf: async (document, receivedCompany, receivedClient) => {
      renders.push({ document, company: receivedCompany, client: receivedClient });
      if (document.id === renderError) throw new Error('Private render detail');
      return pdfFor(document.id, typeof pdfSize === 'function' ? pdfSize(document) : undefined);
    }, logoBytes: new Uint8Array([1]) });
  return { handler, calls, renders, built, sends, archives, company, client };
}
const claim = instance => instance.calls.find(call => call.name === 'orquivia_mail_claim')?.parameters;

test('multiple quote IDs render official server snapshots and produce exactly one message and one archive', async () => {
  const f = fixture();
  const response = await f.handler(request({ relatedDocumentIds: ['quote-other'], relatedDocuments: [{ document: { id: 'attacker-snapshot', number: 'FORGED' } }] }));
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.job.status, 'sent');
  assert.deepEqual(claim(f).p_related_documents, ['quote-other']);
  assert.deepEqual(f.renders.map(value => value.document.id), ['quote-main', 'quote-other']);
  for (const render of f.renders) { assert.equal(render.company, f.company); assert.equal(render.client, f.client); }
  assert.equal(f.built.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.archives.length, 1);
  assert.deepEqual(f.built[0].pdfBytes, pdfFor('quote-main'));
  assert.deepEqual(f.built[0].attachments, []);
  assert.equal(f.built[0].relatedQuotePdfs.length, 1);
  assert.deepEqual(f.built[0].relatedQuotePdfs[0].bytes, pdfFor('quote-other'));
  assert.equal(f.built[0].relatedQuotePdfs[0].contentType, 'application/pdf');
  assert.equal(f.built[0].relatedQuotePdfs[0].name, 'presupuesto-PR-FIXTURE-2.pdf');
  assert.deepEqual(f.sends[0].raw, mimeBytes); assert.deepEqual(f.archives[0].raw, mimeBytes);
  assert.equal(result.workspace.version, 8);
  assert.ok(!JSON.stringify(result).includes('Canonical server document'));
});

test('related quote order is normalized for idempotency and changing the selection changes its hash', async () => {
  const hashes = [];
  for (const relatedDocumentIds of [['quote-b', 'quote-a'], ['quote-a', 'quote-b'], ['quote-c']]) {
    const f = fixture({ existing: true });
    const response = await f.handler(request({ relatedDocumentIds })); assert.equal(response.status, 200);
    hashes.push(claim(f).p_hash);
    assert.deepEqual(claim(f).p_related_documents, [...relatedDocumentIds].sort());
    assert.equal(f.renders.length, 0); assert.equal(f.built.length, 0); assert.equal(f.sends.length, 0); assert.equal(f.archives.length, 0);
  }
  assert.equal(hashes[0], hashes[1]); assert.notEqual(hashes[0], hashes[2]);
  const empty = fixture({ existing: true }), absent = fixture({ existing: true });
  await empty.handler(request({ relatedDocumentIds: [] })); await absent.handler(request({}));
  assert.equal(claim(empty).p_hash, claim(absent).p_hash);
  assert.equal(claim(empty).p_related_documents, undefined); assert.equal(claim(absent).p_related_documents, undefined);
});

test('malformed, repeated, primary and excessive related IDs never reach a claim or PDF renderer', async () => {
  for (const relatedDocumentIds of [null, 'quote-a', {}, ['quote-a', 'quote-a'], ['quote-main'], [1], [''], [' '], ['x'.repeat(101)], ['quote\na'], ['a','b','c','d','e']]) {
    const f = fixture(); const response = await f.handler(request({ relatedDocumentIds }));
    assert.equal(response.status, 400, JSON.stringify(relatedDocumentIds));
    assert.equal(claim(f), undefined, JSON.stringify(relatedDocumentIds));
    assert.equal(f.renders.length, 0); assert.equal(f.sends.length, 0); assert.equal(f.archives.length, 0);
  }
});

test('database denials for recipient isolation or stale workspace cannot render or send any quote', async () => {
  for (const claimError of ['DOCUMENT_NOT_SENDABLE', 'VERSION_CONFLICT', 'MEMBERSHIP_REQUIRED', 'MAIL_OUTCOME_UNCERTAIN']) {
    const f = fixture({ claimError }); const response = await f.handler(request({ relatedDocumentIds: ['quote-other'] }));
    assert.ok(response.status >= 400); assert.equal(f.renders.length, 0); assert.equal(f.sends.length, 0); assert.equal(f.archives.length, 0);
    assert.equal(claim(f).p_version, 7); assert.equal(claim(f).p_org, organization); assert.equal(claim(f).p_user, user);
  }
});

test('render failure and generated PDF size quotas fail definitively before SMTP', async () => {
  for (const options of [
    { renderError: 'quote-other' },
    { pdfSize: document => document.id === 'quote-other' ? MAIL_ATTACHMENT_LIMITS.eachBytes + 1 : undefined },
    { pdfSize: document => document.id === 'quote-main' ? undefined : 3_400_000 },
  ]) {
    const f = fixture(options);
    const relatedDocumentIds = options.pdfSize && options.pdfSize({ id: 'quote-other' }) === 3_400_000 ? ['quote-a', 'quote-b', 'quote-other'] : ['quote-other'];
    const response = await f.handler(request({ relatedDocumentIds })); const result = await response.json();
    assert.equal(result.job.status, 'failed'); assert.equal(f.sends.length, 0); assert.equal(f.archives.length, 0);
    assert.equal(f.built.length, 0); assert.equal(result.workspace, undefined);
    assert.ok(!JSON.stringify(result).includes('Private render detail'));
  }
});

test('partial SMTP acceptance leaves the group uncertain and archive retries never render or send a second email', async () => {
  const partial = fixture({ smtpError: { code: 'SMTP_PARTIAL', accepted: fields.to, rejected: ['copy@example.test'] } });
  const result = await (await partial.handler(request({ relatedDocumentIds: ['quote-other'], cc: ['copy@example.test'] }))).json();
  assert.equal(result.job.status, 'uncertain'); assert.equal(result.job.errorCode, 'SMTP_PARTIAL');
  assert.equal(result.workspace, undefined); assert.equal(partial.sends.length, 1); assert.equal(partial.archives.length, 0);
  assert.equal(partial.calls.some(call => call.parameters.p_status === 'archive_pending'), false);
  const archiveFailure = fixture({ archiveError: true });
  const pending = await (await archiveFailure.handler(request({ relatedDocumentIds: ['quote-other'] }))).json();
  assert.equal(pending.job.status, 'archive_pending'); assert.equal(archiveFailure.sends.length, 1);
  const retry = fixture();
  const retried = await (await retry.handler(request({ action: 'retryArchive', jobId }))).json();
  assert.equal(retried.job.status, 'sent'); assert.equal(retry.renders.length, 0); assert.equal(retry.sends.length, 0); assert.equal(retry.archives.length, 1);
  assert.deepEqual(retry.archives[0].raw, mimeBytes);
});
