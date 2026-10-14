const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com']);

/** Prevents subscriptions being used as arbitrary server-side URL fetches. */
export function trustedPushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    const allowed = PUSH_HOSTS.has(url.hostname)
      || /^(?:[a-z0-9-]+\.)+push\.apple\.com$/.test(url.hostname)
      || /^(?:[a-z0-9-]+\.)+notify\.windows\.com$/.test(url.hostname);
    return allowed && url.protocol === 'https:' && !url.username && !url.password
      && !url.hash && (!url.port || url.port === '443') && url.pathname.length > 1;
  } catch { return false; }
}

function encodedBytes(value, expected) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > 100) return null;
  try {
    const encoded = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const bytes = Uint8Array.from(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)), (character) => character.charCodeAt(0));
    return bytes.length === expected ? bytes : null;
  } catch { return null; }
}

export function validPushSubscription(subscription) {
  const key = encodedBytes(subscription?.keys?.p256dh, 65);
  return trustedPushEndpoint(subscription?.endpoint) && key?.[0] === 4
    && !!encodedBytes(subscription?.keys?.auth, 16)
    && (subscription.expirationTime == null || (Number.isFinite(subscription.expirationTime) && subscription.expirationTime >= 0));
}

export function validVapidConfiguration(publicKey, privateKey, subject) {
  const key = encodedBytes(publicKey, 65);
  return key?.[0] === 4 && !!encodedBytes(privateKey, 32)
    && typeof subject === 'string' && subject.length <= 240
    && /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject);
}

export async function sameSecret(actual, expected) {
  const digest = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([digest(actual), digest(expected)]);
  let different = 0;
  for (let index = 0; index < left.length; index++) different |= left[index] ^ right[index];
  return different === 0;
}
