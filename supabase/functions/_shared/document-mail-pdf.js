import { createPDF } from '../../../src/pdf.js';
import logoData from '../../../public/orquivia-logo-wordmark.png';

export async function renderDocumentPdf(document, company, client) {
  return new Uint8Array(createPDF(document, company, client, { logoData }).output('arraybuffer'));
}

export function mailLogoBytes() {
  return Uint8Array.from(atob(logoData.split(',')[1]), character => character.charCodeAt(0));
}
