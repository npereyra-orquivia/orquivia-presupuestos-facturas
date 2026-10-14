import JSZip from 'jszip';
import { money, todayISO, validateWorkspace } from './domain.js';
import { reportCSV, periodReport } from './expenses.js';
import { createPDF } from './pdf.js';

const MAX_BUNDLE_BYTES = 300 * 1024 * 1024;
const MAX_LOGO_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIZE_ERROR = 'Los documentos de este período superan 300 MB. Selecciona un año o trimestre más pequeño.';

function basename(value, fallback) {
  let name = String(value ?? '').normalize('NFC').split(/[\\/]/).at(-1)
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, '_').trim()
    .replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!name) name = fallback;
  // Keep names portable when the ZIP is extracted on Windows, including multibyte names.
  let safe = '';
  for (const character of name) {
    if (encoder.encode(safe + character).byteLength > 140) break;
    safe += character;
  }
  return safe || fallback;
}

function receiptName(attachment) {
  const extension = attachment.path.split('.').at(-1);
  const original = basename(attachment.name, 'Justificante');
  const stem = original.replace(/\.[^.]*$/, '') || 'Justificante';
  // The real storage extension wins over a misleading display name. Original bytes are unchanged.
  return `${attachment.id}_${stem}.${extension}`;
}

async function loadSameOriginLogo(logoUrl) {
  if (!logoUrl) return undefined;
  const origin = globalThis.location?.origin;
  if (!origin || !globalThis.location?.href) throw new Error('El logotipo del archivo debe cargarse desde el portal.');
  const url = new URL(logoUrl, globalThis.location.href);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('El logotipo debe pertenecer al mismo portal.');
  }
  const response = await fetch(url.href, { credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error('No se pudo cargar el logotipo para las facturas.');
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_LOGO_BYTES) throw new Error('El logotipo supera el tamaño permitido.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_LOGO_BYTES || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
    throw new Error('No se pudo cargar un logotipo PNG válido.');
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return `data:image/png;base64,${btoa(binary)}`;
}

function summaryText(report, { demo, receiptCount }) {
  const s = report.summary;
  return [
    `ORQUÍVIA — ${report.label}`,
    report.from ? `Período seleccionado: ${report.from} a ${report.to}` : 'Período seleccionado: sin registros',
    `Preparado: ${todayISO()}`,
    ...(demo ? ['DATOS DE DEMOSTRACIÓN — ARCHIVO DE PRUEBA'] : []),
    '',
    `Facturas emitidas: ${s.invoiceCount}`,
    `Base de facturas emitidas: ${money(s.salesBase)}`,
    `IVA repercutido registrado: ${money(s.outputVAT)}`,
    `Retención en facturas emitidas: ${money(s.salesWithholding)}`,
    `Total de facturas emitidas: ${money(s.salesTotal)}`,
    '',
    `Gastos registrados: ${s.expenseCount}`,
    `Base de gastos con IVA revisado: ${money(s.expenseBase)}`,
    `IVA soportado registrado en justificantes: ${money(s.inputVATRecorded)}`,
    `IVA soportado confirmado por la usuaria para revisión del gestor: ${money(s.inputVATConfirmed)}`,
    `Total de gastos: ${money(s.expenseTotal)}`,
    `Abonos de proveedor incluidos: ${s.creditCount}`,
    `Suplidos y otros importes separados sin IVA: ${money(s.additionalTotal)}`,
    `Gastos con base e IVA pendientes de revisar: ${s.vatReviewCount} (${money(s.vatReviewTotal)})`,
    `Diferencia de actividad antes de retenciones: ${s.activityDifference === null ? 'Pendiente de revisar el IVA de los gastos' : money(s.activityDifference)}`,
    `Justificantes originales incluidos: ${receiptCount}`,
    '',
    `Cobros registrados con fecha dentro del período: ${money(s.cashReceived)}`,
    `Pagos de gastos registrados con fecha dentro del período: ${money(s.cashPaid)}`,
    `Registros señalados para revisar: ${s.reviewCount}`,
    '',
    'El registro de facturas y gastos usa la fecha de cada documento. Los cobros y pagos usan su propia fecha, aunque el documento pertenezca a otro trimestre.',
    'El IVA soportado registrado y el IVA confirmado se muestran por separado. Confirmar un importe en el portal no determina su deducibilidad; el gestor revisa los justificantes.',
    'Los gastos con IVA por revisar cuentan en el total y en caja, pero su base e IVA se dejan sin confirmar. La diferencia de actividad compara las bases registradas de ventas y gastos, antes de retenciones; no representa el beneficio fiscal ni el saldo bancario.',
    'Este paquete prepara información y documentos para el gestor. No presenta una declaración fiscal.',
    'Las facturas PDF se generan con los datos y las instantáneas guardadas de la empresa y del cliente. Los justificantes de gastos conservan sus bytes originales.',
    'El estado de pago de cada fila es el estado actual registrado en el portal. El paquete no confirma movimientos del banco.',
    '',
  ].join('\r\n');
}

/** All files are included or the export fails. Private receipts are downloaded only through the supplied adapter. */
export async function buildPeriodBundle(state, period, {
  backend, downloadLocalReceipt, logoUrl, demo = false, onProgress,
} = {}) {
  const errors = validateWorkspace(state, todayISO());
  if (errors.length) throw new Error(`No se puede preparar el informe: ${errors.slice(0, 3).join(' ')}`);
  const snapshot = typeof structuredClone === 'function' ? structuredClone(state) : JSON.parse(JSON.stringify(state));
  const selectedPeriod = { ...period };
  const report = periodReport(snapshot, selectedPeriod);
  const receipts = report.expenses.flatMap((expense) => (expense.attachments ?? []).map((attachment) => ({ expense, attachment })));
  const receiptCount = receipts.length, invoiceCount = report.invoices.length;
  const total = 2 + invoiceCount + receiptCount;
  let completed = 0, totalBytes = 0;
  const zip = new JSZip();
  const progress = async (label) => { if (onProgress) await onProgress({ completed, total, label }); };
  const add = async (path, value) => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    if (!(bytes instanceof Uint8Array)) throw new Error('No se pudo preparar uno de los documentos del período.');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BUNDLE_BYTES) throw new Error(SIZE_ERROR);
    zip.file(path, bytes, { binary: true, compression: 'STORE' });
    completed++;
    await progress(path);
  };

  if (receipts.reduce((sum, entry) => sum + entry.attachment.size, 0) > MAX_BUNDLE_BYTES) throw new Error(SIZE_ERROR);
  const downloadReceipt = backend?.downloadReceipt
    ? (attachment) => backend.downloadReceipt(attachment)
    : downloadLocalReceipt;
  if (receiptCount && typeof downloadReceipt !== 'function') throw new Error('Falta la conexión para descargar los justificantes del período.');
  await progress('Preparando el registro del período');
  const registerName = ({ quarter: 'registro-trimestre.csv', year: 'registro-anual.csv', all: 'registro-historico.csv' })[report.type];
  await add(registerName, reportCSV(snapshot, selectedPeriod));
  await add('resumen.txt', summaryText(report, { demo, receiptCount }));

  const logoData = invoiceCount ? await loadSameOriginLogo(logoUrl) : undefined;
  for (const [index, invoice] of report.invoices.entries()) {
    await progress(`Generando factura ${invoice.number}`);
    const client = invoice.clientSnapshot ?? snapshot.clients.find((entry) => entry.id === invoice.clientId);
    const pdf = createPDF(invoice, snapshot.company, client, { logoData, demo });
    const id = UUID.test(invoice.id) ? invoice.id : `documento-${String(index + 1).padStart(4, '0')}`;
    await add(`facturas/${id}_${basename(invoice.number, 'Factura')}.pdf`, new Uint8Array(pdf.output('arraybuffer')));
  }
  for (const { expense, attachment } of receipts) {
    await progress(`Descargando ${attachment.name}`);
    let file;
    try { file = await downloadReceipt(attachment, expense); }
    catch (error) { throw new Error(`No se pudo incluir el justificante «${attachment.name}». Vuelve a intentar la exportación. ${error?.message ?? ''}`.trim()); }
    if (!file || typeof file.arrayBuffer !== 'function' || file.size !== attachment.size) {
      throw new Error(`El justificante «${attachment.name}» no está disponible completo. No se ha creado un archivo parcial.`);
    }
    if (totalBytes + file.size > MAX_BUNDLE_BYTES) throw new Error(SIZE_ERROR);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== attachment.size) throw new Error(`El justificante «${attachment.name}» tiene un tamaño distinto del registrado.`);
    await add(`justificantes/${expense.id}/${receiptName(attachment)}`, bytes);
  }
  await progress('Creando archivo ZIP');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true });
  if (blob.size > MAX_BUNDLE_BYTES) throw new Error(SIZE_ERROR);
  const periodName = report.type === 'all' ? 'Historico_completo' : report.type === 'year' ? `${report.year}_Anual` : `${report.year}_T${report.quarter}`;
  return { blob, name: `Orquivia_${periodName}${demo ? '_PRUEBA' : ''}.zip`, invoiceCount, receiptCount };
}

export function buildQuarterBundle(state, year, quarter, options) {
  return buildPeriodBundle(state, { type: 'quarter', year, quarter }, options);
}
