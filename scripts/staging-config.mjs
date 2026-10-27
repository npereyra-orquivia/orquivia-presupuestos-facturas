import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicConfigIsValid } from '../src/security.js';

export const PRODUCTION_PROJECT_REF = 'tfaglecwycbamibnhqmq';

/** Fail before building: a testing URL must never silently use live data or mail. */
export function assertStagingConfiguration(env = process.env) {
  if (env.VITE_APP_MODE !== 'staging') throw new Error('STAGING_MODE_REQUIRED');
  if (env.VITE_DOCUMENT_MAIL !== 'false') throw new Error('STAGING_MAIL_MUST_BE_DISABLED');
  const config = { url: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_PUBLISHABLE_KEY };
  if (!publicConfigIsValid(config)) throw new Error('STAGING_PUBLIC_CONFIGURATION_REQUIRED');
  const ref = new URL(config.url).hostname.split('.')[0];
  if (ref === PRODUCTION_PROJECT_REF) throw new Error('STAGING_PRODUCTION_PROJECT_FORBIDDEN');
  if (env.ORQUIVIA_STAGING_PROJECT_REF !== ref) throw new Error('STAGING_PROJECT_CONFIRMATION_REQUIRED');
  return { projectRef: ref, mailEnabled: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertStagingConfiguration(); console.log('Configuración de pruebas independiente comprobada; correo desactivado.'); }
  catch (error) { console.error(`Build de pruebas detenido: ${error.message}.`); process.exitCode = 1; }
}
