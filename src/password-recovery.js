const AUTH_KEYS = ['access_token', 'refresh_token', 'token_type', 'expires_in', 'expires_at', 'type', 'error', 'error_code', 'error_description'];
const CALLBACK_ERROR = 'El enlace para restablecer la contraseña no es válido o ha caducado. Solicita uno nuevo.';

/** Only an explicit recovery callback may replace a portal session. */
export function validRecoveryCredentials(credentials) {
  return Boolean(credentials && typeof credentials.accessToken === 'string' && typeof credentials.refreshToken === 'string'
    && credentials.accessToken.length <= 16_384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credentials.accessToken)
    && /^[A-Za-z0-9._~-]{8,4096}$/.test(credentials.refreshToken));
}

/** Parse, never log, the default Supabase implicit recovery callback.
 * Call history.replaceState with cleanURL before consuming credentials or making requests.
 */
export function parsePasswordRecoveryURL(input) {
  const url = new URL(input);
  const values = new URLSearchParams(url.hash.slice(1));
  const callback = AUTH_KEYS.some(key => values.has(key) || url.searchParams.has(key)) || url.searchParams.get('recuperar') === '1';
  if (!callback) return null;
  const clean = new URL(url);
  clean.hash = '';
  clean.searchParams.delete('recuperar');
  // Query-form credentials are not supported, and must never remain in the URL.
  for (const key of AUTH_KEYS) clean.searchParams.delete(key);
  const result = { credentials: null, error: CALLBACK_ERROR, cleanURL: clean.href };
  if (AUTH_KEYS.some(key => values.getAll(key).length > 1 || url.searchParams.has(key)) || values.has('error') || values.has('error_code')
    || values.get('type') !== 'recovery' || (values.has('token_type') && values.get('token_type') !== 'bearer')) return result;
  const credentials = { accessToken: values.get('access_token'), refreshToken: values.get('refresh_token') };
  if (!validRecoveryCredentials(credentials)) return result;
  return { ...result, credentials, error: null };
}
