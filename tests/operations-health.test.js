import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityLevel, collectOperationsHealth, formatCapacityBytes, renderOperationsHealth, WORKSPACE_STATE_LIMIT_BYTES } from '../src/operations-health.js';

const snapshot = () => ({ company: { name: 'Orquivia' }, clients: [], documents: [], payments: [], expenses: [], taxRecords: [] });

test('capacity counts UTF-8 bytes of the loaded snapshot rather than text characters or file sizes', () => {
  const state = snapshot();
  state.company.name = 'Orquivia · 日本';
  state.expenses.push({ attachments: [{ path: 'org/gasto/file.pdf', size: 9_000_000 }] });
  const health = collectOperationsHealth(state);
  assert.equal(health.stateBytes, Buffer.byteLength(JSON.stringify(state), 'utf8'));
  assert.ok(health.stateBytes > JSON.stringify(state).length);
  assert.equal(health.stateLimit, 5_000_000);
  assert.equal(health.knownFileBytes, 9_000_000);
  assert.equal(health.stateLevel, 'normal');
});

test('collection capacity uses the complete combined document history', () => {
  const state = snapshot();
  state.documents = [{ kind: 'quote', status: 'draft', date: '2025-01-01' }, { kind: 'quote', status: 'sent', date: '2026-01-01' }, { kind: 'invoice', status: 'issued', date: '2026-10-01' }];
  state.expenses = [{}, {}];
  state.taxRecords = [{}];
  const records = collectOperationsHealth(state).records;
  assert.equal(records.find(record => record.key === 'documents').count, 3);
  assert.equal(records.find(record => record.key === 'expenses').count, 2);
  assert.equal(records.find(record => record.key === 'taxRecords').count, 1);
  assert.ok(records.every(record => record.limit === 10_000));
});

test('referenced files are counted once across expenses and tax records and do not pretend to be a storage quota', () => {
  const state = snapshot();
  state.expenses = [{ attachments: [{ path: 'org/a/a.pdf', size: 2500 }, { id: 'unknown-file' }] }];
  state.taxRecords = [{ attachments: [{ path: 'org/a/a.pdf', size: 2500 }, { path: 'org/b/b.pdf', size: 1000 }] }];
  const health = collectOperationsHealth(state);
  assert.equal(health.fileCount, 3);
  assert.equal(health.knownFileBytes, 3500);
  assert.equal(health.unknownFileSizes, 1);
  assert.equal(health.storageQuota, undefined);
  assert.equal(health.lastBackup, undefined);
});

test('unmeasurable snapshots report unknown capacity instead of zero or success', () => {
  const state = snapshot(); state.circular = state;
  const health = collectOperationsHealth(state);
  assert.equal(health.stateBytes, null);
  assert.equal(health.stateLevel, 'unknown');
  assert.equal(formatCapacityBytes(health.stateBytes), 'Sin calcular');
});

test('capacity warnings start before the hard limit and report exactly reached or exceeded limits', () => {
  const limit = WORKSPACE_STATE_LIMIT_BYTES;
  for (const [fraction, expected] of [[0, 'normal'], [0.749, 'normal'], [0.75, 'watch'], [0.899, 'watch'], [0.9, 'warning'], [0.999, 'warning'], [1, 'full'], [1.1, 'full']]) {
    assert.equal(capacityLevel(limit * fraction, limit), expected);
  }
  assert.equal(capacityLevel(null, limit), 'unknown');
  assert.equal(capacityLevel(-1, limit), 'unknown');
});

test('health panel is absent unless the caller has an explicit authorized admin role', () => {
  for (const role of [undefined, null, 'editor', 'admin-other', '']) {
    assert.equal(renderOperationsHealth(snapshot(), { role }), '');
  }
  const markup = renderOperationsHealth(snapshot(), { role: 'admin', version: '1.4.1' });
  assert.match(markup, /Estado del portal/);
  assert.match(markup, /Versión 1\.4\.1/);
  assert.match(markup, /Pendiente de verificar/);
  assert.match(markup, /No hay una comprobación automática conectada/);
  assert.match(markup, /ni mide el almacenamiento total de Supabase/);
  assert.match(markup, /JSON compacto/);
  assert.match(markup, /servidor puede ocupar más/);
  assert.doesNotMatch(markup, /Respaldo correcto|Última copia correcta|Todo protegido/);
});

test('health presentation escapes external version text and never exposes business records or file paths', () => {
  const state = snapshot();
  state.company.name = 'Empresa secreta';
  state.expenses = [{ description: 'Gasto privado', attachments: [{ path: 'org/secreto/documento.pdf', size: 5000 }] }];
  const markup = renderOperationsHealth(state, { role: 'admin', version: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(markup, /<img|Empresa secreta|Gasto privado|org\/secreto/);
  assert.match(markup, /&lt;img/);
});

test('reaching either record or byte limits produces a visible planning warning', () => {
  const records = snapshot(); records.documents = Array.from({ length: 10_000 }, () => ({}));
  const markup = renderOperationsHealth(records, { role: 'admin' });
  assert.match(markup, /Límite alcanzado/);
  assert.match(markup, /Revisa la capacidad antes de seguir creciendo/);
  const bytes = snapshot(); bytes.company.notes = 'a'.repeat(WORKSPACE_STATE_LIMIT_BYTES);
  assert.equal(collectOperationsHealth(bytes).stateLevel, 'full');
});
