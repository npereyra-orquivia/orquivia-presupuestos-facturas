import { todayISO, validateWorkspace } from './domain.js';

const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const MAX_JSON_DEPTH = 40;
const MAX_IDLE_MS = 30 * 60 * 1000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decodeJWTPart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length % 4 === 1) throw new Error('JWT inválido');
  const base64 = part.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Only a public Supabase project URL and a public, anonymous key may enter the browser. */
export function publicConfigIsValid(config) {
  if (!isRecord(config)) return false;
  const { url, anonKey } = config;
  if (typeof url !== 'string' || typeof anonKey !== 'string' || anonKey.length > 16384) return false;
  // Check the original spelling too: URL parsing otherwise hides default ports and whitespace.
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url)) return false;
  if (/[\s\p{Cc}]/u.test(anonKey)) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(anonKey)) return true;
  const parts = anonKey.split('.');
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const header = decodeJWTPart(parts[0]), payload = decodeJWTPart(parts[1]);
    return isRecord(header) && typeof header.alg === 'string' && header.alg.toLowerCase() !== 'none'
      && isRecord(payload) && Object.hasOwn(payload, 'role') && payload.role === 'anon';
  } catch { return false; }
}

function copyPlainJSON(input, maxBytes) {
  const ancestors = new Set();
  let budgetUsed = 0;
  const charge = (value) => {
    budgetUsed += encoder.encode(value).byteLength;
    if (budgetUsed > maxBytes) throw new Error('La copia supera el tamaño permitido.');
  };
  const visit = (value, depth = 0) => {
    if (depth > MAX_JSON_DEPTH) throw new Error('La copia contiene demasiados niveles de datos.');
    if (value === null) { charge('null'); return null; }
    if (typeof value === 'string') { charge(JSON.stringify(value)); return value; }
    if (typeof value === 'boolean') { charge(String(value)); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { charge(JSON.stringify(value)); return value; }
    if (typeof value !== 'object' || (!Array.isArray(value) && !isRecord(value))) {
      throw new Error('La copia contiene valores que no son datos JSON.');
    }
    if (ancestors.has(value)) throw new Error('La copia contiene una referencia circular.');
    ancestors.add(value);
    charge('[]');
    const array = Array.isArray(value), copy = array ? [] : {};
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) throw new Error('Las listas de la copia contienen propiedades o posiciones inválidas.');
    let entries = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) throw new Error('La copia contiene una propiedad no permitida.');
      if (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
        throw new Error('Las listas de la copia contienen propiedades inválidas.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('La copia contiene propiedades que no son datos JSON.');
      }
      if (entries++ > 0) charge(',');
      if (!array) charge(`${JSON.stringify(key)}:`);
      copy[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
    return copy;
  };
  const copy = visit(input);
  if (encoder.encode(JSON.stringify(copy)).byteLength > maxBytes) throw new Error('La copia supera el tamaño permitido.');
  return copy;
}

/** Validate before replacing any data; preserve document evidence, snapshots and metadata. */
export function prepareRestore(input, { today = todayISO(), maxBytes = MAX_BACKUP_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BACKUP_BYTES) {
    throw new Error('El límite de la copia debe estar entre 1 byte y 5 MiB.');
  }
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)
      || !Number.isFinite(Date.parse(`${today}T00:00:00Z`))
      || new Date(`${today}T00:00:00Z`).toISOString().slice(0, 10) !== today) {
    throw new Error('La fecha de validación no es válida.');
  }
  let parsed = input;
  if (typeof input === 'string') {
    if (encoder.encode(input).byteLength > maxBytes) throw new Error('La copia supera el tamaño permitido.');
    try { parsed = JSON.parse(input); }
    catch { throw new Error('El archivo no contiene una copia JSON válida.'); }
  }
  const cloned = copyPlainJSON(parsed, maxBytes);
  if (!isRecord(cloned)) throw new Error('La copia debe contener un objeto de datos.');
  const state = Object.hasOwn(cloned, 'state') ? cloned.state : cloned;
  const errors = validateWorkspace(state, today);
  if (errors.length) throw new Error(`La copia no es válida: ${errors.slice(0, 5).join(' ')}`);
  return { company: state.company, clients: state.clients, documents: state.documents, payments: state.payments, ...(Object.hasOwn(state, 'expenses') ? { expenses: state.expenses } : {}) };
}

/** Invalid or future activity times fail closed; a caller cannot extend the 30-minute cap. */
export function sessionShouldLock({ lastActivityAt, now = Date.now(), timeoutMs = MAX_IDLE_MS } = {}) {
  if (![lastActivityAt, now, timeoutMs].every((value) => typeof value === 'number' && Number.isFinite(value))
      || lastActivityAt < 0 || now < 0 || lastActivityAt > now || timeoutMs <= 0) return true;
  return now - lastActivityAt >= Math.min(timeoutMs, MAX_IDLE_MS);
}

/** Passwords are compared exactly and never trimmed or normalized. Length counts code points. */
export function validatePasswordChange({ currentPassword, newPassword, repeatPassword } = {}) {
  const errors = [];
  if (typeof currentPassword !== 'string' || currentPassword.length === 0) errors.push('Introduce tu contraseña actual.');
  const length = typeof newPassword === 'string' ? Array.from(newPassword).length : 0;
  if (length < 12 || length > 128) errors.push('La nueva contraseña debe tener entre 12 y 128 caracteres.');
  if (typeof newPassword !== 'string' || typeof repeatPassword !== 'string' || newPassword !== repeatPassword) {
    errors.push('La confirmación no coincide con la nueva contraseña.');
  }
  if (typeof newPassword === 'string' && typeof currentPassword === 'string' && newPassword === currentPassword) {
    errors.push('La nueva contraseña debe ser distinta de la actual.');
  }
  return errors;
}
