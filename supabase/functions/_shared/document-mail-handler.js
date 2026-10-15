import { defaultMailSignature, validateMailDraft, validateMailSignature, mailAttachmentName } from '../../../src/mail-domain.js';

const fail = code => Object.assign(new Error(code), { code });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const base64 = bytes => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
const from64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value)), byte => byte.toString(16).padStart(2, '0')).join('');
async function bodyJSON(request) {
  const reader = request.body?.getReader(); if (!reader) throw fail('INVALID_MESSAGE');
  const chunks = []; let size = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 100000) { await reader.cancel(); throw fail('INVALID_MESSAGE'); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(buffer)); } catch { throw fail('INVALID_MESSAGE'); }
}

export function createDocumentMailHandler({ db, auth, mail, renderDocumentPdf, logoBytes }) {
  async function rpc(name, parameters) {
    const { data, error } = await db.rpc(`orquivia_mail_${name}`, parameters);
    if (error) {
      const known = ['MEMBERSHIP_REQUIRED','MFA_REQUIRED','PROFILE_CONFLICT','VERSION_CONFLICT','DOCUMENT_NOT_SENDABLE','MAIL_OUTCOME_UNCERTAIN','RATE_LIMITED','INVALID_MAIL_JOB','IDEMPOTENCY_CONFLICT'];
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
      async function archive(jobId) {
        const saved = await rpc('archive_claim', { ...parameters, p_id: jobId });
        try {
          const connection = await rpc('profile', { ...parameters, p_secrets: true });
          await mail.appendSent(connection, connection.sentFolder, from64(saved.raw), saved.messageId);
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
      const signature = validateMailSignature(publicProfile(profile).signature);
      if (!signature.ok) throw fail('INVALID_SIGNATURE');
      const requestHash = await hash(JSON.stringify({ ...draft.value, documentId: body.documentId, signature: signature.value }));
      const claimed = await rpc('claim', { ...parameters, p_id: body.idempotencyKey, p_document: body.documentId, p_version: body.expectedWorkspaceVersion, p_hash: requestHash, p_to: draft.value.to, p_cc: draft.value.cc, p_subject: draft.value.subject });
      if (claimed.existing) return response({ job: claimed.job });
      const jobId = claimed.job.id;
      let mime, connection;
      try {
        const pdf = await renderDocumentPdf(claimed.document, claimed.company, claimed.client);
        mime = await mail.buildMessage({ email: user.email, ...draft.value, signature: signature.value, pdfBytes: pdf,
          filename: mailAttachmentName(claimed.document), jobId, date: claimed.job.createdAt, logoBytes });
        await rpc('store_message', { ...parameters, p_id: jobId, p_raw: base64(mime.raw), p_message_id: mime.messageId, p_pdf_hash: await hash(pdf) });
        connection = await rpc('profile', { ...parameters, p_secrets: true });
      } catch {
        return response(await rpc('complete', { ...parameters, p_id: jobId, p_status: 'failed' }));
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
      const archived = await archive(jobId);
      return response({ ...accepted, job: archived.job });
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'MAIL_ERROR';
      return response({ error: code }, ['AUTH_REQUIRED','AUTH_CHANGED','MFA_REQUIRED','MEMBERSHIP_REQUIRED'].includes(code) ? 403 : code.includes('CONFLICT') ? 409 : 400);
    }
  };
}
