/** Bound production network access to the configured project, not every Supabase tenant. */
export function browserSecurityPolicy({ development = false, supabaseURL = '' } = {}) {
  const project = /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(supabaseURL) ? new URL(supabaseURL).origin : '';
  const endpoints = project ? `${project} ${project.replace('https:', 'wss:')}` : development ? 'https://*.supabase.co wss://*.supabase.co' : '';
  const local = development ? ' http://127.0.0.1:* ws://127.0.0.1:*' : '';
  return `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${local}${endpoints ? ` ${endpoints}` : ''}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'; worker-src 'self' blob:; manifest-src 'self'`;
}
