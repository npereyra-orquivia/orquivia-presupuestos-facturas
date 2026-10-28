import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyBackupCertificate, SUPABASE_ROOT_CERTIFICATE_URL, SUPABASE_ROOT_SHA256 } from '../scripts/backup/verify-certificate.mjs';

test('the public provider CA is pinned, self-issued and valid for the current backup deployment',async()=>{
  const result=await verifyBackupCertificate({now:Date.parse('2026-10-28T10:00:00Z')});
  assert.equal(result.status,'trusted-certificate-verified');assert.equal(result.sha256,SUPABASE_ROOT_SHA256);
  assert.ok(Date.parse(result.validUntil)>Date.parse('2031-01-01T00:00:00Z'));
});

test('an expired, not-yet-valid, malformed or substituted trust anchor cannot pass',async()=>{
  for(const now of [NaN,Date.parse('2020-01-01T00:00:00Z'),Date.parse('2032-01-01T00:00:00Z')])
    await assert.rejects(verifyBackupCertificate({now}),{code:'BACKUP_CERTIFICATE_INVALID'});
  const bytes=await readFile(SUPABASE_ROOT_CERTIFICATE_URL),tampered=Buffer.from(bytes);
  const position=tampered.indexOf(Buffer.from('MI'));tampered[position+4]^=1;
  for(const value of [Buffer.from('not a certificate'),tampered,Buffer.concat([bytes,Buffer.from('PRIVATE KEY')])])
    await assert.rejects(verifyBackupCertificate({read:async()=>value}),{code:'BACKUP_CERTIFICATE_INVALID'});
});
