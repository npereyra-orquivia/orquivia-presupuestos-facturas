import { isMailAddress, renderMailSignature, validateMailDraft, validateMailSignature } from '../../../src/mail-domain.js';

export const MAIL_HOSTS = Object.freeze({
  serviciodecorreo: { smtp: 'smtp.serviciodecorreo.es', imap: 'imap.serviciodecorreo.es' },
  arsys: { smtp: 'smtp.arsys.es', imap: 'mail.arsys.es' },
});
const fail = code => Object.assign(new Error(code), { code });
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Dependencies are injected so transport tests never connect to a mailbox. */
export function createArsysMail({ createTransport, createImapClient }) {
  function settings(credentials, kind) {
    const hosts = MAIL_HOSTS[credentials?.provider];
    if (!hosts || !isMailAddress(credentials?.email) || typeof credentials.password !== 'string' || !credentials.password || credentials.password.length > 1024) throw fail('MAIL_NOT_CONFIGURED');
    return { host: hosts[kind], port: kind === 'smtp' ? 465 : 993, secure: true,
      auth: { user: credentials.email, pass: credentials.password },
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      disableAutoIdle: true, disableCompression: true };
  }
  async function imap(credentials, operation) {
    const client = createImapClient(settings(credentials, 'imap'));
    client.on?.('error', () => {});
    try { await client.connect(); return await operation(client); }
    finally { try { await client.logout(); } catch { client.close?.(); } }
  }
  function sentFolder(list) {
    const special = list.find(folder => folder.specialUse === '\\Sent' && !folder.flags?.has?.('\\Noselect'));
    if (special) return special.path;
    const known = ['Sent', 'Sent Items', 'Sent Messages', 'Enviados', 'INBOX.Sent', 'INBOX.Enviados'];
    return list.find(folder => known.some(name => name.toLowerCase() === folder.path?.toLowerCase()) && !folder.flags?.has?.('\\Noselect'))?.path;
  }
  return {
    async verifyMailbox(credentials) {
      const smtp = createTransport(settings(credentials, 'smtp'));
      try {
        await smtp.verify();
        return await imap(credentials, async client => {
          const folder = sentFolder(await client.list());
          if (!folder) throw fail('SENT_FOLDER_NOT_FOUND');
          return { sentFolder: folder };
        });
      } catch (error) { throw fail(error?.code === 'SENT_FOLDER_NOT_FOUND' ? error.code : 'MAIL_CONNECTION_FAILED'); }
      finally { smtp.close?.(); }
    },
    async buildMessage({ email, to, subject, message, signature, pdfBytes, filename, jobId, date, logoBytes }) {
      const draft = validateMailDraft({ to, subject, message });
      if (!draft.ok || !isMailAddress(email) || !validateMailSignature(signature).ok || !/^[0-9a-f-]{36}$/i.test(jobId)
        || !(pdfBytes instanceof Uint8Array) || pdfBytes.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9_-]+\.pdf$/.test(filename)) throw fail('INVALID_MESSAGE');
      const messageId = `<${jobId}@orquivia.com>`;
      const transport = createTransport({ streamTransport: true, buffer: true, newline: 'windows', disableFileAccess: true, disableUrlAccess: true });
      try {
        const result = await transport.sendMail({
          from: { name: signature.name, address: email }, to, replyTo: email, subject,
          date: new Date(date), messageId,
          text: `${message}\n\n--\n${[signature.name, signature.role, signature.phone, email].filter(Boolean).join('\n')}`,
          html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${escape(message).replaceAll('\n', '<br>')}</div><br>${renderMailSignature(signature, { email, logoUrl: 'cid:orquivia-logo' })}`,
          attachments: [
            { filename, content: pdfBytes, contentType: 'application/pdf' },
            { filename: 'orquivia.png', content: logoBytes, contentType: 'image/png', cid: 'orquivia-logo', contentDisposition: 'inline' },
          ],
        });
        return { raw: new Uint8Array(result.message), messageId, envelope: { from: email, to } };
      } finally { transport.close?.(); }
    },
    async sendRaw(credentials, raw, envelope) {
      const transport = createTransport(settings(credentials, 'smtp'));
      try {
        const result = await transport.sendMail({ envelope, raw, disableFileAccess: true, disableUrlAccess: true });
        if (result.rejected?.length || result.accepted?.length !== envelope.to.length) throw fail('SMTP_UNCERTAIN');
        return { accepted: true };
      } catch (error) {
        // A missing final DATA acknowledgement is ambiguous: never retry SMTP.
        const definite = ['EAUTH', 'EDNS', 'ETLS'].includes(error?.code)
          || (error?.code === 'ECONNECTION' && error?.command === 'CONN')
          || (Number(error?.responseCode) >= 400 && Number(error?.responseCode) < 600);
        throw fail(definite ? 'SMTP_REJECTED' : 'SMTP_UNCERTAIN');
      } finally { transport.close?.(); }
    },
    async appendSent(credentials, folder, raw, messageId) {
      return imap(credentials, async client => {
        const folders = await client.list();
        const actual = folders.find(entry => entry.path === folder);
        if (!actual || (actual.specialUse !== '\\Sent' && sentFolder(folders) !== folder)) throw fail('SENT_FOLDER_NOT_FOUND');
        const lock = await client.getMailboxLock(folder);
        try {
          const existing = await client.search({ header: { 'message-id': messageId } }, { uid: true });
          if (existing?.length) return { archived: true, existing: true };
          await client.append(folder, raw, ['\\Seen']);
          return { archived: true };
        } finally { lock.release(); }
      });
    },
  };
}
