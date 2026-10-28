import { readFile } from 'node:fs/promises';
import { X509Certificate, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public trust anchor downloaded from the project's SSL settings. This is not
// a private key. A CA rotation requires review of the provider's new certificate.
export const SUPABASE_ROOT_SHA256 = '807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa';
export const SUPABASE_ROOT_CERTIFICATE_URL = new URL('./certs/supabase-root-2021.crt',import.meta.url);
export async function verifyBackupCertificate({ read = () => readFile(SUPABASE_ROOT_CERTIFICATE_URL), now = Date.now() } = {}) {
  try {
    const bytes = await read();
    if (!Buffer.isBuffer(bytes) || bytes.length > 16384 || bytes.includes(Buffer.from('PRIVATE KEY'))) throw new Error();
    const certificate = new X509Certificate(bytes);
    const digest = createHash('sha256').update(certificate.raw).digest('hex');
    const validFrom = Date.parse(certificate.validFrom), validTo = Date.parse(certificate.validTo);
    if (digest !== SUPABASE_ROOT_SHA256 || certificate.ca !== true || !certificate.checkIssued(certificate)
      || !certificate.verify(certificate.publicKey) || !Number.isFinite(now) || !Number.isFinite(validFrom)
      || !Number.isFinite(validTo) || now < validFrom || now >= validTo) throw new Error();
    return { status:'trusted-certificate-verified',sha256:digest,validUntil:new Date(validTo).toISOString() };
  } catch { throw Object.assign(new Error('BACKUP_CERTIFICATE_INVALID'),{code:'BACKUP_CERTIFICATE_INVALID'}); }
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length!==2) throw new Error();
    console.log(JSON.stringify(await verifyBackupCertificate()));
  } catch { console.error(JSON.stringify({status:'failed',code:'BACKUP_CERTIFICATE_INVALID'}));process.exitCode=1; }
}
