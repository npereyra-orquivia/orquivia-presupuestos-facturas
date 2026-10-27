import { defineConfig, loadEnv } from 'vite';
import { browserSecurityPolicy } from './scripts/security-policy.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// This endpoint exists only in the loopback development server. It is never
// copied to GitHub Pages, and exposes no arbitrary filesystem paths.
let configuredMode = 'production';
const localImport = {
  name: 'orquivia-private-local-preview',
  configResolved(config) { configuredMode = config.mode; },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/__local-import') return next();
      const allowed = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '');
      if (!allowed || req.method !== 'GET') { res.statusCode = 403; return res.end(); }
      if (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) { res.statusCode = 403; return res.end(); }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      try { res.end(await readFile(resolve('private/initial-state.json'), 'utf8')); }
      catch { res.statusCode = 404; res.end('{}'); }
    });
  },
  transformIndexHtml(html, ctx) {
    const dev = !!ctx.server;
    const env = loadEnv(configuredMode, process.cwd(), 'VITE_');
    const csp = browserSecurityPolicy({ development:dev, supabaseURL:process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL || '' });
    return html.replace('<!-- SECURITY_POLICY -->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  },
};
export default defineConfig({ base: './', plugins:[localImport], server: { host:'127.0.0.1',port:5173,strictPort:true,allowedHosts:['localhost','127.0.0.1'] } });
