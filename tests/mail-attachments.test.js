import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_ATTACHMENT_LIMITS, MAIL_ATTACHMENT_ACCEPT, validateMailAttachments, readMailAttachments,
  encodeMailAttachments, decodeMailAttachments, mailAttachmentMetadata, formatMailAttachmentSize } from '../src/mail-attachments.js';

const pdf = new TextEncoder().encode('%PDF-1.7\nSynthetic document\n%%EOF');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 255]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
const attachment = (name = 'justificante.pdf', bytes = pdf, contentType = 'application/pdf') => ({ name, contentType, bytes });
const denied = (operation, code = 'INVALID_ATTACHMENT') => assert.throws(operation, error => error.code === code);
const sizedPDF = size => { const bytes = new Uint8Array(size);bytes.set(pdf.subarray(0, Math.min(size, pdf.length)));return bytes; };

test('attachment byte encoding round-trips PDF, JPEG and PNG without trusting the supplied MIME type', async () => {
  const input = [attachment('Justificación.pdf'), attachment('Ticket.JPG', jpeg, 'image/jpeg'), attachment('imagen.png', png, 'image/png')];
  const encoded = encodeMailAttachments(input), decoded = decodeMailAttachments(encoded);
  assert.deepEqual(decoded, input);
  assert.deepEqual(Object.keys(encoded[0]), ['name', 'contentType', 'contentBase64']);
  const meta = await mailAttachmentMetadata(decoded);
  assert.equal(meta[0].size, pdf.length);assert.match(meta[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(meta[0]), ['name', 'contentType', 'size', 'sha256']);
  assert.ok(!JSON.stringify(meta).includes('contentBase64'));
  const changed = await mailAttachmentMetadata([attachment('Justificación.pdf', new Uint8Array([...pdf, 0]))]);
  assert.notEqual(changed[0].sha256, meta[0].sha256);
  denied(() => validateMailAttachments([attachment('renamed.pdf', png)]));
  denied(() => validateMailAttachments([attachment('ticket.jpg', jpeg, 'application/pdf')]));
});

test('batch metadata limits reject before file reading and a rejected selection preserves all existing bytes', async () => {
  let reads = 0;
  const file = (name, size = pdf.length) => ({ name, size, type: 'application/pdf', arrayBuffer: async () => { ++reads;return pdf.slice().buffer; } });
  await assert.rejects(readMailAttachments(Array.from({ length: 6 }, (_, index) => file(`${index}.pdf`))), error => error.code === 'ATTACHMENT_LIMIT');
  assert.equal(reads, 0);
  await assert.rejects(readMailAttachments([file('too-big.pdf', MAIL_ATTACHMENT_LIMITS.eachBytes + 1)]), error => error.code === 'ATTACHMENT_LIMIT');
  assert.equal(reads, 0);
  await assert.rejects(readMailAttachments([file('one.pdf', 5_000_000), file('two.pdf', 5_000_000), file('three.pdf')]), error => error.code === 'ATTACHMENT_LIMIT');
  assert.equal(reads, 0);
  const existing = [attachment()];
  await assert.rejects(readMailAttachments([file('JUSTIFICANTE.pdf')], existing), error => error.code === 'INVALID_ATTACHMENT');
  assert.equal(reads, 0);assert.equal(existing.length, 1);assert.deepEqual(existing[0].bytes, pdf);
  await assert.rejects(readMailAttachments([file('empty.pdf', 0)], existing), error => error.code === 'INVALID_ATTACHMENT');
  assert.equal(reads, 0);
});

test('File reads derive content types from actual bytes, normalize names and reject declared-size or content mismatches atomically', async () => {
  const file = new File([pdf], '  Justificacio\u0301n.PDF  ', { type: 'text/html' });
  const result = await readMailAttachments([file]);
  assert.equal(result[0].name, 'Justificación.PDF');assert.equal(result[0].contentType, 'application/pdf');assert.deepEqual(result[0].bytes, pdf);
  const existing = [attachment()];
  await assert.rejects(readMailAttachments([new File(['<html>not a pdf</html>'], 'false.pdf')], existing), error => error.code === 'INVALID_ATTACHMENT');
  assert.deepEqual(existing, [attachment()]);
  await assert.rejects(readMailAttachments([{ name: 'size.pdf', size: 1, arrayBuffer: async () => pdf.slice().buffer }]), error => error.code === 'INVALID_ATTACHMENT');
});

test('empty, executable, header-injected, hidden, path and duplicate names cannot become mail attachment options', () => {
  for (const name of ['', '../file.pdf', 'folder/file.pdf', 'C:\\file.pdf', '.hidden.pdf', 'file.pdf\r\nBcc: victim@example.test',
    'file\u202Efdp.pdf', 'file.html', 'file.svg', 'file.exe', 'a'.repeat(141) + '.pdf', 'file<image>.pdf']) {
    denied(() => validateMailAttachments([attachment(name)]));
  }
  denied(() => validateMailAttachments([attachment('zero.pdf', new Uint8Array())]));
  denied(() => validateMailAttachments([attachment('duplicate.pdf'), attachment('DUPLICATE.pdf')]));
  denied(() => validateMailAttachments([attachment('Justificacio\u0301n.pdf'), attachment('Justificación.pdf')]));
  const normalized = validateMailAttachments([{ ...attachment(), path: 'https://example.test/private', cid: 'injected', href: 'file:///etc/passwd' }]);
  assert.deepEqual(Object.keys(normalized[0]), ['name', 'contentType', 'bytes']);
  const encoded = encodeMailAttachments([attachment()]);
  denied(() => decodeMailAttachments([{ ...encoded[0], path: 'https://example.test/private' }]));
});

test('base64 rejects URL encodings, whitespace, malformed padding and noncanonical pad bits', () => {
  for (const contentBase64 of ['', ' ', 'data:application/pdf;base64,JVBERi0=', 'JVBERi0=\n', 'Zg=', 'Zg===', 'Zh==', 'Zm9=', '-_==', '====', 'A===']) {
    denied(() => decodeMailAttachments([{ name: 'document.pdf', contentType: 'application/pdf', contentBase64 }]));
  }
  denied(() => decodeMailAttachments({ name: 'document.pdf' }));
  denied(() => decodeMailAttachments(null));
});

test('real per-file and aggregate byte boundaries hold across the whole batch and encoding avoids argument-size limits', () => {
  const full = attachment('full.pdf', sizedPDF(MAIL_ATTACHMENT_LIMITS.eachBytes));
  assert.equal(validateMailAttachments([full])[0].bytes.byteLength, 5_000_000);
  const encoded = encodeMailAttachments([full]);
  assert.equal(decodeMailAttachments(encoded)[0].bytes.byteLength, 5_000_000);
  const other = { ...full, name: 'other.pdf' };
  assert.equal(validateMailAttachments([full, other]).length, 2);
  denied(() => validateMailAttachments([full, other, attachment('extra.pdf')]), 'ATTACHMENT_LIMIT');
  denied(() => validateMailAttachments([attachment('too-big.pdf', sizedPDF(5_000_001))]), 'ATTACHMENT_LIMIT');
  denied(() => decodeMailAttachments([{ ...encoded[0], contentBase64: encoded[0].contentBase64 + 'AAAA' }]), 'ATTACHMENT_LIMIT');
});

test('file picker and visible sizes use the same decimal MB limits as the server', () => {
  assert.equal(MAIL_ATTACHMENT_LIMITS.count, 5);assert.equal(MAIL_ATTACHMENT_LIMITS.totalBytes, 10_000_000);
  assert.match(MAIL_ATTACHMENT_ACCEPT, /\.pdf/);assert.match(MAIL_ATTACHMENT_ACCEPT, /\.png/);assert.ok(!MAIL_ATTACHMENT_ACCEPT.includes('svg'));
  assert.equal(formatMailAttachmentSize(5_000_000), '5 MB');assert.equal(formatMailAttachmentSize(10_000_000), '10 MB');
  assert.equal(formatMailAttachmentSize(1500), '1,5 KB');assert.equal(formatMailAttachmentSize(0), '0 B');assert.equal(formatMailAttachmentSize(-1), '—');
});
