import test from 'node:test';
import assert from 'node:assert/strict';
import { sortDocumentsNewestFirst } from '../src/document-order.js';

const document = (id, number, date = '2026-11-16') => ({ id, number, date });

test('same-day documents display higher quote references first', () => {
  const documents = [document('q6', 'PR-2026-006'), document('q7', 'PR-2026-007')];
  assert.deepEqual(sortDocumentsNewestFirst(documents).map(item => item.number), ['PR-2026-007', 'PR-2026-006']);
});

test('numeric ordering handles unpadded and padded references rather than lexical digits', () => {
  const documents = [document('q9', 'PR-2026-9'), document('q10', 'PR-2026-10'), document('q8', 'PR-2026-008')];
  assert.deepEqual(sortDocumentsNewestFirst(documents).map(item => item.id), ['q10', 'q9', 'q8']);
  assert.deepEqual(sortDocumentsNewestFirst([document('f9', 'F-2026-009'), document('f10', 'F-2026-010')]).map(item => item.id), ['f10', 'f9']);
});

test('issue dates remain the primary order and sorting never mutates workspace records', () => {
  const documents = [document('old', 'PR-2026-100', '2026-11-15'), document('new', 'PR-2026-001', '2026-11-16')];
  const before = structuredClone(documents), sorted = sortDocumentsNewestFirst(documents);
  assert.deepEqual(sorted.map(item => item.id), ['new', 'old']);
  assert.deepEqual(documents, before);
  assert.notEqual(sorted, documents);
  assert.equal(sorted[0], documents[1]);
});

test('equivalent or absent references have an id tie-break independent of insertion order', () => {
  const documents = [document('c', ''), document('b', 'PR-2026-007'), document('a', 'PR-2026-7'), document('d', '')];
  assert.deepEqual(sortDocumentsNewestFirst(documents).map(item => item.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sortDocumentsNewestFirst([...documents].reverse()).map(item => item.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sortDocumentsNewestFirst(), []);
});
