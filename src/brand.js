export const BRAND_NAME = 'Orquivia';

/** Correct only the complete brand word; keep casing and every other accent. */
export function normalizeOrquivia(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/[\p{L}\p{M}\p{N}_]+/gu, word => {
    const plain = word.normalize('NFD').replace(/\p{M}/gu, '');
    return plain.toLowerCase() === BRAND_NAME.toLowerCase() ? plain : word;
  });
}
