import { validateReceiptFile } from './backend.js';

export const AVATAR_BUCKET = 'orquivia-avatars';
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const DEFAULT_NOTIFICATIONS = Object.freeze({ enabled: false, payment: true, contract: true, review: true, daysBefore: 2, onDueDate: true, repeatDays: 2, hour: 9 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AVATAR_TYPES = Object.freeze({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com']);
const fail = (message, code, cause) => Object.assign(new Error(message, { cause }), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateNotificationPreferences(preferences) {
  if (!object(preferences)) throw fail('La configuración de avisos no es válida.', 'INVALID_PROFILE');
  const result = {};
  for (const key of ['enabled', 'payment', 'contract', 'review', 'onDueDate']) {
    if (typeof preferences[key] !== 'boolean') throw fail('La configuración de avisos no es válida.', 'INVALID_PROFILE');
    result[key] = preferences[key];
  }
  for (const [key, maximum] of [['daysBefore', 30], ['repeatDays', 30], ['hour', 23]]) {
    if (!Number.isInteger(preferences[key]) || preferences[key] < 0 || preferences[key] > maximum) throw fail('Revisa los días y la hora de los avisos.', 'INVALID_PROFILE');
    result[key] = preferences[key];
  }
  return result;
}

export function defaultPersonalProfile(user = null, workspace = null) {
  return { userId: user?.id ?? null, organizationId: workspace?.organizationId ?? null, displayName: '', avatar: null, notifications: { ...DEFAULT_NOTIFICATIONS }, updatedAt: null };
}

export function validateProfile(profile) {
  if (!object(profile) || typeof profile.displayName !== 'string' || profile.displayName.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(profile.displayName)) throw fail('El nombre puede tener hasta 100 caracteres.', 'INVALID_PROFILE');
  return { displayName: profile.displayName.trim(), avatar: profile.avatar == null ? null : structuredClone(profile.avatar), notifications: validateNotificationPreferences(profile.notifications) };
}

export function validatePushSubscription(subscription) {
  if (!object(subscription) || !object(subscription.keys)) throw fail('La suscripción del dispositivo no es válida.', 'INVALID_PUSH_SUBSCRIPTION');
  let endpoint;
  try { endpoint = new URL(subscription.endpoint); } catch { throw fail('La dirección de notificaciones no es válida.', 'INVALID_PUSH_SUBSCRIPTION'); }
  const host = endpoint.hostname;
  const approvedHost = PUSH_HOSTS.has(host) || (host.endsWith('.notify.windows.com') && host !== '.notify.windows.com');
  if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password || endpoint.hash || !approvedHost || endpoint.href.length > 2048) {
    throw fail('La dirección no pertenece a un servicio de notificaciones compatible.', 'INVALID_PUSH_SUBSCRIPTION');
  }
  if (!/^[A-Za-z0-9_-]{87}$/.test(subscription.keys.p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(subscription.keys.auth)) {
    throw fail('Las claves del dispositivo no son válidas.', 'INVALID_PUSH_SUBSCRIPTION');
  }
  // The stored registration is a fresh snapshot; expiration is provider-managed.
  return { endpoint: endpoint.href, expirationTime: null, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };
}

export async function validateAvatarFile(file) {
  if (!Number.isSafeInteger(file?.size) || file.size <= 0 || file.size > MAX_AVATAR_BYTES) throw fail('La foto debe ocupar como máximo 2 MB.', 'INVALID_AVATAR');
  const metadata = await validateReceiptFile(file).catch(error => { throw fail('Utiliza una foto JPG, PNG o WebP válida.', 'INVALID_AVATAR', error); });
  if (!Object.hasOwn(AVATAR_TYPES, metadata.extension)) throw fail('Utiliza una foto JPG, PNG o WebP.', 'INVALID_AVATAR');
  return metadata;
}

/** Personal information never enters the shared financial workspace. */
export function createPersonalBackend({ client, requireUser, getWorkspace, url }) {
  async function context() {
    const user = await requireUser();
    const workspace = getWorkspace();
    if (!workspace?.organizationId) throw fail('Carga primero la empresa.', 'STATE_NOT_LOADED');
    return { user, organizationId: workspace.organizationId };
  }
  async function assertSame(captured) {
    const now = await context();
    if (now.user.id !== captured.user.id || now.organizationId !== captured.organizationId) throw fail('La sesión cambió. Recarga antes de continuar.', 'AUTH_CHANGED');
  }
  function avatarPath(avatar, captured) {
    if (!object(avatar) || !UUID.test(avatar.id) || typeof avatar.path !== 'string' || !Object.hasOwn(AVATAR_TYPES, avatar.extension)
      || avatar.mimeType !== AVATAR_TYPES[avatar.extension] || !Number.isSafeInteger(avatar.size) || avatar.size < 1 || avatar.size > MAX_AVATAR_BYTES
      || avatar.path !== `${captured.organizationId}/${captured.user.id}/${avatar.id}.${avatar.extension}`) {
      throw fail('La foto no pertenece a tu perfil.', 'INVALID_AVATAR');
    }
    return avatar.path;
  }
  function rpcError(error, fallback) {
    const code = ['AUTH_CHANGED', 'MFA_REQUIRED', 'MEMBERSHIP_REQUIRED', 'INVALID_PROFILE', 'INVALID_AVATAR', 'INVALID_PUSH_SUBSCRIPTION'].find(name => error?.message?.includes(name));
    const messages = { AUTH_CHANGED: 'La sesión cambió. Recarga antes de continuar.', MFA_REQUIRED: 'Completa la verificación en dos pasos.', MEMBERSHIP_REQUIRED: 'Tu cuenta ya no tiene acceso a esta empresa.', INVALID_PROFILE: 'Revisa los datos del perfil.', INVALID_AVATAR: 'La foto no está guardada en tu perfil o no coincide con el archivo subido.', INVALID_PUSH_SUBSCRIPTION: 'No se pudo registrar este dispositivo de notificaciones.' };
    return fail(messages[code] || fallback, code === 'MEMBERSHIP_REQUIRED' ? 'ACCESS_REVOKED' : code || 'PERSONAL_SAVE_ERROR', error);
  }
  async function rpc(name, parameters, fallback) {
    const captured = await context();
    const expectedIdentity = name === 'get_orquivia_push_config' ? {} : { p_expected_user_id: captured.user.id };
    const { data, error } = await client.rpc(name, { ...parameters, ...expectedIdentity });
    if (error) throw rpcError(error, fallback);
    await assertSame(captured);
    return data;
  }
  return {
    loadProfile() { return rpc('load_orquivia_profile', {}, 'No se pudo cargar tu perfil.'); },
    getPushConfig() { return rpc('get_orquivia_push_config', {}, 'No se pudo comprobar el servicio de notificaciones.'); },
    async saveProfile(profile) {
      const snapshot = validateProfile(profile);
      const captured = await context();
      if (snapshot.avatar != null) avatarPath(snapshot.avatar, captured);
      const { data, error } = await client.rpc('save_orquivia_profile', { p_profile: snapshot, p_expected_user_id: captured.user.id });
      if (error) throw rpcError(error, 'No se pudo guardar tu perfil.');
      await assertSame(captured);
      return data;
    },
    async uploadAvatar(file) {
      const metadata = await validateAvatarFile(file);
      const captured = await context();
      const id = crypto.randomUUID();
      const path = `${captured.organizationId}/${captured.user.id}/${id}.${metadata.extension}`;
      const { error } = await client.storage.from(AVATAR_BUCKET).upload(path, file.slice(0, file.size, metadata.mimeType), { contentType: metadata.mimeType, cacheControl: '0', upsert: false });
      if (error) throw fail('No se pudo guardar la foto privada.', 'AVATAR_UPLOAD_ERROR', error);
      await assertSame(captured);
      return { id, path, extension: metadata.extension, mimeType: metadata.mimeType, size: metadata.size };
    },
    async avatarUrl(avatar) {
      const captured = await context();
      const path = avatarPath(avatar, captured);
      const { data, error } = await client.storage.from(AVATAR_BUCKET).createSignedUrl(path, 60);
      if (error || !data?.signedUrl) throw fail('No se pudo abrir la foto privada.', 'AVATAR_READ_ERROR', error);
      await assertSame(captured);
      const signed = new URL(data.signedUrl);
      if (signed.protocol !== 'https:' || (url && signed.origin !== new URL(url).origin) || !signed.pathname.startsWith('/storage/v1/object/sign/')) throw fail('La dirección de la foto no es válida.', 'AVATAR_READ_ERROR');
      return data.signedUrl;
    },
    async downloadAvatar(avatar) {
      const captured = await context();
      const { data, error } = await client.storage.from(AVATAR_BUCKET).download(avatarPath(avatar, captured), {}, { cache: 'no-store' });
      if (error || !data) throw fail('No se pudo cargar la foto privada.', 'AVATAR_READ_ERROR', error);
      await assertSame(captured);
      return data;
    },
    async deleteAvatar(avatar) {
      const captured = await context();
      const path = avatarPath(avatar, captured);
      const { data, error } = await client.storage.from(AVATAR_BUCKET).remove([path]);
      if (error || !data?.some(row => row.name === path)) throw fail('Guarda primero tu perfil sin esta foto para poder eliminarla.', 'AVATAR_DELETE_ERROR', error);
      await assertSame(captured);
    },
    savePushSubscription(subscription) {
      const snapshot = validatePushSubscription(subscription);
      return rpc('save_orquivia_push_subscription', { p_subscription: snapshot }, 'No se pudo activar este dispositivo.');
    },
    removePushSubscription(endpoint) {
      if (typeof endpoint !== 'string' || endpoint.length > 2048) throw fail('El dispositivo no es válido.', 'INVALID_PUSH_SUBSCRIPTION');
      return rpc('remove_orquivia_push_subscription', { p_endpoint: endpoint }, 'No se pudo desactivar este dispositivo.');
    },
    subscriptions() { return rpc('list_orquivia_push_subscriptions', {}, 'No se pudieron consultar tus dispositivos.'); },
  };
}
