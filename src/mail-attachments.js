export const MAIL_ATTACHMENT_LIMITS = Object.freeze({
  count: 5,
  eachBytes: 5_000_000,
  totalBytes: 10_000_000,
  bodyBytes: 14_000_000,
  rawBytes: 20_000_000,
  bufferedBytes: 50_000_000,
});

export const MAIL_ATTACHMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const EXTENSION_TYPES = Object.freeze({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' });
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const fail = (code, message) => Object.assign(new Error(message), { code });
const invalid = message => fail('INVALID_ATTACHMENT', message || 'Solo se admiten documentos PDF e imágenes JPG o PNG con contenido válido.');
const limit = message => fail('ATTACHMENT_LIMIT', message);

function attachmentName(value) {
  if (typeof value !== 'string') throw invalid('Revisa el nombre del archivo adjunto.');
  const name = value.normalize('NFC').trim();
  if (!name || name.length > 140 || name.startsWith('.') || /[\\/:<>"|?*\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw invalid('Usa un nombre de archivo de hasta 140 caracteres, sin rutas ni caracteres especiales.');
  }
  const extension = name.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  if (!Object.hasOwn(EXTENSION_TYPES, extension || '')) throw invalid();
  return { name, contentType: EXTENSION_TYPES[extension] };
}

function contentType(bytes) {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png';
  return null;
}

function checkedList(value) {
  if (!Array.isArray(value)) throw invalid('La lista de archivos adjuntos no es válida.');
  if (value.length > MAIL_ATTACHMENT_LIMITS.count) throw limit('Puedes añadir hasta 5 archivos adicionales.');
  return value;
}

function checkedSize(size) {
  if (!Number.isSafeInteger(size) || size < 1) throw invalid('No se pueden adjuntar archivos vacíos.');
  if (size > MAIL_ATTACHMENT_LIMITS.eachBytes) throw limit('Cada adjunto puede ocupar como máximo 5 MB.');
  return size;
}

function checkedTotal(size) {
  if (size > MAIL_ATTACHMENT_LIMITS.totalBytes) throw limit('Los adjuntos adicionales no pueden superar 10 MB entre todos.');
}

/** Returns only data fields; provider paths, URLs and arbitrary MIME options never pass through. */
export function validateMailAttachments(value = []) {
  const names = new Set(); let total = 0;
  return checkedList(value).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid();
    const checked = attachmentName(item.name);
    if (!(item.bytes instanceof Uint8Array)) throw invalid('No se ha podido leer el contenido del archivo.');
    total += checkedSize(item.bytes.byteLength); checkedTotal(total);
    const key = checked.name.toLowerCase();
    if (names.has(key)) throw invalid('No puedes adjuntar dos archivos con el mismo nombre.');
    names.add(key);
    if (item.contentType !== checked.contentType || contentType(item.bytes) !== checked.contentType) throw invalid();
    return { ...checked, bytes: item.bytes };
  });
}

/** Inspect batch metadata before reading any File. A failed selection leaves existing files untouched. */
export async function readMailAttachments(files, existing = []) {
  const kept = validateMailAttachments(existing);
  if (!files || !Number.isSafeInteger(files.length) || files.length < 0) throw invalid();
  if (kept.length + files.length > MAIL_ATTACHMENT_LIMITS.count) throw limit('Puedes añadir hasta 5 archivos adicionales.');
  const names = new Set(kept.map(item => item.name.toLowerCase()));
  let total = kept.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  const selected = Array.from(files).map(file => {
    if (!file || typeof file.arrayBuffer !== 'function') throw invalid('No se ha podido leer el archivo seleccionado.');
    const checked = attachmentName(file.name);
    total += checkedSize(file.size); checkedTotal(total);
    if (names.has(checked.name.toLowerCase())) throw invalid('No puedes adjuntar dos archivos con el mismo nombre.');
    names.add(checked.name.toLowerCase());
    return { file, checked };
  });
  const added = [];
  for (const { file, checked } of selected) {
    let buffer;
    try { buffer = await file.arrayBuffer(); } catch { throw invalid('No se ha podido leer el archivo seleccionado.'); }
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== file.size) throw invalid('El tamaño del archivo no coincide con su contenido.');
    added.push({ ...checked, bytes: new Uint8Array(buffer) });
  }
  return validateMailAttachments([...kept, ...added]);
}

function toBase64(bytes) {
  const parts = [];
  // A multiple of three prevents interior padding. Bound the spread/string allocation.
  for (let offset = 0; offset < bytes.length; offset += 24_576) parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576))));
  return parts.join('');
}

function encodedSize(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || value.length > Math.ceil(MAIL_ATTACHMENT_LIMITS.eachBytes / 3) * 4) {
    if (typeof value === 'string' && value.length > Math.ceil(MAIL_ATTACHMENT_LIMITS.eachBytes / 3) * 4) throw limit('Cada adjunto puede ocupar como máximo 5 MB.');
    throw invalid('El contenido del archivo adjunto no es válido.');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid('El contenido del archivo adjunto no es válido.');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const last = BASE64_ALPHABET.indexOf(value[value.length - padding - 1]);
  if ((padding === 2 && last % 16 !== 0) || (padding === 1 && last % 4 !== 0)) throw invalid('El contenido del archivo adjunto no es válido.');
  return checkedSize(value.length / 4 * 3 - padding);
}

function fromBase64(value, size) {
  const bytes = new Uint8Array(size); let offset = 0;
  for (let start = 0; start < value.length; start += 32_768) {
    const chunk = atob(value.slice(start, start + 32_768));
    for (let index = 0; index < chunk.length; index++) bytes[offset++] = chunk.charCodeAt(index);
  }
  return bytes;
}

export function encodeMailAttachments(value = []) {
  return validateMailAttachments(value).map(item => ({ name: item.name, contentType: item.contentType, contentBase64: toBase64(item.bytes) }));
}

/** Strict wire format. Validate encoded lengths for the whole batch before allocating bytes. */
export function decodeMailAttachments(value = []) {
  let total = 0; const names = new Set();
  const selected = checkedList(value).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['name', 'contentType', 'contentBase64'].includes(key))) throw invalid();
    const checked = attachmentName(item.name), size = encodedSize(item.contentBase64);
    total += size; checkedTotal(total);
    if (names.has(checked.name.toLowerCase())) throw invalid('No puedes adjuntar dos archivos con el mismo nombre.');
    names.add(checked.name.toLowerCase());
    if (item.contentType !== checked.contentType) throw invalid();
    return { ...checked, size, contentBase64: item.contentBase64 };
  });
  return validateMailAttachments(selected.map(item => ({ name: item.name, contentType: item.contentType, bytes: fromBase64(item.contentBase64, item.size) })));
}

export async function mailAttachmentMetadata(value = []) {
  const result = [];
  for (const item of validateMailAttachments(value)) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', item.bytes));
    result.push({ name: item.name, contentType: item.contentType, size: item.bytes.byteLength,
      sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') });
  }
  return result;
}

export function formatMailAttachmentSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const value = bytes < 1_000_000 ? bytes / 1000 : bytes / 1_000_000;
  return `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1, useGrouping: false }).format(value)} ${bytes < 1_000_000 ? 'KB' : 'MB'}`;
}
