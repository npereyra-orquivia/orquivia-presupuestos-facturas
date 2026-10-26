import { defaultMailSignature, validateMailDraft, validateMailSignature, mailAttachmentName } from '../../../src/mail-domain.js';
import { MAIL_ATTACHMENT_LIMITS, decodeMailAttachments, mailAttachmentMetadata } from '../../../src/mail-attachments.js';

const fail = code => Object.assign(new Error(code), { code });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const base64 = bytes => { const chunks = []; for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768))); return btoa(chunks.join('')); };
const from64 = text => { const binary = atob(text), bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index); return bytes; };
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value)), byte => byte.toString(16).padStart(2, '0')).join('');
async function bodyJSON(request) {
  if (Number(request.headers.get('content-length')) > MAIL_ATTACHMENT_LIMITS.bodyBytes) throw fail('ATTACHMENT_LIMIT');
  const reader = request.body?.getReader(); if (!reader) throw fail('INVALID_MESSAGE');
  const chunks = []; let size = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > MAIL_ATTACHMENT_LIMITS.bodyBytes) { await reader.cancel(); throw fail('ATTACHMENT_LIMIT'); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); } catch { throw fail('INVALID_MESSAGE'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || (body.action !== 'send' && size > 100000)) throw fail('INVALID_MESSAGE');
  return body;
}

export function createDocumentMailHandler({ db, auth, mail, renderDocumentPdf, logoBytes }) {
  async function rpc(name, parameters) {
    const { data, error } = await db.rpc(`orquivia_mail_${name}`, parameters);
    if (error) {
      const known = ['MEMBERSHIP_REQUIRED','MFA_REQUIRED','PROFILE_CONFLICT','VERSION_CONFLICT','DOCUMENT_NOT_SENDABLE','MAIL_OUTCOME_UNCERTAIN','RATE_LIMITED','INVALID_MAIL_JOB','IDEMPOTENCY_CONFLICT','INVALID_ATTACHMENT','ATTACHMENTS_NOT_ALLOWED','ATTACHMENT_LIMIT','MAIL_STORAGE_LIMIT','MAIL_MESSAGE_TOO_LARGE'];
      throw fail(known.find(code => error.message?.includes(code)) || 'MAIL_DATABASE_ERROR');
    }
    return data;
  }
  return async request => {
    const origin = request.headers.get('origin');
    const approved = !origin || origin === 'https://npereyra-orquivia.github.io' || /^http:\/\/127\.0\.0\.1:517[34]$/.test(origin);
    const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'Vary': 'Origin', ...(approved && origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization,x-client-info,apikey,content-type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' } : {}) };
    const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });
    if (!approved) return response({ error: 'FORBIDDEN_ORIGIN' }, 403);
    if (request.method === 'OPTIONS') return response({});
    if (request.method !== 'POST') return response({ error: 'METHOD_NOT_ALLOWED' }, 405);
    try {
      const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
      if (!token || token.length > 8000) throw fail('AUTH_REQUIRED');
      // getUser validates the signed token before any claims are interpreted.
      const verified = await auth.getUser(token);
      if (verified.error || !verified.data?.user?.id) throw fail('AUTH_REQUIRED');
      const user = verified.data.user;
      let claims; try { claims = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))); } catch { throw fail('AUTH_REQUIRED'); }
      if (claims.sub !== user.id || claims.exp * 1000 <= Date.now()) throw fail('AUTH_REQUIRED');
      if (claims.aal !== 'aal2') throw fail('MFA_REQUIRED');
      const body = await bodyJSON(request);
      if (body.expectedUserId !== user.id || !uuid(body.organizationId)) throw fail('AUTH_CHANGED');
      const parameters = { p_user: user.id, p_org: body.organizationId };
      const publicProfile = value => ({ ...value, signature: Object.keys(value.signature || {}).length ? value.signature : defaultMailSignature(user) });
      if (['history', 'composer'].includes(body.action)) {
        if (typeof body.documentId !== 'string' || body.documentId.length > 100) throw fail('INVALID_DOCUMENT');
        const historyParameters = { ...parameters, p_document: body.documentId };
        // Each RPC independently verifies active membership and MFA. Neither
        // read requests a credential, and they do not depend on each other.
        if (body.action === 'history') return response(await rpc('history', historyParameters));
        const [profile, history] = await Promise.all([
          rpc('profile', { ...parameters, p_secrets: false }),
          rpc('history', historyParameters),
        ]);
        return response({ profile: publicProfile(profile), history: Array.isArray(history) ? history : history?.history || [] });
      }
      const profile = await rpc('profile', { ...parameters, p_secrets: false });
      if (body.action === 'profile') return response(publicProfile(profile));
      if (['signature', 'configure', 'disconnect'].includes(body.action)) {
        const signature = validateMailSignature(body.signature || publicProfile(profile).signature);
        if (!signature.ok || !Number.isSafeInteger(body.expectedVersion)) throw fail('INVALID_SIGNATURE');
        let password = null, folder = null, provider = null;
        if (body.action === 'configure') {
          await rpc('connection_attempt', parameters);
          const secretProfile = await rpc('profile', { ...parameters, p_secrets: true });
          password = body.password || secretProfile.password;
          provider = body.provider;
          if (!['serviciodecorreo','arsys'].includes(provider) || typeof password !== 'string' || !password || password.length > 1024) throw fail('MAIL_NOT_CONFIGURED');
          const result = await mail.verifyMailbox({ email: user.email, password, provider }); folder = result.sentFolder;
        }
        return response(publicProfile(await rpc('save_profile', { ...parameters, p_expected_version: body.expectedVersion,
          p_signature: signature.value, p_provider: provider, p_password: password, p_folder: folder, p_disconnect: body.action === 'disconnect' })));
      }
      async function archive(jobId, prepared = null) {
        const saved = await rpc('archive_claim', { ...parameters, p_id: jobId, ...(prepared ? { p_include_raw: false } : {}) });
        try {
          if (prepared && prepared.messageId !== saved.messageId) throw fail('INVALID_MAIL_JOB');
          const connection = await rpc('profile', { ...parameters, p_secrets: true });
          await mail.appendSent(connection, connection.sentFolder, prepared ? prepared.raw : from64(saved.raw), saved.messageId);
          return await rpc('complete', { ...parameters, p_id: jobId, p_status: 'sent' });
        } catch { return await rpc('complete', { ...parameters, p_id: jobId, p_status: 'archive_pending' }); }
      }
      if (body.action === 'retryArchive') {
        if (!uuid(body.jobId)) throw fail('INVALID_MAIL_JOB');
        return response(await archive(body.jobId));
      }
      if (body.action !== 'send') throw fail('INVALID_ACTION');
      const draft = validateMailDraft({ to: body.to, cc: body.cc, subject: body.subject, message: body.message });
      if (!draft.ok || !uuid(body.idempotencyKey) || typeof body.documentId !== 'string' || body.documentId.length > 100 || !Number.isSafeInteger(body.expectedWorkspaceVersion)) throw fail('INVALID_MESSAGE');
      if (!profile.connected) throw fail('MAIL_NOT_CONFIGURED');
      let attachments = decodeMailAttachments(body.attachments === undefined ? [] : body.attachments);
      delete body.attachments;
      const metadata = await mailAttachmentMetadata(attachments);
      const signature = validateMailSignature(publicProfile(profile).signature);
      if (!signature.ok) throw fail('INVALID_SIGNATURE');
      // Preserve old idempotency hashes for messages without extra files.
      const requestHash = await hash(JSON.stringify({ ...draft.value, documentId: body.documentId, signature: signature.value, ...(metadata.length ? { attachments: metadata } : {}) }));
      const claimed = await rpc('claim', { ...parameters, p_id: body.idempotencyKey, p_document: body.documentId, p_version: body.expectedWorkspaceVersion, p_hash: requestHash, p_to: draft.value.to, p_cc: draft.value.cc, p_subject: draft.value.subject, p_attachments: metadata });
      if (claimed.existing) return response({ job: claimed.job });
      const jobId = claimed.job.id;
      let mime, connection;
      try {
        const pdf = await renderDocumentPdf(claimed.document, claimed.company, claimed.client);
        mime = await mail.buildMessage({ email: user.email, ...draft.value, signature: signature.value, pdfBytes: pdf,
          filename: mailAttachmentName(claimed.document), jobId, date: claimed.job.createdAt, logoBytes,
          attachments, documentKind: claimed.document.kind });
        attachments = [];
        if (!(mime.raw instanceof Uint8Array) || mime.raw.length > MAIL_ATTACHMENT_LIMITS.rawBytes) throw fail('MAIL_MESSAGE_TOO_LARGE');
        await rpc('store_message', { ...parameters, p_id: jobId, p_raw: base64(mime.raw), p_message_id: mime.messageId, p_pdf_hash: await hash(pdf) });
        connection = await rpc('profile', { ...parameters, p_secrets: true });
      } catch (error) {
        const code = ['MAIL_STORAGE_LIMIT', 'MAIL_MESSAGE_TOO_LARGE'].includes(error?.code) ? error.code : 'MAIL_PREPARATION_FAILED';
        return response(await rpc('complete', { ...parameters, p_id: jobId, p_status: 'failed', p_delivery: { errorCode: code } }));
      }
      try { await mail.sendRaw(connection, mime.raw, mime.envelope); }
      catch (error) {
        // Some RCPT recipients can be accepted while others are rejected. That
        // message must never be treated as fully sent or blindly resubmitted.
        const partial = error.code === 'SMTP_PARTIAL';
        return response(await rpc('complete', { ...parameters, p_id: jobId, p_status: error.code === 'SMTP_REJECTED' ? 'failed' : 'uncertain',
          ...(partial ? { p_delivery: { errorCode: 'SMTP_PARTIAL', accepted: error.accepted, rejected: error.rejected } } : {}) }));
      }
      // Commit SMTP acceptance before archiving. A retry may only append its
      // immutable MIME copy, never submit the message to SMTP a second time.
      const accepted = await rpc('complete', { ...parameters, p_id: jobId, p_status: 'archive_pending' });
      const archived = await archive(jobId, mime);
      return response({ ...accepted, job: archived.job });
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'MAIL_ERROR';
      return response({ error: code }, ['AUTH_REQUIRED','AUTH_CHANGED','MFA_REQUIRED','MEMBERSHIP_REQUIRED'].includes(code) ? 403 : code.includes('CONFLICT') ? 409 : 400);
    }
  };
}
