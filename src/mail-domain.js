import { escapeHTML as esc } from './domain.js';
import { isMailAddress } from './mail-address.js';

export { isMailAddress } from './mail-address.js';

export const MAIL_PROVIDERS = Object.freeze([
  Object.freeze({ value: 'serviciodecorreo', label: 'Arsys · serviciodecorreo.es' }),
  Object.freeze({ value: 'arsys', label: 'Arsys · arsys.es' }),
]);

export const MAIL_STATUS = Object.freeze({
  not_configured: { label: 'Correo sin conectar', description: 'Conecta tu cuenta de Arsys en Mi espacio para enviar desde Orquívia.', tone: 'neutral' },
  sending: { label: 'Envío en curso', description: 'Se está comprobando el resultado del envío. No vuelvas a enviar este documento.', tone: 'pending' },
  sent: { label: 'Enviado', description: 'El servidor ha confirmado el envío y se ha guardado su copia en Enviados.', tone: 'success' },
  archive_pending: { label: 'Enviado · copia pendiente', description: 'El servidor ha confirmado el envío. Falta guardar la copia en Enviados; puedes reintentar solo esa copia.', tone: 'pending' },
  uncertain: { label: 'Resultado por confirmar', description: 'No hay una confirmación definitiva. Actualiza el estado y comprueba el correo antes de plantear otro envío.', tone: 'pending' },
  failed: { label: 'No enviado', description: 'El servidor ha confirmado que este intento no se ha enviado.', tone: 'error' },
});

export function mailStatus(status) {
  return MAIL_STATUS[status] || { label: 'Estado por comprobar', description: 'Actualiza el historial para comprobar el resultado.', tone: 'neutral' };
}

const HEADER_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** Plain addresses only: reject the whole field if any recipient is malformed. */
export function parseMailRecipients(value) {
  if (value === undefined || value === null || value === '') return [];
  const entries = Array.isArray(value) ? value : [value];
  const result = [], seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string' || HEADER_CONTROLS.test(entry)) throw new Error('Escribe direcciones de correo válidas, separadas por comas o punto y coma.');
    // A blank optional field is allowed; an empty member of a submitted list
    // cannot conceal an invalid or accidentally omitted recipient.
    if (!Array.isArray(value) && !entry.trim()) return [];
    for (const part of entry.split(/[,;]/)) {
      const address = part.trim(), key = address.toLowerCase();
      if (!isMailAddress(address)) throw new Error('Escribe direcciones de correo válidas, separadas por comas o punto y coma.');
      if (!seen.has(key)) { result.push(address); seen.add(key); }
    }
  }
  return result;
}

export function defaultMailSignature(user = {}) {
  const email = String(user.email || '').trim().toLowerCase();
  return { name: String(user.user_metadata?.name || user.email?.split('@')[0] || '').slice(0, 100), role: '', phone: '' };
}

export function defaultMailProfile(user = {}) {
  return { email: String(user.email || '').trim(), connected: false, provider: 'serviciodecorreo', signature: defaultMailSignature(user), version: 0 };
}

export function normalizeMailProfile(profile, user = {}) {
  const base = defaultMailProfile(user);
  return {
    email: base.email,
    connected: profile?.connected === true,
    provider: MAIL_PROVIDERS.some(item => item.value === profile?.provider) ? profile.provider : base.provider,
    signature: { ...base.signature, ...(profile?.signature || {}) },
    version: Number.isSafeInteger(profile?.version) && profile.version >= 0 ? profile.version : 0,
  };
}

export function validateMailSignature(signature = {}) {
  const value = {}, errors = {};
  for (const [field, max] of [['name', 100], ['role', 120], ['phone', 40]]) {
    const raw = typeof signature[field] === 'string' ? signature[field] : '';
    value[field] = raw.trim();
    if (raw.length > max || /[\u0000-\u001f\u007f]/.test(raw)) errors[field] = `Revisa ${field === 'name' ? 'el nombre' : field === 'role' ? 'el cargo' : 'el teléfono'} de la firma.`;
  }
  if (!value.name) errors.name = 'Escribe el nombre que aparecerá en tu firma.';
  if (value.phone && !/^[+\d\s().-]+$/.test(value.phone)) errors.phone = 'Escribe un teléfono con números y, si corresponde, su prefijo.';
  return { ok: Object.keys(errors).length === 0, value, errors };
}

export function validateMailDraft(draft = {}) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) draft = {};
  const errors = {};
  let to = [], cc = [];
  try { to = parseMailRecipients(draft.to); }
  catch { errors.to = 'Revisa todas las direcciones de los destinatarios.'; }
  try { cc = parseMailRecipients(draft.cc); }
  catch { errors.cc = 'Revisa todas las direcciones de copia (CC).'; }
  const primary = new Set(to.map(address => address.toLowerCase()));
  cc = cc.filter(address => !primary.has(address.toLowerCase()));
  const value = {
    to, cc,
    subject: typeof draft.subject === 'string' ? draft.subject.trim() : '',
    message: typeof draft.message === 'string' ? draft.message.replace(/\r\n?/g, '\n') : '',
  };
  if (!errors.to && (to.length < 1 || to.length > 20)) errors.to = 'Escribe entre 1 y 20 direcciones de correo para los destinatarios.';
  if (to.length + cc.length > 20) errors.cc = 'Puedes enviar a un máximo de 20 direcciones distintas entre Para y CC.';
  if (!value.subject || value.subject.length > 200 || HEADER_CONTROLS.test(draft.subject || '')) errors.subject = 'Escribe un asunto de hasta 200 caracteres, en una sola línea.';
  if (!value.message.trim() || value.message.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.message)) errors.message = 'Escribe un mensaje de hasta 20.000 caracteres.';
  return { ok: Object.keys(errors).length === 0, value, errors };
}

export function defaultMailDraft(document = {}, client = {}) {
  const invoice = document.kind === 'invoice';
  const kind = invoice ? 'factura' : 'presupuesto';
  const reference = String(document.number || '').trim();
  const recipient = (invoice ? [document.billingEmail, client.billingEmail, client.email] : [client.email])
    .filter(value => typeof value === 'string').map(value => value.trim()).find(isMailAddress);
  const po = invoice && typeof document.po === 'string' ? document.po.trim() : '';
  return {
    to: recipient ? [recipient] : [''],
    cc: [],
    subject: `${kind === 'factura' ? 'Factura' : 'Presupuesto'}${reference ? ` ${reference}` : ''} · Orquívia`.slice(0, 200),
    message: `Hola,\n\nTe adjunto ${invoice ? 'la' : 'el'} ${kind}${reference ? ` ${reference}` : ''} para que puedas ${invoice ? 'tramitarla' : 'revisarlo'}.${po ? `\n\nOrden de pedido (PO): ${po}` : ''}\n\nQuedo a tu disposición para cualquier consulta.\n\nUn saludo,`,
  };
}

export function mailAttachmentName(document = {}) {
  const reference = String(document.number || 'borrador').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'borrador';
  return `${document.kind === 'invoice' ? 'factura' : 'presupuesto'}-${reference}.pdf`;
}

export function mailRecipientSuggestions(history = [], limit = 8) {
  const values = [], seen = new Set();
  for (const entry of [...history].sort((a, b) => String(b.createdAt || b.created_at || '').localeCompare(String(a.createdAt || a.created_at || '')))) {
    for (const field of [entry.to, entry.cc]) {
      let addresses;
      try { addresses = parseMailRecipients(field); }
      catch { continue; }
      for (const address of addresses) {
        const key = address.toLowerCase();
        if (seen.has(key)) continue;
        values.push(address); seen.add(key);
        if (values.length >= Math.max(1, Math.min(limit, 20))) return values;
      }
    }
  }
  return values;
}

function signatureLogoUrl(value) {
  if (typeof value !== 'string') return '';
  if (/^cid:orquivia-logo$/.test(value)) return value;
  if (value === './orquivia-logo-wordmark.png') return value;
  if (/^\/(?!\/)[A-Za-z0-9_./% -]+$/.test(value) && !value.includes('..')) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}

/** Structured content only: no saved HTML, uploaded images or editable sender. */
export function renderMailSignature(signature, { email = '', logoUrl = 'cid:orquivia-logo' } = {}) {
  const value = validateMailSignature(signature).value;
  const address = isMailAddress(email) ? email : '';
  const logo = signatureLogoUrl(logoUrl);
  const telephone = value.phone.replace(/[^+\d]/g, '');
  return `<table role="presentation" class="mail-signature-table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;color:#18312c;font-size:13px;line-height:1.5"><tr><td style="border:0;border-left:3px solid #20343c;padding:4px 0 4px 12px">${logo ? `<img src="${esc(logo)}" alt="Orquívia" width="190" style="display:block;width:190px;max-width:190px;height:auto;border:0;margin-bottom:8px">` : ''}<strong style="display:block;font-size:16px;font-weight:600">${esc(value.name)}</strong>${value.role ? `<span style="display:block;color:#526875">${esc(value.role)}</span>` : ''}<div style="margin-top:16px">${value.phone ? `M: <a href="tel:${esc(telephone)}" style="color:#637b82;text-decoration:none">${esc(value.phone)}</a>${address ? ' &nbsp;|&nbsp; ' : ''}` : ''}${address ? `<a href="mailto:${esc(address)}" style="color:#174fa8;text-decoration:underline">${esc(address)}</a>` : ''}</div></td></tr></table>`;

}
