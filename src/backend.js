import { createClient } from '@supabase/supabase-js';
import { validateWorkspace } from './domain.js';

const MAX_STATE_BYTES = 5_000_000;

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
  const listeners = new Set();

  function resetForUser(user) {
    if (ownerId !== (user?.id || null)) {
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
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw backendError('No se pudo recuperar la sesión.', 'AUTH_ERROR', sessionError);
    if (!sessionData.session) { resetForUser(null); return null; }
    const { data, error } = await client.auth.getUser();
    if (error) throw backendError('No se pudo verificar la sesión. Vuelve a iniciar sesión.', 'AUTH_ERROR', error);
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

  async function checkWorkspaceAccess(user) {
    const { data, error } = await client.rpc('refresh_orquivia_access', {});
    if (error) {
      const failure = rpcError(error, 'No se pudo comprobar el acceso de tu cuenta.');
      if (failure.code === 'MEMBERSHIP_REQUIRED') {
        throw backendError('Tu cuenta ya no tiene acceso a esta empresa.', 'ACCESS_REVOKED', error);
      }
      throw failure;
    }
    if (ownerId !== user.id) throw backendError('La sesión cambió durante la comprobación de acceso.', 'AUTH_CHANGED');
    if (!data?.organization_id || (workspace && data.organization_id !== workspace.organizationId)) {
      denyWorkspaceAccess('ACCESS_REVOKED');
      throw backendError('Tu cuenta ya no tiene acceso a esta empresa.', 'ACCESS_REVOKED');
    }
    if (workspace) Object.assign(workspace, { name: data.organization_name, role: data.role, requireMfa: data.require_mfa });
    return { organizationId: data.organization_id, name: data.organization_name, role: data.role, requireMfa: data.require_mfa };
  }

  async function requireUser() {
    const user = await currentUser();
    if (!user) throw backendError('Inicia sesión para guardar los datos en Supabase.', 'AUTH_REQUIRED');
    if (workspace) await checkWorkspaceAccess(user);
    return user;
  }

  function rpcError(error, fallback) {
    if (error?.code === '40001' || /VERSION_CONFLICT/.test(error?.message || '')) {
      version = null;
      return backendError('Otra sesión ha actualizado los datos. Exporta tus cambios y recarga antes de continuar.', 'VERSION_CONFLICT', error);
    }
    const known = ['MEMBERSHIP_REQUIRED', 'MFA_REQUIRED', 'ADMIN_REQUIRED', 'ISSUE_REQUIRED', 'ISSUED_DOCUMENT_IMMUTABLE', 'ISSUED_DOCUMENT_DELETE_DENIED', 'INVALID_STATE'];
    const code = known.find((name) => error?.message?.includes(name));
    if (code === 'MFA_REQUIRED' || code === 'MEMBERSHIP_REQUIRED') denyWorkspaceAccess(code);
    const messages = {
      MEMBERSHIP_REQUIRED: 'Esta cuenta no está autorizada en la empresa.', MFA_REQUIRED: 'Completa la verificación en dos pasos.',
      ADMIN_REQUIRED: 'Solo la administradora puede modificar los datos de empresa.',
      ISSUE_REQUIRED: 'Emite el borrador para que el servidor asigne su número.',
      ISSUED_DOCUMENT_IMMUTABLE: 'Los datos fiscales de un documento emitido no se pueden modificar.',
      ISSUED_DOCUMENT_DELETE_DENIED: 'Conserva el documento emitido para mantener su historial.',
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
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw backendError('No se pudo iniciar sesión. Revisa el correo y la contraseña.', 'AUTH_ERROR', error);
      resetForUser(data.user);
      return data.user;
    },
    async signOut() {
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
      const user = await currentUser();
      if (!user) throw backendError('Inicia sesión para comprobar el acceso.', 'AUTH_REQUIRED');
      return checkWorkspaceAccess(user);
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
      return enqueue(async () => {
        const user = await requireUser();
        const { data, error } = await client.rpc('load_orquivia_workspace', {});
        if (error) throw rpcError(error, 'No se pudieron cargar los datos de la empresa.');
        if (ownerId !== user.id) throw backendError('La sesión cambió durante la carga.', 'AUTH_CHANGED');
        if (!data?.organization_id) throw backendError('Esta cuenta no tiene una empresa asignada.', 'MEMBERSHIP_REQUIRED');
        const loaded = validateCloudState(data.state);
        version = Number(data.version);
        workspace = { organizationId: data.organization_id, name: data.organization_name, role: data.role, requireMfa: data.require_mfa };
        return loaded;
      });
    },
    saveState(state) {
      const snapshot = validateCloudState(state);
      const requestedOwner = ownerId;
      return enqueue(async () => {
        const user = await requireUser();
        if (requestedOwner && requestedOwner !== user.id) throw backendError('La sesión cambió. Recarga los datos antes de guardar.', 'AUTH_CHANGED');
        if (version === null) throw backendError('Carga primero los datos de la cuenta para evitar sobrescribirlos.', 'STATE_NOT_LOADED');
        const { data, error } = await client.rpc('save_orquivia_team_state', {
          p_organization_id: workspace.organizationId, p_state: snapshot, p_expected_version: version,
        });
        if (error) {
          throw rpcError(error, 'No se pudo guardar en Supabase. Tus cambios siguen en esta sesión.');
        }
        if (ownerId !== user.id) throw backendError('La sesión cambió durante el guardado.', 'AUTH_CHANGED');
        version = Number(data.version);
        return { version, updatedAt: data.updated_at };
      });
    },
    issueDocument(documentId) {
      const requestedOwner = ownerId;
      return enqueue(async () => {
        const user = await requireUser();
        if (requestedOwner !== user.id) throw backendError('La sesión cambió.', 'AUTH_CHANGED');
        if (version === null || !workspace) throw backendError('Carga primero los datos de la empresa.', 'STATE_NOT_LOADED');
        const { data, error } = await client.rpc('issue_orquivia_document', {
          p_organization_id: workspace.organizationId, p_document_id: documentId, p_expected_version: version,
        });
        if (error) throw rpcError(error, 'No se pudo emitir el documento.');
        if (ownerId !== user.id) throw backendError('La sesión cambió durante la emisión.', 'AUTH_CHANGED');
        const state = validateCloudState(data.state);
        version = Number(data.version);
        return { state, version, updatedAt: data.updated_at, documentNumber: data.document_number };
      });
    },
    async auditLog(limit = 100) {
      await requireUser();
      if (!workspace) throw backendError('Carga primero la empresa.', 'STATE_NOT_LOADED');
      const { data, error } = await client.from('orquivia_audit_log').select('id,actor_email,event,workspace_version,changes,created_at')
        .eq('organization_id', workspace.organizationId).order('id', { ascending: false }).limit(Math.max(1, Math.min(500, limit)));
      if (error) throw backendError('No se pudo cargar el historial.', 'LOAD_ERROR', error);
      return data;
    },
    dispose() {
      disposed = true;
      listeners.clear();
      authEvents.subscription.unsubscribe();
      client.auth.stopAutoRefresh();
    },
  };
}
