let registrationPromise;

export function pushCapability() {
  const installed = globalThis.matchMedia?.('(display-mode: standalone)').matches === true
    || globalThis.navigator?.standalone === true;
  const iphone = /iPhone|iPad|iPod/.test(globalThis.navigator?.userAgent || '')
    || (globalThis.navigator?.platform === 'MacIntel' && globalThis.navigator?.maxTouchPoints > 1);
  const supported = globalThis.isSecureContext === true && !!globalThis.navigator?.serviceWorker
    && typeof globalThis.PushManager !== 'undefined' && typeof globalThis.Notification !== 'undefined';
  const guidance = iphone && !installed
    ? 'En tu iPhone: abre Orquívia en Safari, pulsa Compartir y Añadir a pantalla de inicio. Abre ese acceso para activar los avisos (iOS 16.4 o posterior).'
    : !supported ? 'Este navegador no permite avisos push. Puedes revisar tus pendientes en el portal.' : '';
  return {
    supported, installed, needsInstall: iphone && !installed,
    permission: typeof globalThis.Notification !== 'undefined' ? Notification.permission : 'unsupported',
    guidance, reason: guidance,
  };
}

export function registerPWA({ baseURL = import.meta.env?.BASE_URL || './', onOpenAlerts } = {}) {
  if (!globalThis.navigator?.serviceWorker || !globalThis.isSecureContext) return Promise.resolve(null);
  if (!registrationPromise) {
    const base = new URL(baseURL, document.baseURI);
    registrationPromise = navigator.serviceWorker.register(new URL('service-worker.js', base), {
      scope: base.pathname, updateViaCache: 'none',
    }).then(async (registration) => {
      if (!registration.active) {
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('La aplicación está tardando en preparar los avisos. Vuelve a intentarlo.')), 15_000)),
        ]);
      }
      return registration;
    }).catch((error) => { registrationPromise = undefined; throw error; });
  }
  if (onOpenAlerts) {
    const listener = (event) => {
      if (event.source === navigator.serviceWorker.controller && event.data?.type === 'ORQUIVIA_OPEN_ALERTS') onOpenAlerts();
    };
    navigator.serviceWorker.addEventListener('message', listener);
  }
  return registrationPromise;
}

export function vapidPublicBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error('Los avisos push aún no están configurados en el servidor.');
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('La clave pública de avisos no es válida.');
  return bytes;
}

/** Call directly from a click/tap. Request permission before awaiting any network call. */
export async function enableDevicePush({ backend, publicKey = import.meta.env?.VITE_VAPID_PUBLIC_KEY, baseURL } = {}) {
  const capability = pushCapability();
  if (capability.needsInstall || !capability.supported) throw new Error(capability.guidance);
  const applicationServerKey = vapidPublicBytes(publicKey);
  if (!backend?.savePushSubscription) throw new Error('Inicia sesión para activar los avisos.');
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('No has permitido los avisos. Puedes cambiar el permiso en los ajustes de tu dispositivo.');
  const registration = await registerPWA({ baseURL });
  if (!registration?.pushManager) throw new Error('No se ha podido preparar la aplicación para los avisos.');
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && subscription.options?.applicationServerKey) {
    const original = new Uint8Array(subscription.options.applicationServerKey);
    if (original.length !== applicationServerKey.length || original.some((byte, index) => byte !== applicationServerKey[index])) {
      throw new Error('La clave de avisos ha cambiado. Desactiva los avisos de este dispositivo y vuelve a activarlos.');
    }
  }
  const created = !subscription;
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  try {
    const saved = await backend.savePushSubscription(subscription.toJSON());
    return { subscription: saved, endpoint: subscription.endpoint };
  } catch (error) {
    if (created) try { await subscription.unsubscribe(); } catch {}
    throw error;
  }
}

export async function devicePushSubscription({ baseURL } = {}) {
  const capability = pushCapability();
  if (!capability.supported) return null;
  const registration = await registerPWA({ baseURL });
  return registration?.pushManager ? registration.pushManager.getSubscription() : null;
}

export async function disableDevicePush({ backend, baseURL } = {}) {
  const subscription = await devicePushSubscription({ baseURL });
  if (!subscription) return false;
  // Remove the server target before revoking browser permission/subscription.
  if (!backend?.removePushSubscription) throw new Error('Inicia sesión para desactivar los avisos de este dispositivo.');
  await backend.removePushSubscription(subscription.endpoint);
  if (!(await subscription.unsubscribe())) throw new Error('El servidor ya no enviará avisos, pero debes revisar el permiso en los ajustes del dispositivo.');
  return true;
}
