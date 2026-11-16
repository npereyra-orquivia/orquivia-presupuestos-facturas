const references = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Newest issue date first; same-day references use their natural numeric order. */
export function sortDocumentsNewestFirst(documents = []) {
  return [...documents].sort((a, b) => {
    const byDate = String(b.date || '').localeCompare(String(a.date || ''));
    if (byDate) return byDate;
    const byReference = references.compare(String(b.number || ''), String(a.number || ''));
    if (byReference) return byReference;
    // Equal/missing references cannot fall back to the workspace's insertion order.
    const left = String(a.id || ''), right = String(b.id || '');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
