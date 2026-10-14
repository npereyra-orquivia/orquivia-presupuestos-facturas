const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const QUOTE_STATUSES = new Set(['draft', 'sent', 'accepted', 'rejected']);
const INVOICE_STATUSES = new Set(['issued', 'paid', 'partial', 'overdue']);
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

/** The calendar date in Madrid, independent of the device's configured timezone. */
export function todayISO(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function money(value) {
  return EUR.format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

// Convert decimal input into an exact fraction before doing any money arithmetic.
// This also handles exponential notation emitted by String(number).
function fraction(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const source = String(value).trim().replace(',', '.');
  if (source.length > 1000) return null;
  const match = source.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match || (!match[2] && !match[3])) return null;
  const exponent = Number(match[4] || 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 400) return null;
  const digits = `${match[2] || ''}${match[3] || ''}`;
  let numerator = BigInt(digits || '0') * (match[1] === '-' ? -1n : 1n);
  const scale = (match[3] || '').length - exponent;
  let denominator = 1n;
  if (scale > 0) denominator = 10n ** BigInt(scale);
  else numerator *= 10n ** BigInt(-scale);
  return { numerator, denominator };
}

function roundFraction(numerator, denominator) {
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator * sign;
  return sign * ((absolute + denominator / 2n) / denominator);
}

function signedMoneyCents(value) {
  const parsed = fraction(value);
  return parsed ? roundFraction(parsed.numerator * 100n, parsed.denominator) : 0n;
}

function positiveFraction(value) {
  const parsed = fraction(value);
  return parsed && parsed.numerator >= 0n ? parsed : { numerator: 0n, denominator: 1n };
}

function rateFraction(value) {
  const parsed = positiveFraction(value ?? 0);
  return parsed.numerator > parsed.denominator * 100n
    ? { numerator: 100n, denominator: 1n } : parsed;
}

function percentOf(cents, rate) {
  const parsed = rateFraction(rate);
  return roundFraction(cents * parsed.numerator, parsed.denominator * 100n);
}

function totalCents(doc = {}) {
  doc ??= {};
  const subtotal = (Array.isArray(doc.items) ? doc.items : []).reduce((sum, item) => {
    const quantity = positiveFraction(item?.quantity);
    const price = positiveFraction(item?.price);
    const line = roundFraction(quantity.numerator * price.numerator * 100n,
      quantity.denominator * price.denominator);
    return sum + line;
  }, 0n);
  const discountAmount = percentOf(subtotal, doc.discount);
  const base = subtotal - discountAmount;
  const vatAmount = percentOf(base, doc.vat);
  const withholdingAmount = percentOf(base, doc.withholding);
  return { subtotal, discountAmount, base, vatAmount, withholdingAmount,
    total: base + vatAmount - withholdingAmount };
}

/** Round each line, discount and tax to cents; percentages apply to the discounted base. */
export function totals(doc = {}) {
  return Object.fromEntries(Object.entries(totalCents(doc)).map(([key, value]) => [key, Number(value) / 100]));
}

function paymentCents(doc, payments = []) {
  if (!doc?.id || !Array.isArray(payments)) return 0n;
  return payments.reduce((sum, payment) => {
    if (payment?.documentId !== doc.id) return sum;
    const amount = positiveFraction(payment.amount);
    return sum + roundFraction(amount.numerator * 100n, amount.denominator);
  }, 0n);
}

export function paidAmount(doc, payments = []) {
  return Number(paymentCents(doc, payments)) / 100;
}

export function outstanding(doc, payments = []) {
  const remaining = totalCents(doc).total - paymentCents(doc, payments);
  return Number(remaining > 0n ? remaining : 0n) / 100;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function status(doc, payments = [], today = todayISO()) {
  if (!doc) return 'draft';
  if (doc.kind === 'quote' || doc.kind === 'budget') {
    return QUOTE_STATUSES.has(doc.status) ? doc.status : 'draft';
  }
  if (doc.kind !== 'invoice' || !INVOICE_STATUSES.has(doc.status)) return 'draft';
  if (doc.paymentReviewNeeded === true) return 'review';
  const total = totalCents(doc).total;
  const paid = paymentCents(doc, payments);
  if (paid >= total) return 'paid';
  if (validDate(doc.dueDate) && validDate(today) && doc.dueDate < today) return 'overdue';
  return paid > 0n ? 'partial' : 'issued';
}

function readableDate(date) {
  return date.split('-').reverse().join('/');
}

/** Due today is a warning; a missed date is urgent. Paid invoices never create payment alerts. */
export function alerts(documents = [], payments = [], today = todayISO()) {
  if (!Array.isArray(documents) || !validDate(today)) return [];
  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
  const result = [];
  for (const doc of documents) {
    const currentStatus = status(doc, payments, today);
    if (currentStatus === 'draft' || currentStatus === 'rejected') continue;
    if (currentStatus === 'review' && validDate(doc.date)) {
      result.push({
        id: `review-${doc.id}`, documentId: doc.id, type: 'review',
        title: 'Confirmar estado del cobro',
        message: `${doc.number}: el documento importado no acredita si se ha cobrado. Revisa los movimientos bancarios y confirma el estado.`,
        date: doc.date, severity: 'warning',
      });
    }
    if (doc.kind === 'invoice' && !['paid', 'review'].includes(currentStatus) && validDate(doc.dueDate) && doc.dueDate <= today) {
      const late = doc.dueDate < today;
      result.push({
        id: `payment-${doc.id}`, documentId: doc.id, type: 'payment',
        title: late ? 'Cobro vencido' : 'Cobro previsto hoy',
        message: `${doc.number}: quedan ${money(outstanding(doc, payments))} por cobrar. Vencimiento: ${readableDate(doc.dueDate)}.`,
        date: doc.dueDate, severity: late ? 'danger' : 'warning',
      });
    }
    const linkedQuote = doc.kind === 'invoice' ? documentsById.get(doc.quoteId) : null;
    const sharedPendingContract = linkedQuote?.kind === 'quote'
      && ['sent', 'accepted'].includes(linkedQuote.status)
      && !linkedQuote.contractReceived
      && linkedQuote.contractExpectedDate === doc.contractExpectedDate;
    if (!sharedPendingContract && !doc.contractReceived && validDate(doc.contractExpectedDate) && doc.contractExpectedDate <= today) {
      const late = doc.contractExpectedDate < today;
      result.push({
        id: `contract-${doc.id}`, documentId: doc.id, type: 'contract',
        title: late ? 'Contrato pendiente' : 'Contrato previsto hoy',
        message: `${doc.number}: confirma la recepción del contrato previsto para el ${readableDate(doc.contractExpectedDate)}.`,
        date: doc.contractExpectedDate, severity: late ? 'danger' : 'warning',
      });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** Original numbers stay untouched. Their sequence can still seed the annual counter. */
export function sequenceFromNumber(kind, number, year) {
  if (!['quote', 'invoice'].includes(kind) || typeof number !== 'string' || !/^\d{4}$/.test(String(year))) return null;
  const prefix = kind === 'invoice' ? 'F' : 'PR';
  const match = number.trim().match(new RegExp(`^(?:${prefix}-)?${year}-(\\d+)$`, 'i'));
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

/** A local preview only. Production numbers must be assigned atomically by Supabase. */
export function nextNumber(kind, documents = [], year = Number(todayISO().slice(0, 4))) {
  if (!['quote', 'invoice'].includes(kind)) throw new Error('El tipo de documento no es válido.');
  const prefix = kind === 'invoice' ? 'F' : 'PR';
  const calendarYear = /^\d{4}$/.test(String(year)) ? String(year) : todayISO().slice(0, 4);
  let highest = 0;
  for (const doc of Array.isArray(documents) ? documents : []) {
    if (doc?.kind !== kind) continue;
    const sequence = sequenceFromNumber(kind, doc.number, calendarYear);
    if (sequence !== null && sequence > highest) highest = sequence;
  }
  if (highest === Number.MAX_SAFE_INTEGER) throw new Error('La numeración anual ha alcanzado el límite permitido.');
  return `${prefix}-${calendarYear}-${String(highest + 1).padStart(3, '0')}`;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error('El navegador no permite generar un identificador seguro.');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createInvoiceFromQuote(quote, documents = [], today = todayISO()) {
  if (!quote || (quote.kind !== 'quote' && quote.kind !== 'budget')) {
    throw new Error('Selecciona un presupuesto para crear la factura.');
  }
  if (!validDate(today)) throw new Error('La fecha de la factura no es válida.');
  const copy = typeof structuredClone === 'function'
    ? structuredClone(quote) : JSON.parse(JSON.stringify(quote));
  return {
    ...copy, id: uuid(), kind: 'invoice', status: 'draft',
    number: nextNumber('invoice', documents, Number(today.slice(0, 4))),
    date: today, dueDate: addDays(today, 30), quoteId: quote.id,
  };
}

function numericValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  if (typeof value === 'string' && !value.trim()) return NaN;
  const parsed = fraction(value);
  return parsed ? Number(parsed.numerator) / Number(parsed.denominator) : NaN;
}

export function validateDocument(doc) {
  if (!doc || typeof doc !== 'object') return ['El documento no es válido.'];
  const errors = [];
  if (!String(doc.clientId ?? '').trim()) errors.push('Selecciona un cliente.');
  if (doc.status !== 'draft' && !String(doc.number ?? '').trim()) errors.push('Indica el número del documento.');
  const dateIsValid = validDate(doc.date);
  if (!dateIsValid) errors.push('Indica una fecha de emisión válida.');
  if (doc.dueDate) {
    if (!validDate(doc.dueDate)) errors.push('La fecha de vencimiento no es válida.');
    else if (dateIsValid && doc.dueDate < doc.date) errors.push('El vencimiento no puede ser anterior a la fecha de emisión.');
  }
  if (doc.contractExpectedDate && !validDate(doc.contractExpectedDate)) errors.push('La fecha prevista del contrato no es válida.');
  if (!Array.isArray(doc.items) || doc.items.length === 0) errors.push('Añade al menos un concepto.');
  else doc.items.forEach((item, index) => {
    const label = `Concepto ${index + 1}`;
    if (!String(item?.description ?? '').trim()) errors.push(`${label}: indica una descripción.`);
    const quantity = numericValue(item?.quantity);
    const price = numericValue(item?.price);
    if (!Number.isFinite(quantity) || quantity <= 0) errors.push(`${label}: la cantidad debe ser mayor que cero.`);
    if (!Number.isFinite(price) || price < 0) errors.push(`${label}: el precio debe ser cero o mayor.`);
    else if (price * Math.max(quantity, 1) * 100 > Number.MAX_SAFE_INTEGER) errors.push(`${label}: el importe supera el límite permitido.`);
  });
  for (const [key, label] of [['discount', 'El descuento'], ['vat', 'El IVA'], ['withholding', 'La retención']]) {
    const rate = numericValue(doc[key] ?? 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) errors.push(`${label} debe estar entre 0 y 100.`);
  }
  if (Object.values(totalCents(doc)).some((value) => value > MAX_CENTS)) errors.push('El importe total supera el límite permitido.');
  return errors;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasPrecision(value, decimals) {
  const parsed = fraction(value);
  return parsed !== null && (parsed.numerator * 10n ** BigInt(decimals)) % parsed.denominator === 0n;
}

/**
 * Validate an imported or saved workspace without mutating, renumbering, or
 * replacing evidence from the original files. Metadata is ordinary JSON.
 */
export function validateWorkspace(workspace, today = todayISO()) {
  const errors = [];
  const error = (path, message) => errors.push(`${path}: ${message}`);
  if (!isRecord(workspace)) return ['workspace: los datos deben ser un objeto.'];
  const visitJSON = (value, path, ancestors = new Set(), depth = 0) => {
    if (value === null || ['string', 'boolean', 'undefined'].includes(typeof value)) return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) error(path, 'el número debe ser finito.');
      return;
    }
    if (depth > 40 || (typeof value === 'object' && ancestors.has(value))) {
      error(path, 'los datos contienen una referencia circular o demasiados niveles.');
      return;
    }
    if (!Array.isArray(value) && !isRecord(value)) {
      error(path, 'el valor no es compatible con JSON.');
      return;
    }
    ancestors.add(value);
    for (const [key, entry] of Object.entries(value)) visitJSON(entry, `${path}.${key}`, ancestors, depth + 1);
    ancestors.delete(value);
  };
  visitJSON(workspace, 'workspace');
  const requireString = (value, path, required = false) => {
    if (value === undefined && !required) return;
    if (typeof value !== 'string' || (required && !value.trim())) error(path, required ? 'indica un texto no vacío.' : 'debe ser un texto.');
  };
  const requireNumber = (value, path, { minimum = 0, maximum = Infinity, decimals = 2 } = {}) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      error(path, 'el número está fuera del intervalo permitido.');
    } else if (!hasPrecision(value, decimals)) error(path, `se admiten como máximo ${decimals} decimales.`);
  };
  if (!isRecord(workspace.company)) error('company', 'faltan los datos de empresa.');
  else {
    const company = workspace.company;
    requireString(company.name, 'company.name', true);
    for (const key of ['legalName', 'taxId', 'address', 'email', 'phone', 'iban', 'bic', 'notificationEmail']) requireString(company[key], `company.${key}`);
    for (const key of ['vat', 'withholding']) if (company[key] !== undefined) requireNumber(company[key], `company.${key}`, { maximum: 100 });
    if (company.paymentTerms !== undefined) requireNumber(company.paymentTerms, 'company.paymentTerms', { maximum: 365, decimals: 0 });
    if (company.emailNotifications !== undefined && typeof company.emailNotifications !== 'boolean') error('company.emailNotifications', 'debe ser verdadero o falso.');
    const hasOpeningAmount = company.openingBalance !== undefined && company.openingBalance !== null;
    const hasOpeningDate = company.openingBalanceDate !== undefined && company.openingBalanceDate !== null && company.openingBalanceDate !== '';
    if (hasOpeningAmount !== hasOpeningDate) error('company.openingBalance', 'indica juntos el saldo inicial y su fecha.');
    if (hasOpeningAmount) requireNumber(company.openingBalance, 'company.openingBalance', {
      minimum: -Number.MAX_SAFE_INTEGER / 100, maximum: Number.MAX_SAFE_INTEGER / 100 });
    if (hasOpeningDate && (!validDate(company.openingBalanceDate)
      || (validDate(today) && company.openingBalanceDate > today))) error('company.openingBalanceDate', 'indica una fecha válida que no esté en el futuro.');
  }
  for (const key of ['clients', 'documents', 'payments']) {
    if (!Array.isArray(workspace[key])) error(key, 'debe ser una lista.');
    else if (workspace[key].length > 10000) error(key, 'la lista supera el límite de 10000 registros.');
  }
  if (!['clients', 'documents', 'payments'].every((key) => Array.isArray(workspace[key]))) return errors;
  const { clients, documents, payments } = workspace;
  const maps = {};
  for (const [collection, records] of Object.entries({ clients, documents, payments })) {
    const map = new Map();
    records.forEach((record, index) => {
      const path = `${collection}[${index}]`;
      if (!isRecord(record)) { error(path, 'el registro debe ser un objeto.'); return; }
      requireString(record.id, `${path}.id`, true);
      if (typeof record.id === 'string' && record.id.trim()) {
        if (map.has(record.id)) error(`${path}.id`, 'el identificador está duplicado.');
        else map.set(record.id, record);
      }
    });
    maps[collection] = map;
  }
  clients.forEach((client, index) => {
    if (!isRecord(client)) return;
    const path = `clients[${index}]`;
    requireString(client.name, `${path}.name`, true);
    for (const key of ['taxId', 'email', 'address', 'contact']) requireString(client[key], `${path}.${key}`);
  });
  const numbers = new Set(), sequences = new Set(), linkedQuotes = new Set();
  documents.forEach((doc, index) => {
    if (!isRecord(doc)) return;
    const path = `documents[${index}]`;
    if (!['invoice', 'quote'].includes(doc.kind)) error(`${path}.kind`, 'el tipo debe ser invoice o quote.');
    const permittedStatuses = doc.kind === 'quote' ? QUOTE_STATUSES : new Set(['draft', ...INVOICE_STATUSES]);
    if (!permittedStatuses.has(doc.status)) error(`${path}.status`, 'el estado no es válido para este tipo de documento.');
    requireString(doc.clientId, `${path}.clientId`, true);
    if (!maps.clients.has(doc.clientId)) error(`${path}.clientId`, 'el cliente no existe.');
    requireString(doc.number, `${path}.number`, doc.status !== 'draft');
    if (typeof doc.number === 'string' && doc.number.trim()) {
      const key = `${doc.kind}:${doc.number.trim().toUpperCase()}`;
      if (numbers.has(key)) error(`${path}.number`, 'el número está duplicado dentro de este tipo de documento.');
      numbers.add(key);
      const yearMatch = doc.number.trim().match(/^(?:(?:F|PR)-)?(\d{4})-\d+$/i);
      if (yearMatch) {
        const sequence = sequenceFromNumber(doc.kind, doc.number, yearMatch[1]);
        if (sequence !== null) {
          const sequenceKey = `${doc.kind}:${yearMatch[1]}:${sequence}`;
          if (sequences.has(sequenceKey)) error(`${path}.number`, 'la secuencia anual ya está utilizada con otro formato de número.');
          sequences.add(sequenceKey);
        }
      }
    }
    for (const message of validateDocument(doc)) error(path, message);
    for (const key of ['title', 'notes', 'po', 'paymentMethod', 'originalNumber']) requireString(doc[key], `${path}.${key}`);
    for (const key of ['dueDate', 'contractExpectedDate']) {
      if (doc[key] !== undefined && doc[key] !== null && doc[key] !== '' && typeof doc[key] !== 'string') error(`${path}.${key}`, 'debe ser una fecha o estar sin confirmar.');
    }
    for (const key of ['contractReceived', 'paymentReviewNeeded', 'reviewRequired']) {
      if (doc[key] !== undefined && typeof doc[key] !== 'boolean') error(`${path}.${key}`, 'debe ser verdadero o falso.');
    }
    if (doc.kind === 'quote' && doc.paymentReviewNeeded === true) error(`${path}.paymentReviewNeeded`, 'la revisión de cobro solo corresponde a una factura.');
    for (const key of ['companySnapshot', 'clientSnapshot', 'sourceMetadata']) {
      if (doc[key] !== undefined && !isRecord(doc[key])) error(`${path}.${key}`, 'debe ser un objeto de datos.');
    }
    if (doc.importWarnings !== undefined && (!Array.isArray(doc.importWarnings) || doc.importWarnings.some((entry) => typeof entry !== 'string'))) error(`${path}.importWarnings`, 'debe ser una lista de textos.');
    for (const key of ['vat', 'discount', 'withholding']) if (doc[key] !== undefined) requireNumber(doc[key], `${path}.${key}`, { maximum: 100 });
    if (Array.isArray(doc.items)) doc.items.forEach((item, itemIndex) => {
      const itemPath = `${path}.items[${itemIndex}]`;
      if (!isRecord(item)) { error(itemPath, 'el concepto debe ser un objeto.'); return; }
      requireString(item.description, `${itemPath}.description`, true);
      requireString(item.detail, `${itemPath}.detail`);
      requireNumber(item.quantity, `${itemPath}.quantity`, { minimum: 0.001, maximum: Number.MAX_SAFE_INTEGER, decimals: 3 });
      requireNumber(item.price, `${itemPath}.price`, { maximum: Number.MAX_SAFE_INTEGER / 100 });
    });
    if (doc.total !== undefined) {
      requireNumber(doc.total, `${path}.total`, { maximum: Number.MAX_SAFE_INTEGER / 100 });
      const stored = fraction(doc.total);
      if (stored && stored.numerator * 100n !== totalCents(doc).total * stored.denominator) error(`${path}.total`, 'no coincide con el total calculado de conceptos e impuestos.');
    }
    if (doc.quoteId !== undefined && doc.quoteId !== null && doc.quoteId !== '') {
      requireString(doc.quoteId, `${path}.quoteId`, true);
      const quote = maps.documents.get(doc.quoteId);
      if (doc.kind !== 'invoice' || !quote || quote.kind !== 'quote' || quote.id === doc.id) error(`${path}.quoteId`, 'la relación debe unir una factura con un presupuesto existente.');
      else if (quote.clientId !== doc.clientId) error(`${path}.quoteId`, 'la factura y su presupuesto deben pertenecer al mismo cliente.');
      if (linkedQuotes.has(doc.quoteId)) error(`${path}.quoteId`, 'el presupuesto ya tiene una factura vinculada.');
      linkedQuotes.add(doc.quoteId);
    }
  });
  payments.forEach((payment, index) => {
    if (!isRecord(payment)) return;
    const path = `payments[${index}]`;
    requireString(payment.documentId, `${path}.documentId`, true);
    const doc = maps.documents.get(payment.documentId);
    if (!doc || doc.kind !== 'invoice' || doc.status === 'draft') error(`${path}.documentId`, 'el cobro debe pertenecer a una factura emitida.');
    requireNumber(payment.amount, `${path}.amount`, { minimum: 0.01, maximum: Number.MAX_SAFE_INTEGER / 100 });
    if (!validDate(payment.date)) error(`${path}.date`, 'la fecha de cobro no es válida.');
    else if (validDate(today) && payment.date > today) error(`${path}.date`, 'la fecha de cobro no puede estar en el futuro.');
    requireString(payment.reference, `${path}.reference`);
  });
  documents.forEach((doc, index) => {
    if (!isRecord(doc) || doc.kind !== 'invoice') return;
    const path = `documents[${index}]`, total = totalCents(doc).total, paid = paymentCents(doc, payments);
    if (paid > MAX_CENTS) error(path, 'la suma de cobros supera el límite permitido.');
    if (paid > total) error(path, 'los cobros superan el importe de la factura.');
    if (doc.status === 'paid' && paid !== total) error(`${path}.status`, 'el estado pagado exige cobros por el total de la factura.');
    if (doc.status === 'partial' && (paid <= 0n || paid >= total)) error(`${path}.status`, 'el estado parcial exige un cobro mayor que cero e inferior al total.');
    if (doc.status === 'overdue' && (paid >= total || !validDate(doc.dueDate) || !validDate(today) || doc.dueDate >= today)) error(`${path}.status`, 'el estado vencido exige saldo pendiente y un vencimiento pasado.');
  });
  // Old backups have no expenses collection. Its absence must not invalidate or replace them.
  if (workspace.expenses !== undefined && !Array.isArray(workspace.expenses)) error('expenses', 'debe ser una lista.');
  if (Array.isArray(workspace.expenses)) {
    if (workspace.expenses.length > 10000) error('expenses', 'la lista supera el límite de 10000 registros.');
    const expenseIds = new Set(), attachmentIds = new Set(), attachmentPaths = new Set(), movementIds = new Set();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const mimeByExtension = {
      pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
      rtf: 'application/rtf',
    };
    const expenseText = (value, path, maximum, required = false) => {
      requireString(value, path, required);
      if (typeof value === 'string' && value.length > maximum) error(path, `el texto supera ${maximum} caracteres.`);
    };
    workspace.expenses.forEach((expense, index) => {
      const path = `expenses[${index}]`;
      if (!isRecord(expense)) { error(path, 'el registro debe ser un objeto.'); return; }
      if (typeof expense.id !== 'string' || !uuid.test(expense.id)) error(`${path}.id`, 'indica un identificador UUID válido en minúsculas.');
      if (expenseIds.has(expense.id)) error(`${path}.id`, 'el identificador está duplicado.');
      expenseIds.add(expense.id);
      if (!validDate(expense.date) || (validDate(today) && expense.date > today)) error(`${path}.date`, 'indica la fecha real del gasto, sin fechas futuras.');
      if (expense.kind !== undefined && !['expense', 'credit'].includes(expense.kind)) error(`${path}.kind`, 'el registro debe ser un gasto o un abono.');
      const credit = expense.kind === 'credit';
      const moneyLimits = credit ? { minimum: -Number.MAX_SAFE_INTEGER / 100, maximum: 0 } : { maximum: Number.MAX_SAFE_INTEGER / 100 };
      expenseText(expense.supplier, `${path}.supplier`, 240);
      expenseText(expense.supplierTaxId, `${path}.supplierTaxId`, 80);
      expenseText(expense.description, `${path}.description`, 2000, true);
      for (const [key, maximum] of [['category', 100], ['reference', 240], ['notes', 10000]]) expenseText(expense[key], `${path}.${key}`, maximum);
      for (const key of ['base', 'vatAmount']) requireNumber(expense[key], `${path}.${key}`, moneyLimits);
      if (expense.additionalAmount !== undefined) requireNumber(expense.additionalAmount, `${path}.additionalAmount`, moneyLimits);
      if (expense.cashAmount !== undefined) requireNumber(expense.cashAmount, `${path}.cashAmount`, moneyLimits);
      requireNumber(expense.total, `${path}.total`, credit
        ? { minimum: -Number.MAX_SAFE_INTEGER / 100, maximum: -0.01 }
        : { minimum: 0.01, maximum: Number.MAX_SAFE_INTEGER / 100 });
      if (expense.vatRate !== undefined) requireNumber(expense.vatRate, `${path}.vatRate`, { maximum: 100 });
      if (expense.vatDeductibleAmount !== undefined) {
        requireNumber(expense.vatDeductibleAmount, `${path}.vatDeductibleAmount`, moneyLimits);
        if (typeof expense.vatDeductibleAmount === 'number' && (credit
          ? expense.vatDeductibleAmount < expense.vatAmount : expense.vatDeductibleAmount > expense.vatAmount)) {
          error(`${path}.vatDeductibleAmount`, 'el IVA confirmado no puede superar el IVA del documento.');
        }
      }
      const amounts = [expense.base, expense.vatAmount, expense.additionalAmount ?? 0, expense.total].map((amount) => fraction(amount));
      if (amounts.every(Boolean)) {
        const [base, vat, additional, total] = amounts;
        const denominator = base.denominator * vat.denominator * additional.denominator;
        const expectedNumerator = base.numerator * vat.denominator * additional.denominator
          + vat.numerator * base.denominator * additional.denominator + additional.numerator * base.denominator * vat.denominator;
        if (expectedNumerator * total.denominator !== total.numerator * denominator) error(`${path}.total`, 'no coincide con la base, el IVA y los otros importes registrados.');
      }
      if (!['paid', 'pending'].includes(expense.paymentStatus)) error(`${path}.paymentStatus`, 'el estado debe ser paid o pending.');
      if (expense.paymentStatus === 'paid') {
        if (!validDate(expense.paidDate) || (validDate(today) && expense.paidDate > today)) error(`${path}.paidDate`, 'un gasto pagado exige una fecha de pago válida, sin fechas futuras.');
      } else if (expense.paidDate !== undefined && expense.paidDate !== null && expense.paidDate !== '') error(`${path}.paidDate`, 'un gasto pendiente no debe tener fecha de pago.');
      if (expense.cashMovements !== undefined) {
        if (!Array.isArray(expense.cashMovements) || expense.cashMovements.length < 1 || expense.cashMovements.length > 100) {
          error(`${path}.cashMovements`, 'se admite una lista de 1 a 100 movimientos.');
        } else {
          if (expense.paymentStatus !== 'paid') error(`${path}.cashMovements`, 'los movimientos exigen un gasto pagado o un abono reembolsado.');
          let sum = 0n;
          expense.cashMovements.forEach((movement, movementIndex) => {
            const movementPath = `${path}.cashMovements[${movementIndex}]`;
            if (!isRecord(movement)) { error(movementPath, 'el movimiento debe ser un objeto.'); return; }
            if (typeof movement.id !== 'string' || !uuid.test(movement.id) || movementIds.has(movement.id)) error(`${movementPath}.id`, 'indica un UUID válido y único para este movimiento.');
            movementIds.add(movement.id);
            if (!validDate(movement.date) || (validDate(today) && movement.date > today)) error(`${movementPath}.date`, 'indica la fecha real del movimiento, sin fechas futuras.');
            requireNumber(movement.amount, `${movementPath}.amount`, { minimum: -Number.MAX_SAFE_INTEGER / 100, maximum: Number.MAX_SAFE_INTEGER / 100 });
            if (movement.amount === 0) error(`${movementPath}.amount`, 'el movimiento no puede ser cero.');
            expenseText(movement.reference, `${movementPath}.reference`, 240);
            sum += signedMoneyCents(movement.amount);
          });
          if (sum !== signedMoneyCents(expense.cashAmount ?? expense.total)) error(`${path}.cashMovements`, 'la suma de movimientos no coincide con el importe de caja del gasto.');
        }
      }
      if (expense.reviewNeeded !== undefined && typeof expense.reviewNeeded !== 'boolean') error(`${path}.reviewNeeded`, 'debe ser verdadero o falso.');
      if (expense.vatReviewNeeded !== undefined && typeof expense.vatReviewNeeded !== 'boolean') error(`${path}.vatReviewNeeded`, 'debe ser verdadero o falso.');
      if (expense.vatDocumentStatus !== undefined && (!['included-unitemized', 'not-stated'].includes(expense.vatDocumentStatus) || expense.vatReviewNeeded !== true)) {
        error(`${path}.vatDocumentStatus`, 'indica un estado documental válido y conserva el IVA sin confirmar.');
      }
      if (expense.vatReviewNeeded === true && (expense.vatAmount !== 0 || (expense.vatDeductibleAmount ?? 0) !== 0 || expense.vatRate !== undefined)) {
        error(`${path}.vatReviewNeeded`, 'un IVA por revisar no puede tener un IVA, porcentaje o deducibilidad confirmados.');
      }
      if (expense.attachments !== undefined && !Array.isArray(expense.attachments)) error(`${path}.attachments`, 'debe ser una lista.');
      if (!Array.isArray(expense.attachments)) return;
      if (expense.attachments.length > 10) error(`${path}.attachments`, 'se admiten como máximo 10 justificantes por gasto.');
      expense.attachments.forEach((attachment, attachmentIndex) => {
        const attachmentPath = `${path}.attachments[${attachmentIndex}]`;
        if (!isRecord(attachment)) { error(attachmentPath, 'el justificante debe ser un objeto.'); return; }
        if (typeof attachment.id !== 'string' || !uuid.test(attachment.id)) error(`${attachmentPath}.id`, 'indica un identificador UUID válido en minúsculas.');
        if (attachmentIds.has(attachment.id)) error(`${attachmentPath}.id`, 'el identificador del justificante está duplicado.');
        attachmentIds.add(attachment.id);
        expenseText(attachment.name, `${attachmentPath}.name`, 240, true);
        if (typeof attachment.name === 'string' && /[\/\\\u0000-\u001f\u007f]/u.test(attachment.name)) error(`${attachmentPath}.name`, 'el nombre contiene caracteres de control.');
        requireNumber(attachment.size, `${attachmentPath}.size`, { minimum: 1, maximum: 10 * 1024 * 1024, decimals: 0 });
        const parts = typeof attachment.path === 'string' ? attachment.path.split('/') : [];
        const filename = parts[2]?.split('.'), extension = filename?.[1];
        if (parts.length !== 3 || !uuid.test(parts[0]) || parts[1] !== expense.id
          || filename?.length !== 2 || filename[0] !== attachment.id || !Object.hasOwn(mimeByExtension, extension ?? '')) {
          error(`${attachmentPath}.path`, 'la ruta privada del justificante no es válida para este gasto.');
        }
        if (attachmentPaths.has(attachment.path)) error(`${attachmentPath}.path`, 'la ruta del justificante está duplicada.');
        attachmentPaths.add(attachment.path);
        if (attachment.mimeType !== mimeByExtension[extension]) error(`${attachmentPath}.mimeType`, 'el tipo de archivo no coincide con el justificante permitido.');
      });
    });
  }
  return errors;
}
