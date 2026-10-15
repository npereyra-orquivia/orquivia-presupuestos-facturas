const failure = (message, code = 'MAIL_ERROR') => Object.assign(new Error(message), { code });
const messages = {
  VERSION_CONFLICT: 'Otra sesión ha cambiado los datos. Recarga antes de enviar.',
  PROFILE_CONFLICT: 'Tu configuración cambió en otra pestaña. Vuelve a cargarla.',
  MAIL_NOT_CONFIGURED: 'Conecta primero tu correo de Arsys en Mi espacio.',
  MAIL_AUTH_FAILED: 'Arsys no ha aceptado la conexión. Revisa la contraseña del correo.',
  MAIL_CONNECTION_FAILED: 'No se pudo conectar con Arsys. Inténtalo de nuevo más tarde.',
  RATE_LIMITED: 'Has alcanzado el límite temporal de envíos. Espera antes de continuar.',
  MFA_REQUIRED: 'Confirma tu acceso con la verificación en dos pasos.',
  AUTH_CHANGED: 'La sesión cambió. Entra de nuevo antes de continuar.',
  INVALID_DOCUMENT: 'Prepara el presupuesto antes de enviarlo por correo.',
  DOCUMENT_NOT_SENDABLE: 'Este presupuesto no está preparado para enviarse.',
};

/** No mailbox credential is persisted or returned to the browser. */
export function createDocumentMailBackend({ client, requireUser, getWorkspace, getVersion, enqueue, adoptWorkspace }) {
  async function context() {
    const user = await requireUser();
    const workspace = getWorkspace();
    if (!workspace?.organizationId) throw failure('Carga primero la empresa.', 'STATE_NOT_LOADED');
    return { userId: user.id, organizationId: workspace.organizationId };
  }
  async function request(action, fields = {}) {
    const captured = await context();
    const { data, error } = await client.functions.invoke('document-mail', {
      body: { ...fields, action, expectedUserId: captured.userId, organizationId: captured.organizationId },
    });
    const now = await context();
    if (now.userId !== captured.userId || now.organizationId !== captured.organizationId) throw failure(messages.AUTH_CHANGED, 'AUTH_CHANGED');
    if (error || data?.error) {
      let response = data;
      if (error?.context?.json) try { response = await error.context.json(); } catch {}
      const code = typeof response?.error === 'string' ? response.error : response?.error?.code || response?.code || 'MAIL_ERROR';
      throw failure(messages[code] || 'No se pudo completar la operación de correo. Comprueba su estado antes de repetir un envío.', code);
    }
    return data;
  }
  return {
    profile: () => request('profile'),
    configure: fields => request('configure', fields),
    signature: fields => request('signature', fields),
    disconnect: fields => request('disconnect', fields),
    async history(documentId) {
      const result = await request('history', { documentId });
      return Array.isArray(result) ? result : result?.history || [];
    },
    send(documentId, fields) {
      const requestedVersion = getVersion();
      if (requestedVersion === null) return Promise.reject(failure('Recarga los datos antes de enviar.', 'STATE_NOT_LOADED'));
      return enqueue(async () => {
        if (getVersion() !== requestedVersion) throw failure(messages.VERSION_CONFLICT, 'VERSION_CONFLICT');
        const result = await request('send', { ...fields, documentId, expectedWorkspaceVersion: requestedVersion });
        if (result?.workspace) adoptWorkspace(result.workspace);
        return result;
      });
    },
    retryArchive: fields => request('retryArchive', fields),
  };
}
