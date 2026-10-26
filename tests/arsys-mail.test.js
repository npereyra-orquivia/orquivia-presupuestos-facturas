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

const invoiceMessage = () => ({ email: account.email, to: ['client@example.test'], subject: 'Factura de prueba', message: 'Factura y justificantes',
  signature: { name: 'Persona de prueba', role: '', phone: '' }, pdfBytes: new TextEncoder().encode('%PDF-1.7 generated invoice'),
  logoBytes: new Uint8Array([1, 2, 3]), filename: 'factura-F-001.pdf', documentKind: 'invoice',
  jobId: '10000000-0000-4000-8000-000000000001', date: '2026-10-26T09:00:00Z' });

test('an invoice MIME keeps its generated PDF and inline signature logo and attaches exact additional document bytes', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.4 supporting document\n%%EOF');
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 255]);
  const input = invoiceMessage();
  const mail = createArsysMail({ createTransport: options => nodemailer.createTransport(options) });
  const result = await mail.buildMessage({ ...input, attachments: [
    { name: 'justificante.pdf', contentType: 'application/pdf', bytes: pdf },
    { name: 'ticket.jpg', contentType: 'image/jpeg', bytes: jpg },
    { name: 'foto.png', contentType: 'image/png', bytes: png },
  ] });
  const raw = new TextDecoder().decode(result.raw);
  const bodies = raw.split(/\r\n--[^\r\n]+\r\n/).flatMap(part => {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0 || !/Content-Transfer-Encoding: base64/i.test(part.slice(0, separator))) return [];
    return [Buffer.from(part.slice(separator + 4).split('\r\n--')[0], 'base64')];
  });
  for (const expected of [input.pdfBytes, input.logoBytes, pdf, jpg, png]) assert.ok(bodies.some(body => body.equals(Buffer.from(expected))));
  assert.equal((raw.match(/Content-Type: application\/pdf/gi) || []).length, 2);
  assert.equal((raw.match(/Content-Disposition: attachment/gi) || []).length, 4);
  assert.equal((raw.match(/Content-ID: <orquivia-logo>/gi) || []).length, 1);
  assert.deepEqual(result.envelope.to, ['client@example.test']);
});

test('extra files are refused for quotes, reserved filenames, invalid content and URI/header options never reach the provider', async () => {
  let transports = 0;const captured = [];
  const mail = createArsysMail({ createTransport: options => {
    ++transports;assert.equal(options.streamTransport, true);
    return { sendMail: async value => { captured.push(value);return { message: new Uint8Array([1]) }; }, close() {} };
  } });
  const bytes = new TextEncoder().encode('%PDF-1.7 supporting file');
  const item = { name: 'support.pdf', contentType: 'application/pdf', bytes };
  for (const change of [{ documentKind: 'quote' }, { documentKind: undefined }, { attachments: [{ ...item, name: 'FACTURA-F-001.PDF' }] },
    { attachments: [{ ...item, name: 'orquivia.png', contentType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }] },
    { attachments: [{ ...item, name: 'support.pdf\r\nBcc: other@example.test' }] },
    { attachments: [{ ...item, bytes: new TextEncoder().encode('<svg onload=alert(1)>') }] }]) {
    await assert.rejects(mail.buildMessage({ ...invoiceMessage(), attachments: [item], ...change }), error => error.code === 'INVALID_ATTACHMENT');
  }
  assert.equal(transports, 0);
  await mail.buildMessage({ ...invoiceMessage(), attachments: [{ ...item, path: 'https://example.test/private', href: 'file:///etc/passwd', cid: 'injected' }] });
  const additional = captured[0].attachments.at(-1);
  assert.deepEqual(Object.keys(additional), ['filename', 'content', 'contentType', 'contentDisposition']);
  assert.equal(additional.content, bytes);assert.equal(additional.contentDisposition, 'attachment');
});

test('Unicode attachment names are MIME encoded and oversized MIME is rejected before SMTP without duplicating its buffer', async () => {
  const item = { name: 'Justificación-Órden.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4 content') };
  const mail = createArsysMail({ createTransport: options => nodemailer.createTransport(options) });
  const result = await mail.buildMessage({ ...invoiceMessage(), attachments: [item] });
  const raw = new TextDecoder().decode(result.raw);
  assert.match(raw, /filename\*(?:0\*)?=/i);assert.ok(!raw.includes('Bcc:'));
  const buffer = new Uint8Array([1, 2]);
  const efficient = createArsysMail({ createTransport: () => ({ sendMail: async () => ({ message: buffer }), close() {} }) });
  assert.equal((await efficient.buildMessage(invoiceMessage())).raw, buffer);
  const oversized = createArsysMail({ createTransport: options => {
    assert.equal(options.streamTransport, true);
    return { sendMail: async () => ({ message: new Uint8Array(20_000_001) }), close() {} };
  } });
  await assert.rejects(oversized.buildMessage(invoiceMessage()), error => error.code === 'MAIL_MESSAGE_TOO_LARGE');
});
