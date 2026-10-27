/** Testing uses normal authentication, but has its own database and no mail UI. */
export function installEnvironmentNotice({ mode, document: doc = globalThis.document } = {}) {
  if (mode !== 'staging' || !doc?.body) return;
  const notice = doc.createElement('aside');
  notice.className = 'environment-notice';
  notice.setAttribute('role', 'note');
  notice.textContent = 'Entorno de pruebas · Datos separados de la empresa · Envío de documentos por correo desactivado';
  doc.body.prepend(notice);
}
