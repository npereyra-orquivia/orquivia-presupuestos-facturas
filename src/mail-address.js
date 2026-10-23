/** A single, plain address shared by saved contacts and mail recipients. */
export function isMailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\s\u0000-\u001f\u007f<>]/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0])) return false;
  return parts[1].length <= 253 && parts[1].includes('.') && parts[1].split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
