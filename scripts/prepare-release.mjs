import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const legacyDirectory = 'pruebas-v1-1';
// This address identifies the application, never a release. Versions live in Git tags.
const appPath = '/orquivia-presupuestos-facturas/';
const publicNames = new Set(['index.html', 'manifest.webmanifest', 'service-worker.js']);
const publicAsset = name => /^orquivia-[A-Za-z0-9-]+\.(?:png|svg)$/.test(name);
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const redirectHTML = `<!doctype html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'none'; img-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'">
<link rel="manifest" href="./manifest.webmanifest"><title>Orquivia</title>
<script src="./redirect.js" defer></script></head>
<body><h1>Orquivia</h1><p>Abriendo la aplicación…</p><p><a href="../">Abrir Orquivia</a></p></body></html>
`;

const redirectJS = `// Fixed same-origin destination. Query and hash are data, never a redirect target.
const target = new URL('../', window.location.href);
if (target.origin !== window.location.origin) throw new Error('Invalid Orquivia origin');
target.search = window.location.search;
target.hash = window.location.hash;
window.location.replace(target.href);
`;

const fallbackHTML = `<!doctype html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'">
<link rel="canonical" href="${appPath}"><title>Orquivia</title>
<script src="${appPath}canonical-redirect.js" defer></script></head>
<body><h1>Orquivia</h1><p>La aplicación tiene una dirección única. Abriendo Orquivia…</p><p><a href="${appPath}">Abrir Orquivia</a></p></body></html>
`;

const fallbackJS = `// Resolve the fixed root from this deployed script, not from a requested path.
const target = new URL('.', document.currentScript.src);
const source = new URL(window.location.href);
if (target.origin !== source.origin) throw new Error('Invalid Orquivia origin');
if (source.pathname.startsWith(target.pathname) && source.pathname !== target.pathname
  && !/\\/(?:assets|pdfjs)\\//.test(source.pathname.slice(target.pathname.length - 1))) {
  target.search = source.search;
  target.hash = source.hash;
  window.location.replace(target.href);
}
`;

const compatibilityWorker = `/* Legacy subscription compatibility only. No fetch handler or application-data cache. */
const appRoot = new URL('../', self.registration.scope);
const alertsURL = new URL('./?view=alerts', appRoot);
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload;
    try {
      const source = event.data?.text() || '';
      if (source.length > 2048) return;
      payload = JSON.parse(source);
    } catch { return; }
    if (payload?.kind !== 'orquivia-reminder' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(payload.day || '')) return;
    await self.registration.showNotification('Orquivia', {
      body: 'Tienes tareas pendientes. Abre Orquivia para revisarlas.',
      icon: new URL('orquivia-icon-192.png', appRoot).href,
      badge: new URL('orquivia-icon-192.png', appRoot).href,
      tag: 'orquivia-' + payload.day, renotify: false, data: { url: alertsURL.href },
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin !== appRoot.origin || !url.pathname.startsWith(appRoot.pathname)) continue;
      try {
        // Navigation works even when the root app has a different controlling worker.
        const opened = await client.navigate(alertsURL.href);
        if (opened) { await opened.focus(); return; }
      } catch {}
    }
    await self.clients.openWindow(alertsURL.href);
  })());
});
`;

async function directory(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Falta ${label}.`);
  const absolute = path.resolve(value), stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} debe ser un directorio de build sin enlaces simbólicos.`);
  return fs.realpath(absolute);
}

async function buildDirectory(value, label) {
  const root = await directory(value, label);
  for (const name of ['index.html', 'manifest.webmanifest', 'service-worker.js']) {
    const stat = await fs.lstat(path.join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} no contiene un build válido.`);
  }
  const assets = await fs.lstat(path.join(root, 'assets'));
  if (!assets.isDirectory() || assets.isSymbolicLink()) throw new Error(`${label} no contiene los assets del build.`);
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const entry = html.match(/<script\b[^>]*\bsrc=["']\.?\/?(assets\/[^"']+\.js)["']/i)?.[1];
  if (!entry || entry.includes('..') || entry.includes('\\')) throw new Error(`${label} no contiene la entrada JavaScript del build.`);
  const entryStat = await fs.lstat(path.join(root, ...entry.split('/')));
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error(`${label} no contiene la entrada JavaScript del build.`);
  return root;
}

async function legacyFiles(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await fs.lstat(path.join(directory, entry.name));
      if (stat.isSymbolicLink()) throw new Error('El build legado contiene un enlace simbólico.');
      if (!prefix && !['assets', 'pdfjs'].includes(entry.name) && !publicNames.has(entry.name) && !publicAsset(entry.name)) {
        throw new Error(`Archivo inesperado en el build legado: ${entry.name}`);
      }
      if (stat.isDirectory()) {
        if (!prefix && !['assets', 'pdfjs'].includes(entry.name)) throw new Error('Directorio inesperado en el build legado.');
        await walk(path.join(directory, entry.name), relative);
      } else if (stat.isFile()) {
        if (/(?:^|\/)(?:\.|private|credentials)|\.(?:pdf|docx?|xlsx?|rar|zip)$/i.test(relative)) throw new Error('El build legado contiene archivos ajenos a los recursos públicos.');
        files.push(relative);
      } else throw new Error('El build legado contiene un archivo no regular.');
    }
  }
  await walk(root);
  return files;
}

/** Assemble compatibility resources around an already-built operational root. */
export async function prepareRelease({ dist = 'dist', legacyDist, previousDists = [], version } = {}) {
  const root = await buildDirectory(dist, 'dist'), legacy = await buildDirectory(legacyDist, '--legacy-dist');
  if (inside(root, legacy) || inside(legacy, root)) throw new Error('dist y --legacy-dist deben ser directorios independientes.');
  if (!Array.isArray(previousDists)) throw new Error('Las versiones anteriores deben indicarse como directorios de build.');
  if (version === undefined) version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('La versión publicada no es válida.');
  const compatible = [];
  for (const value of previousDists) {
    const previous = await buildDirectory(value, '--previous-dist');
    if (inside(root, previous) || inside(previous, root)) throw new Error('Las versiones anteriores deben estar fuera de dist.');
    compatible.push({ root: previous, files: (await legacyFiles(previous)).filter(file => /^(?:assets|pdfjs)\//.test(file)) });
  }
  const files = await legacyFiles(legacy);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.webmanifest'), 'utf8'));
  if (!Array.isArray(manifest.icons) || !manifest.icons.length) throw new Error('El manifest operativo no contiene iconos.');
  const icons = await Promise.all(manifest.icons.map(async icon => {
    if (!icon || typeof icon.src !== 'string' || !publicAsset(icon.src)) throw new Error('El manifest operativo contiene una ruta de icono inesperada.');
    const stat = await fs.lstat(path.join(root, icon.src));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Falta un icono operativo.');
    return { ...icon, src: `../${icon.src}` };
  }));
  const target = path.resolve(root, legacyDirectory);
  // Validate the final absolute removal target before replacing generated output.
  if (target === root || !inside(root, target)) throw new Error('Destino legado fuera de dist.');
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(root, await fs.realpath(target))) throw new Error('El destino legado no es un directorio generado seguro.');
    await fs.rm(target, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(target, { recursive: true });
  for (const relative of files) {
    if (publicNames.has(relative)) continue;
    const destination = path.join(target, ...relative.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(legacy, ...relative.split('/')), destination);
  }
  await Promise.all([
    fs.writeFile(path.join(target, 'index.html'), redirectHTML),
    fs.writeFile(path.join(target, 'redirect.js'), redirectJS),
    fs.writeFile(path.join(target, 'service-worker.js'), compatibilityWorker),
    fs.writeFile(path.join(target, 'manifest.webmanifest'), JSON.stringify({ ...manifest, id: './', start_url: '../', scope: '../', icons }, null, 2) + '\n'),
  ]);
  let preservedRootFiles = 0;
  for (const previous of compatible) for (const relative of previous.files) {
    const source = await fs.readFile(path.join(previous.root, ...relative.split('/')));
    const destination = path.join(root, ...relative.split('/'));
    try {
      const current = await fs.readFile(destination);
      // Hashed bundles must never collide. Shared, unversioned PDF fonts and
      // notices use the current release's copy when it already exists.
      if (!current.equals(source) && relative.startsWith('assets/')) throw new Error(`Un recurso de compatibilidad cambiaría un archivo actual: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, source, { flag: 'wx' });
      ++preservedRootFiles;
    }
  }
  await Promise.all([
    fs.writeFile(path.join(root, '404.html'), fallbackHTML),
    fs.writeFile(path.join(root, 'canonical-redirect.js'), fallbackJS),
    fs.writeFile(path.join(root, 'version.json'), JSON.stringify({ version }) + '\n'),
  ]);
  return { dist: root, legacyDirectory: target, preservedFiles: files.filter(file => !publicNames.has(file)).length, preservedRootFiles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { dist: { type: 'string', default: 'dist' }, 'legacy-dist': { type: 'string' }, 'previous-dist': { type: 'string', multiple: true, default: [] } }, strict: true, allowPositionals: false });
    const result = await prepareRelease({ dist: values.dist, legacyDist: values['legacy-dist'], previousDists: values['previous-dist'] });
    console.log(`Publicación preparada: URL única, ${result.preservedFiles} recursos en ${legacyDirectory}/ y ${result.preservedRootFiles} recursos operativos anteriores.`);
  } catch (error) {
    console.error(error.message);
    console.error('Uso: node scripts/prepare-release.mjs --legacy-dist <build-beta> [--previous-dist <build-anterior>] [--dist dist]');
    process.exitCode = 1;
  }
}
