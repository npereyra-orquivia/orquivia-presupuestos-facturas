import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The classifier is independent of the DOM. CSS is handled by Vite in the app;
// strip that one side-effect import to exercise the real export in Node.
const source = (await readFile(new URL('../src/receipt-viewer.js', import.meta.url), 'utf8'))
  .replace(/^import '\.\/receipt-viewer\.css';\r?\n/, '');
const { receiptPreviewKind } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('original PDFs and supported raster photos can be previewed', () => {
  assert.equal(receiptPreviewKind({ name: 'Factura.pdf', mimeType: 'application/pdf' }), 'pdf');
  for (const [extension, mimeType] of [
    ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'],
    ['webp', 'image/webp'], ['gif', 'image/gif'], ['heic', 'image/heic'], ['heif', 'image/heif'],
  ]) {
    assert.equal(receiptPreviewKind({ name: `Ticket.${extension}`, mimeType }), 'image');
  }
});

test('browser file metadata and case-insensitive MIME parameters are accepted', () => {
  assert.equal(receiptPreviewKind({ name: 'FACTURA.PDF', type: 'Application/PDF; charset=binary' }), 'pdf');
  assert.equal(receiptPreviewKind({ name: 'Foto.JPEG', mimeType: ' IMAGE/JPEG ' }), 'image');
});

test('active documents and filename disguises never become inline media', () => {
  for (const attachment of [
    { name: 'invoice.pdf', mimeType: 'text/html' },
    { name: 'invoice.pdf', mimeType: 'application/xhtml+xml' },
    { name: 'photo.png', mimeType: 'image/svg+xml' },
    { name: 'photo.svg', mimeType: 'image/png' },
    { name: 'invoice.pdf.html', mimeType: 'application/pdf' },
    { name: 'photo.jpg.svg', mimeType: 'image/jpeg' },
    { name: 'invoice.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { name: 'invoice.pdf', mimeType: 'application/octet-stream' },
  ]) {
    assert.equal(receiptPreviewKind(attachment), 'unsupported', `${attachment.name} / ${attachment.mimeType}`);
  }
});

test('incomplete metadata and MIME/format conflicts fail closed', () => {
  for (const attachment of [
    null, undefined, {}, { name: 'invoice.pdf' }, { mimeType: 'application/pdf' },
    { name: 'invoice.pdf', mimeType: 'image/jpeg' },
    { name: 'photo.jpg', mimeType: 'application/pdf' },
  ]) {
    assert.equal(receiptPreviewKind(attachment), 'unsupported');
  }
});
