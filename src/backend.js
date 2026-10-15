import { createClient } from '@supabase/supabase-js';
import { createPersonalBackend } from './personal-backend.js';
import { createDocumentMailBackend } from './document-mail-backend.js';
import { validateWorkspace } from './domain.js';

const MAX_STATE_BYTES = 5_000_000;
export const RECEIPT_BUCKET = 'orquivia-receipts';
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const RECEIPT_FILE_TYPES = Object.freeze({
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HISTORY_ENTITY_TYPES = new Set(['document', 'expense', 'tax', 'client', 'payment', 'company']);

/** Files are private originals; active web formats and extension disguises are rejected. */
export async function validateReceiptFile(file) {
  const name = String(file?.name || '').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const extension = name.split('.').at(-1)?.toLowerCase();
  const mimeType = RECEIPT_FILE_TYPES[extension];
  if (!name || name.length > 240 || !mimeType || typeof file?.slice !== 'function') {
    throw backendError('Admite PDF, imágenes y documentos de Office. No se permiten archivos ejecutables ni páginas web.', 'INVALID_RECEIPT');
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_RECEIPT_BYTES) {
    throw backendError('Cada justificante debe ocupar entre 1 byte y 10 MB.', 'INVALID_RECEIPT');
  }
  const declared = String(file.type || '').toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== mimeType && !(extension === 'rtf' && declared === 'text/rtf')) {
    throw backendError('El tipo del archivo no coincide con su extensión.', 'INVALID_RECEIPT');
  }
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const ascii = new TextDecoder('latin1').decode(bytes);
  const prefix = (...values) => values.every((value, index) => bytes[index] === value);
  const signatureValid = extension === 'pdf' ? ascii.startsWith('%PDF-')
    : ['jpg', 'jpeg'].includes(extension) ? prefix(0xff, 0xd8, 0xff)
      : extension === 'png' ? prefix(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        : extension === 'webp' ? ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
          : extension === 'gif' ? /^GIF8[79]a/.test(ascii)
            : ['heic', 'heif'].includes(extension) ? ascii.slice(4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(ascii.slice(8, 40))
              : ['doc', 'xls'].includes(extension) ? prefix(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)
                : extension === 'rtf' ? ascii.startsWith('{\\rtf')
                  : prefix(0x50, 0x4b, 0x03, 0x04);
  if (!signatureValid) throw backendError('El contenido del archivo no coincide con el formato indicado.', 'INVALID_RECEIPT');
  return { name, mimeType, size: file.size, extension };
}

function receiptPath(attachment, organizationId) {
  if (!attachment || !UUID_PATTERN.test(attachment.id) || typeof attachment.path !== 'string') {
    throw backendError('El justificante no tiene un identificador válido.', 'INVALID_RECEIPT');
  }
  const parts = attachment.path.split('/');
  const [org, expenseId, filename] = parts;
  const extension = filename?.split('.').at(-1);
  if (parts.length !== 3 || org !== organizationId || !UUID_PATTERN.test(expenseId)
    || filename !== `${attachment.id}.${extension}` || !Object.hasOwn(RECEIPT_FILE_TYPES, extension)
    || attachment.mimeType !== RECEIPT_FILE_TYPES[extension]) {
    throw backendError('Este justificante no pertenece a la empresa activa.', 'INVALID_RECEIPT');
  }
  return attachment.path;
}

function backendError(message, code, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate before transport as well as on the database boundary. */
export function validateCloudState(state) {
  const domainErrors = validateWorkspace(state);
  if (domainErrors.length) throw backendError(domainErrors.join(' '), 'INVALID_STATE');
  if (!isObject(state) || !isObject(state.company)) {
    throw backendError('El archivo debe incluir los datos de empresa.', 'INVALID_STATE');
  }
  if ((state.company.emailNotifications !== undefined && typeof state.company.emailNotifications !== 'boolean')
    || (state.company.notificationEmail !== undefined && typeof state.company.notificationEmail !== 'string')) {
    throw backendError('La configuración de avisos de empresa no es válida.', 'INVALID_STATE');
  }
  for (const field of ['clients', 'documents', 'payments']) {
    if (!Array.isArray(state[field])) {
      throw backendError(`Falta la lista ${field}.`, 'INVALID_STATE');
    }
    const ids = new Set();
    for (const row of state[field]) {
      if (!isObject(row) || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) {
        throw backendError(`Hay un registro sin identificador o duplicado en ${field}.`, 'INVALID_STATE');
      }
      ids.add(row.id);
    }
  }
  for (const document of state.documents) {
    if (!['invoice', 'quote'].includes(document.kind) || !Array.isArray(document.items)) {
      throw backendError('Hay un documento con tipo o conceptos incorrectos.', 'INVALID_STATE');
    }
    if (document.total !== undefined && (!Number.isFinite(document.total) || document.total < 0)) {
      throw backendError('El total de un documento no es válido.', 'INVALID_STATE');
    }
    if (document.contractReceived !== undefined && typeof document.contractReceived !== 'boolean') {
      throw backendError('El campo de recepción del contrato no es válido.', 'INVALID_STATE');
    }
    for (const item of document.items) {
      if (!isObject(item) || !Number.isFinite(item.quantity) || item.quantity <= 0
        || !Number.isFinite(item.price) || item.price < 0) {
        throw backendError('Las cantidades y precios de un documento no son válidos.', 'INVALID_STATE');
      }
    }
  }
  const documentIds = new Set(state.documents.map((document) => document.id));
  for (const payment of state.payments) {
    if (!documentIds.has(payment.documentId) || !Number.isFinite(payment.amount) || payment.amount <= 0) {
      throw backendError('Hay un cobro con importe o documento incorrecto.', 'INVALID_STATE');
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(state, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Número no finito');
      if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
        throw new Error('Valor no serializable');
      }
      return value;
    });
  } catch (cause) {
    throw backendError('Los datos no se pueden guardar como JSON.', 'INVALID_STATE', cause);
  }
  if (new TextEncoder().encode(serialized).length > MAX_STATE_BYTES) {
    throw backendError('Los datos superan el límite de 5 MB. Exporta una copia y archiva documentos.', 'STATE_TOO_LARGE');
  }
  return JSON.parse(serialized);
}

function validatePublicConfig(url, key) {
  let parsed;
  try { parsed = new URL(url); } catch {
    throw backendError('La URL de Supabase no es válida.', 'INVALID_CONFIG');
  }
  if (parsed.protocol !== 'https:' && !(['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.protocol === 'http:')) {
    throw backendError('Supabase debe usar una URL HTTPS.', 'INVALID_CONFIG');
  }
  if (!key || key.startsWith('sb_secret_')) {
    throw backendError('Utiliza únicamente la clave pública publishable o anon de Supabase.', 'INVALID_CONFIG');
  }
  // Legacy Supabase keys are JWTs. Privileged keys must never enter the browser client.
  if (key.split('.').length === 3) {
    try {
      const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role !== 'anon') throw new Error('privileged');
    } catch {
      throw backendError('Esta clave no es una clave anon pública válida.', 'INVALID_CONFIG');
    }
  } else if (!key.startsWith('sb_publishable_')) {
    throw backendError('Utiliza una clave publishable o anon de Supabase.', 'INVALID_CONFIG');
  }
}

/**
 * A shared company workspace granted by explicit organization membership. The database compares
 * versions; a second browser cannot silently overwrite a newer workspace.
 * loadState must run once after sign-in before the first saveState.
 */
export function createBackend({ url, anonKey }) {
  url = String(url || '').trim().replace(/\/$/, '');
  anonKey = String(anonKey || '').trim();
  validatePublicConfig(url, anonKey);
  const client = createClient(url, anonKey, {
    auth: { persistSession: true, storage: typeof sessionStorage === 'undefined' ? undefined : sessionStorage, autoRefreshToken: true, detectSessionInUrl: false },
  });
  let ownerId = null;
  let workspace = null;
  let version = null;
  let queue = Promise.resolve();
  let disposed = false;
  let authGeneration = 0;
  const listeners = new Set();

  function resetForUser(user) {
    if (ownerId !== (user?.id || null)) {
      // The first restored owner establishes the initial context. Every later
      // identity change (and explicit login/logout) invalidates earlier work.
      if (ownerId !== null || authGeneration !== 0) ++authGeneration;
      ownerId = user?.id || null;
      version = null;
      workspace = null;
    }
  }

  const { data: authEvents } = client.auth.onAuthStateChange((event, session) => {
    resetForUser(session?.user);
    // Defer callbacks to avoid making another Supabase call inside its auth lock.
    setTimeout(() => {
      if (!disposed) for (const listener of listeners) listener(event, session?.user || null);
    }, 0);
  });

  async function currentUser() {
    const generation = authGeneration;
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (authGeneration !== generation) throw backendError('La sesión cambió durante la comprobación de la cuenta.', 'AUTH_CHANGED');
    if (sessionError) throw backendError('No se pudo recuperar la sesión.', 'AUTH_ERROR', sessionError);
    if (!sessionData.session) { resetForUser(null); return null; }
    if (ownerId === null) {
      resetForUser(sessionData.session.user);
    }
    const { data, error } = await client.auth.getUser();
    if (authGeneration !== generation || ownerId !== sessionData.session.user?.id) {
      throw backendError('La sesión cambió durante la comprobación de la cuenta.', 'AUTH_CHANGED');
    }
    if (error) throw backendError('No se pudo verificar la sesión. Vuelve a iniciar sesión.', 'AUTH_ERROR', error);
    if (data.user?.id !== sessionData.session.user?.id) throw backendError('La identidad de la sesión cambió.', 'AUTH_CHANGED');
    resetForUser(data.user);
    return data.user;
  }

  function denyWorkspaceAccess(code) {
    workspace = null;
    version = null;
    const event = code === 'MFA_REQUIRED' ? code : 'ACCESS_REVOKED';
    setTimeout(() => {
      if (!disposed) for (const listener of listeners) listener(event, null);
    }, 0);
  }

  function assertSession(user, generation, organizationId) {
    if (disposed || authGeneration !== generation || ownerId !== user.id
      || (organizationId !== undefined && workspace?.organizationId !== organizationId)) {
      throw backendError('La sesión cambió durante la operación. Vuelve a abrir la empresa.', 'AUTH_CHANGED');
    }
  }

  async function checkWorkspaceAccess(user, generation = authGeneration) {
    const { data, error } = await client.rpc('refresh_orquivia_access', {});
    assertSession(user, generation);
    if (error) {
      const failure = rpcError(error, 'No se pudo comprobar el acceso de tu cuenta.');
      if (failure.code === 'MEMBERSHIP_REQUIRED') {
        throw backendError('Tu cuenta ya no tiene acceso a esta empresa.', 'ACCESS_REVOKED', error);
      }
      throw failure;
    }
    if (!data?.organization_id || (workspace && data.organization_id !== workspace.organizationId)) {
      denyWorkspaceAccess('ACCESS_REVOKED');
      throw backendError('Tu cuenta ya no tiene acceso a esta empresa.', 'ACCESS_REVOKED');
    }
    if (workspace) Object.assign(workspace, { name: data.organization_name, role: data.role, requireMfa: data.require_mfa });
    return { organizationId: data.organization_id, name: data.organization_name, role: data.role, requireMfa: data.require_mfa };
  }

  async function requireUser(generation = authGeneration) {
    const user = await currentUser();
    if (authGeneration !== generation) throw backendError('La sesión cambió durante la operación.', 'AUTH_CHANGED');
    if (!user) throw backendError('Inicia sesión para guardar los datos en Supabase.', 'AUTH_REQUIRED');
    if (workspace) await checkWorkspaceAccess(user, generation);
    assertSession(user, generation);
    return user;
  }

  function rpcError(error, fallback) {
    if (error?.code === '40001' || /VERSION_CONFLICT/.test(error?.message || '')) {
      version = null;
      return backendError('Otra sesión ha actualizado los datos. Exporta tus cambios y recarga antes de continuar.', 'VERSION_CONFLICT', error);
    }
    const known = ['MEMBERSHIP_REQUIRED', 'MFA_REQUIRED', 'AUTH_CHANGED', 'ADMIN_REQUIRED', 'ISSUE_REQUIRED', 'ISSUED_DOCUMENT_IMMUTABLE', 'ISSUED_DOCUMENT_DELETE_DENIED', 'INVALID_RECEIPT_REFERENCE', 'INVALID_HISTORY_RECORD', 'INVALID_STATE'];
    const code = known.find((name) => error?.message?.includes(name));
    if (code === 'MFA_REQUIRED' || code === 'MEMBERSHIP_REQUIRED') denyWorkspaceAccess(code);
    const messages = {
      MEMBERSHIP_REQUIRED: 'Esta cuenta no está autorizada en la empresa.', MFA_REQUIRED: 'Completa la verificación en dos pasos.',
      AUTH_CHANGED: 'La sesión cambió. Vuelve a abrir la empresa antes de continuar.',
      ADMIN_REQUIRED: 'Solo la administradora puede modificar los datos de empresa.',
      ISSUE_REQUIRED: 'Emite el borrador para que el servidor asigne su número.',
      ISSUED_DOCUMENT_IMMUTABLE: 'Los datos fiscales de un documento emitido no se pueden modificar.',
      ISSUED_DOCUMENT_DELETE_DENIED: 'Conserva el documento emitido para mantener su historial.',
      INVALID_RECEIPT_REFERENCE: 'Un justificante no está guardado en la empresa o no coincide con el archivo subido.',
      INVALID_HISTORY_RECORD: 'El registro del historial no es válido.',
      INVALID_STATE: 'Los datos no superan la validación de la base de datos.',
    };
    return backendError(messages[code] || fallback, code || 'SAVE_ERROR', error);
  }

  // One queue also orders loads with pending saves. Each save takes its own snapshot.
  function enqueue(operation) {
    const job = queue.then(operation);
    queue = job.catch(() => undefined);
    return job;
  }

  return {
    mail: createDocumentMailBackend({ client, requireUser, getWorkspace: () => workspace, getVersion: () => version, enqueue,
      adoptWorkspace(result) {
        validateCloudState(result.state);
        if (!Number.isSafeInteger(Number(result.version)) || Number(result.version) < version) throw backendError('Recarga los datos después del envío.', 'VERSION_CONFLICT');
        version = Number(result.version);
      },
    }),
    personal: createPersonalBackend({ client, requireUser, getWorkspace: () => workspace, url }),
    async signIn(email, password) {
      ++authGeneration;
      version = null;
      workspace = null;
      const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw backendError('No se pudo iniciar sesión. Revisa el correo y la contraseña.', 'AUTH_ERROR', error);
      resetForUser(data.user);
      return data.user;
    },
    async signOut() {
      ++authGeneration;
      await queue;
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw backendError('No se pudo cerrar la sesión.', 'AUTH_ERROR', error);
      resetForUser(null);
    },
    async changePassword(currentPassword, newPassword) {
      const user = await currentUser();
      if (!user?.email) throw backendError('Inicia sesión para cambiar tu contraseña.', 'AUTH_REQUIRED');
      if (typeof newPassword !== 'string' || newPassword.length < 12) throw backendError('Utiliza una contraseña de al menos 12 caracteres.', 'INVALID_PASSWORD');
      // A password sign-in issues an AAL1 session. Use an isolated, memory-only
      // client so checking the current password cannot downgrade the active AAL2
      // session that authorizes this sensitive account update.
      const verifier = createClient(url, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      try {
        const { data, error: verifyError } = await verifier.auth.signInWithPassword({ email: user.email, password: currentPassword });
        if (verifyError) throw backendError('La contraseña actual no es correcta.', 'AUTH_ERROR', verifyError);
        if (data.user?.id !== user.id || (await currentUser())?.id !== user.id) {
          throw backendError('La sesión cambió. Inicia sesión antes de cambiar la contraseña.', 'AUTH_CHANGED');
        }
        const { error } = await client.auth.updateUser({ password: newPassword, current_password: currentPassword });
        if (error) throw backendError('No se pudo cambiar la contraseña.', 'AUTH_ERROR', error);
        const { error: logoutError } = await client.auth.signOut({ scope: 'others' });
        if (logoutError) throw backendError('La contraseña cambió, pero no se pudieron cerrar las otras sesiones.', 'OTHER_SESSIONS_ERROR', logoutError);
      } finally {
        // Revoke the temporary password-check session; it never enters storage
        // or the portal's auth event stream.
        try { await verifier.auth.signOut({ scope: 'local' }); } catch {}
        verifier.auth.stopAutoRefresh();
      }
    },
    currentUser,
    async refreshAccess() {
      const generation = authGeneration;
      const user = await currentUser();
      if (authGeneration !== generation) throw backendError('La sesión cambió durante la operación.', 'AUTH_CHANGED');
      if (!user) throw backendError('Inicia sesión para comprobar el acceso.', 'AUTH_REQUIRED');
      return checkWorkspaceAccess(user, generation);
    },
    workspaceInfo() { return workspace ? { ...workspace } : null; },
    mfa: {
      async assuranceLevel() { const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel(); if (error) throw error; return data; },
      async factors() { const { data, error } = await client.auth.mfa.listFactors(); if (error) throw error; return data; },
      async enroll() {
        const { data: factors, error: listError } = await client.auth.mfa.listFactors();
        if (listError) throw listError;
        // A closed or reloaded setup screen can leave this unverified factor
        // behind. Remove only our unfinished TOTP setup before retrying its name.
        // Existing verified authenticators and factors belonging to other setups
        // must remain intact.
        for (const factor of factors.all || []) {
          if (factor.factor_type !== 'totp' || factor.status !== 'unverified' || factor.friendly_name !== 'Orquívia') continue;
          const { error } = await client.auth.mfa.unenroll({ factorId: factor.id });
          if (error) throw error;
        }
        const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Orquívia' });
        if (error) throw error;
        return data;
      },
      async challenge(factorId) { const { data, error } = await client.auth.mfa.challenge({ factorId }); if (error) throw error; return data; },
      async verify(factorId, challengeId, code) { const { data, error } = await client.auth.mfa.verify({ factorId, challengeId, code }); if (error) throw error; return data; },
    },
    onAuthStateChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    loadState() {
      const generation = authGeneration;
      return enqueue(async () => {
        const user = await requireUser(generation);
        const { data, error } = await client.rpc('load_orquivia_workspace', {});
        assertSession(user, generation);
        if (error) throw rpcError(error, 'No se pudieron cargar los datos de la empresa.');
        if (!data?.organization_id) throw backendError('Esta cuenta no tiene una empresa asignada.', 'MEMBERSHIP_REQUIRED');
        const loaded = validateCloudState(data.state);
        version = Number(data.version);
        workspace = { organizationId: data.organization_id, name: data.organization_name, role: data.role, requireMfa: data.require_mfa };
        return loaded;
      });
    },
    peekState() {
      const generation = authGeneration;
      // Conflict comparison must not advance the CAS version or enable saving
      // the stale workspace again. Only an explicit loadState resets that gate.
      return enqueue(async () => {
        const user = await requireUser(generation);
        if (!workspace) throw backendError('Carga primero la empresa.', 'STATE_NOT_LOADED');
        const organizationId = workspace.organizationId;
        const { data, error } = await client.rpc('load_orquivia_workspace', {});
        assertSession(user, generation, organizationId);
        if (error) throw rpcError(error, 'No se pudieron consultar los datos actuales de la empresa.');
        if (data?.organization_id !== organizationId) {
          throw backendError('La sesión cambió durante la consulta.', 'AUTH_CHANGED');
        }
        return { state: validateCloudState(data.state), version: Number(data.version), updatedAt: data.updated_at };
      });
    },
    saveState(state) {
      const snapshot = validateCloudState(state);
      const requestedOwner = ownerId;
      const generation = authGeneration;
      return enqueue(async () => {
        const user = await requireUser(generation);
        if (requestedOwner && requestedOwner !== user.id) throw backendError('La sesión cambió. Recarga los datos antes de guardar.', 'AUTH_CHANGED');
        if (version === null) throw backendError('Carga primero los datos de la cuenta para evitar sobrescribirlos.', 'STATE_NOT_LOADED');
        const organizationId = workspace.organizationId;
        const { data, error } = await client.rpc('save_orquivia_team_state', {
          p_organization_id: organizationId, p_state: snapshot, p_expected_version: version,
        });
        assertSession(user, generation, organizationId);
        if (error) {
          throw rpcError(error, 'No se pudo guardar en Supabase. Tus cambios siguen en esta sesión.');
        }
        version = Number(data.version);
        return { version, updatedAt: data.updated_at };
      });
    },
    issueDocument(documentId) {
      const requestedOwner = ownerId;
      const generation = authGeneration;
      return enqueue(async () => {
        const user = await requireUser(generation);
        if (requestedOwner !== user.id) throw backendError('La sesión cambió.', 'AUTH_CHANGED');
        if (version === null || !workspace) throw backendError('Carga primero los datos de la empresa.', 'STATE_NOT_LOADED');
        const organizationId = workspace.organizationId;
        const { data, error } = await client.rpc('issue_orquivia_document', {
          p_organization_id: organizationId, p_document_id: documentId, p_expected_version: version,
        });
        assertSession(user, generation, organizationId);
        if (error) throw rpcError(error, 'No se pudo emitir el documento.');
        const state = validateCloudState(data.state);
        version = Number(data.version);
        return { state, version, updatedAt: data.updated_at, documentNumber: data.document_number };
      });
    },
    async auditLog(limit = 100) {
      const generation = authGeneration;
      const user = await requireUser(generation);
      if (!workspace) throw backendError('Carga primero la empresa.', 'STATE_NOT_LOADED');
      const organizationId = workspace.organizationId;
      const { data, error } = await client.from('orquivia_audit_log').select('id,actor_email,event,workspace_version,changes,created_at')
        .eq('organization_id', organizationId).order('id', { ascending: false }).limit(Math.max(1, Math.min(500, limit)));
      assertSession(user, generation, organizationId);
      if (error) throw backendError('No se pudo cargar el historial.', 'LOAD_ERROR', error);
      return data;
    },
    async recordHistory(entityType, entityId, limit = 50) {
      const generation = authGeneration;
      if (!HISTORY_ENTITY_TYPES.has(entityType) || typeof entityId !== 'string'
        || !entityId.trim() || entityId.length > 160 || /[\u0000-\u001f\u007f]/.test(entityId)
        || (entityType === 'company' && entityId !== 'company')) {
        throw backendError('El registro del historial no es válido.', 'INVALID_HISTORY_RECORD');
      }
      const user = await requireUser(generation);
      if (!workspace) throw backendError('Carga primero la empresa.', 'STATE_NOT_LOADED');
      const organizationId = workspace.organizationId;
      const pageSize = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 50;
      const { data, error } = await client.rpc('load_orquivia_record_history', {
        p_organization_id: organizationId, p_entity_type: entityType, p_entity_id: entityId,
        p_limit: pageSize, p_expected_user_id: user.id,
      });
      assertSession(user, generation, organizationId);
      if (error) throw rpcError(error, 'No se pudo cargar el historial de este registro.');
      if (!Array.isArray(data)) throw backendError('El historial recibido no es válido.', 'LOAD_ERROR');
      return data;
    },
    async uploadReceipt(expenseId, file) {
      const metadata = await validateReceiptFile(file);
      const user = await requireUser();
      if (!workspace || version === null) throw backendError('Carga primero la empresa.', 'STATE_NOT_LOADED');
      if (!UUID_PATTERN.test(expenseId)) throw backendError('El gasto no tiene un identificador válido.', 'INVALID_RECEIPT');
      const organizationId = workspace.organizationId;
      const id = crypto.randomUUID();
      const path = `${organizationId}/${expenseId}/${id}.${metadata.extension}`;
      // Browsers sometimes leave HEIC/Office MIME empty. Give the multipart file
      // the verified canonical type so bucket validation sees the correct MIME.
      const body = file.slice(0, file.size, metadata.mimeType);
      const { error } = await client.storage.from(RECEIPT_BUCKET).upload(path, body, {
        contentType: metadata.mimeType, cacheControl: '0', upsert: false,
      });
      if (error) throw backendError('No se pudo guardar el justificante privado.', 'RECEIPT_UPLOAD_ERROR', error);
      if (ownerId !== user.id || workspace?.organizationId !== organizationId) {
        throw backendError('La sesión cambió durante la subida. Recarga la empresa.', 'AUTH_CHANGED');
      }
      return { id, name: metadata.name, path, mimeType: metadata.mimeType, size: metadata.size };
    },
    async receiptUrl(attachment, { download = false } = {}) {
      const user = await requireUser();
      if (!workspace) throw backendError('Carga primero la empresa.', 'STATE_NOT_LOADED');
      const organizationId = workspace.organizationId;
      const path = receiptPath(attachment, organizationId);
      const { data, error } = await client.storage.from(RECEIPT_BUCKET).createSignedUrl(path, 60, {
        download: download ? attachment.name : false,
      });
      if (error || !data?.signedUrl) throw backendError('No se pudo abrir el justificante privado.', 'RECEIPT_READ_ERROR', error);
      if (ownerId !== user.id || workspace?.organizationId !== organizationId) throw backendError('La sesión cambió durante la lectura.', 'AUTH_CHANGED');
      const parsed = new URL(data.signedUrl);
      if (parsed.origin !== new URL(url).origin || !parsed.pathname.startsWith('/storage/v1/object/sign/')) {
        throw backendError('La dirección del justificante no es válida.', 'RECEIPT_READ_ERROR');
      }
      return data.signedUrl;
    },
    async downloadReceipt(attachment) {
      const user = await requireUser();
      if (!workspace) throw backendError('Carga primero la empresa.', 'STATE_NOT_LOADED');
      const organizationId = workspace.organizationId;
      const path = receiptPath(attachment, organizationId);
      const { data, error } = await client.storage.from(RECEIPT_BUCKET).download(path, {}, { cache: 'no-store' });
      if (error || !data) throw backendError('No se pudo descargar el justificante privado.', 'RECEIPT_READ_ERROR', error);
      if (ownerId !== user.id || workspace?.organizationId !== organizationId) throw backendError('La sesión cambió durante la descarga.', 'AUTH_CHANGED');
      return data;
    },
    async deleteReceipt(attachment) {
      // Remove the metadata with saveState first. The database denies deletion
      // while any expense or tax declaration still references this path.
      await requireUser();
      if (!workspace) throw backendError('Carga primero la empresa.', 'STATE_NOT_LOADED');
      const path = receiptPath(attachment, workspace.organizationId);
      const { data, error } = await client.storage.from(RECEIPT_BUCKET).remove([path]);
      if (error) throw backendError('No se pudo eliminar el justificante. Comprueba que el gasto ya está guardado sin él.', 'RECEIPT_DELETE_ERROR', error);
      if (!data?.some((object) => object.name === path)) {
        throw backendError('El justificante sigue vinculado a un gasto o ya no existe.', 'RECEIPT_DELETE_ERROR');
      }
    },
    dispose() {
      disposed = true;
      listeners.clear();
      authEvents.subscription.unsubscribe();
      client.auth.stopAutoRefresh();
    },
  };
}
