import { createClient } from 'npm:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@10.2.1';
import { ImapFlow } from 'npm:imapflow@2.4.3';
import { createArsysMail } from '../_shared/arsys-mail.js';
import { createDocumentMailHandler } from '../_shared/document-mail-handler.js';
import { renderDocumentPdf, mailLogoBytes } from '../_shared/document-mail-pdf.js';

const url = Deno.env.get('SUPABASE_URL') || '';
let key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
try { key = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default || key; } catch { key = ''; }
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const mail = createArsysMail({ createTransport: options => nodemailer.createTransport(options), createImapClient: options => new ImapFlow(options) });
export default { fetch: createDocumentMailHandler({ db: client, auth: client.auth, mail, renderDocumentPdf, logoBytes: mailLogoBytes() }) };
