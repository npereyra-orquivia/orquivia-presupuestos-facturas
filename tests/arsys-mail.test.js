import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { createArsysMail } from '../supabase/functions/_shared/arsys-mail.js';
import { validateMailDraft, renderMailSignature, defaultMailSignature } from '../src/mail-domain.js';

const account = { email: 'sender@example.test', password: 'synthetic-password', provider: 'serviciodecorreo' };
test('MIME contains one PDF, embedded logo, fixed sender/message ID and escaped signature and body', async () => {
  const transport = createArsysMail({ createTransport: options => nodemailer.createTransport(options) });
  const result = await transport.buildMessage({ email: account.email, to: ['client@example.test'], subject: 'Presupuesto de prueba',
    message: 'Hola <script>alert(1)</script>', signature: { name: 'Persona <prueba>', role: 'Dirección', phone: '+34 600 000 000' },
    pdfBytes: new TextEncoder().encode('%PDF-1.4 synthetic'), logoBytes: new Uint8Array([1, 2, 3]), filename: 'presupuesto-PR-001.pdf',
    jobId: '10000000-0000-4000-8000-000000000001', date: '2026-10-15T09:00:00Z' });
  const raw = new TextDecoder().decode(result.raw);
  assert.match(raw, /Message-ID: <10000000-0000-4000-8000-000000000001@orquivia.com>/i);
  assert.match(raw, /Content-Type: application\/pdf/);
  assert.match(raw, /Content-ID: <orquivia-logo>/i);
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.match(raw, /&lt;script&gt;/);
  assert.deepEqual(result.envelope, { from: account.email, to: ['client@example.test'] });
  assert.ok(!raw.includes(account.password));
});

test('all To and Cc recipients appear in MIME and the SMTP envelope without cross-list duplicates', async () => {
  const transport = createArsysMail({ createTransport: options => nodemailer.createTransport(options) });
  const result = await transport.buildMessage({ email: account.email, to: ['one@example.test', 'two@example.test'], cc: ['copy@example.test','ONE@example.test'],
    subject: 'Presupuesto de prueba', message: 'Mensaje', signature: {name:'Persona',role:'',phone:''}, pdfBytes:new Uint8Array([1]),logoBytes:new Uint8Array([2]),
    filename:'presupuesto-PR-001.pdf',jobId:'10000000-0000-4000-8000-000000000001',date:'2026-10-15T09:00:00Z' });
  const raw = new TextDecoder().decode(result.raw);
  assert.match(raw,/To: one@example.test, two@example.test\r?\n/i);
  assert.match(raw,/Cc: copy@example.test\r?\n/i);
  assert.deepEqual(result.envelope.to,['one@example.test','two@example.test','copy@example.test']);
});

test('mail verification uses only approved TLS hosts and discovers Sent without sending', async () => {
  let sent = 0; const options = [];
  const mail = createArsysMail({ createTransport: value => { options.push(value); return { verify: async () => true, sendMail: () => ++sent, close() {} }; },
    createImapClient: value => { options.push(value); return { connect: async () => {}, list: async () => [{ path: 'Sent', specialUse: '\\Sent' }], logout: async () => {} }; } });
  assert.deepEqual(await mail.verifyMailbox(account), { sentFolder: 'Sent' });
  assert.equal(sent, 0);
  assert.deepEqual(options.map(value => [value.host, value.port, value.secure]), [['smtp.serviciodecorreo.es',465,true],['imap.serviciodecorreo.es',993,true]]);
  assert.ok(options.every(value => value.tls.rejectUnauthorized && value.logger === false));
  await assert.rejects(mail.verifyMailbox({ ...account, provider: '127.0.0.1' }), /MAIL_NOT_CONFIGURED/);
});

test('archive retries search only Sent and never append the same message twice or call SMTP', async () => {
  let appended = 0, searches = 0, smtp = 0;
  const mail = createArsysMail({ createTransport: () => { ++smtp; }, createImapClient: () => ({
    connect: async () => {}, logout: async () => {}, list: async () => [{ path: 'Sent', specialUse: '\\Sent' }],
    getMailboxLock: async folder => { assert.equal(folder, 'Sent'); return { release() {} }; },
    search: async query => { assert.equal(query.header['message-id'], '<fixture@example.test>'); return searches++ ? [1] : []; },
    append: async (folder, raw, flags) => { assert.equal(folder, 'Sent'); assert.deepEqual(raw,new Uint8Array([1,2])); assert.deepEqual(flags,['\\Seen']); ++appended; },
  }) });
  await mail.appendSent(account, 'Sent', new Uint8Array([1,2]), '<fixture@example.test>');
  await mail.appendSent(account, 'Sent', new Uint8Array([1,2]), '<fixture@example.test>');
  assert.equal(appended, 1); assert.equal(smtp, 0);
  await assert.rejects(mail.appendSent(account, 'INBOX', new Uint8Array(), '<fixture@example.test>'));
});

test('SMTP timeout remains uncertain while an explicit rejection is safe to report as not sent', async () => {
  for (const [error, code] of [[{ code:'ETIMEDOUT' },'SMTP_UNCERTAIN'],[{ code:'EAUTH' },'SMTP_REJECTED'],[{ responseCode:550 },'SMTP_REJECTED']]) {
    const mail = createArsysMail({ createTransport: () => ({ sendMail: async () => { throw error; }, close() {} }) });
    await assert.rejects(mail.sendRaw(account, new Uint8Array(),{from:account.email,to:['client@example.test']}), failure => failure.code === code);
  }
});

test('partial SMTP acceptance retains requested accepted and rejected recipients and is never fully sent', async () => {
  const envelope={from:account.email,to:['client@example.test','copy@example.test']};
  for(const result of [{accepted:['client@example.test'],rejected:['copy@example.test']},
    {accepted:[{address:'CLIENT@example.test'}],rejected:['copy@example.test','unrequested@example.test']}]) {
    const mail=createArsysMail({createTransport:()=>({sendMail:async()=>result,close(){}})});
    await assert.rejects(mail.sendRaw(account,new Uint8Array(),envelope),error=>{
      assert.equal(error.code,'SMTP_PARTIAL');assert.deepEqual(error.accepted,['client@example.test']);assert.deepEqual(error.rejected,['copy@example.test']);return true;
    });
  }
  const allRejected=createArsysMail({createTransport:()=>({sendMail:async()=>({accepted:[],rejected:envelope.to}),close(){}})});
  await assert.rejects(allRejected.sendRaw(account,new Uint8Array(),envelope),error=>error.code==='SMTP_REJECTED');
  const mixedError=createArsysMail({createTransport:()=>({sendMail:async()=>{throw {responseCode:550,accepted:['client@example.test'],rejected:['copy@example.test']};},close(){}})});
  await assert.rejects(mixedError.sendRaw(account,new Uint8Array(),envelope),error=>error.code==='SMTP_PARTIAL');
  const accepted=createArsysMail({createTransport:()=>({sendMail:async()=>({accepted:envelope.to,rejected:[]}),close(){}})});
  assert.deepEqual(await accepted.sendRaw(account,new Uint8Array(),envelope),{accepted:true});
});

test('address/header injection and user HTML do not become executable mail content', () => {
  assert.equal(validateMailDraft({to:['a@example.test\r\nBcc: other@example.test'],subject:'hello',message:'body'}).ok,false);
  assert.equal(validateMailDraft({to:['a@example.test'],subject:'hello\r\nBcc: other@example.test',message:'body'}).ok,false);
  const signature = renderMailSignature({name:'<img onerror=alert(1)>',role:'CEO',phone:''},{email:account.email,logoUrl:'javascript:alert(1)'});
  assert.ok(!signature.includes('<img')); assert.match(signature,/&lt;img/);
  assert.equal(defaultMailSignature({email:'user@example.test'}).phone,'');
});
