import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Every runner creates its own in-memory PostgreSQL and uses synthetic data.
// Execute sequentially to keep WASM memory usage bounded on small CI runners.
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = new URL('../supabase/tests/', import.meta.url);
const suites = (await readdir(directory)).filter(name => name.endsWith('-postgres.mjs')).sort();
if (!suites.length) throw new Error('No se encontraron las pruebas PostgreSQL.');

for (const suite of suites) {
  console.log(`PostgreSQL aislado: ${suite}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(suite, directory))], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve(signal ? 1 : status ?? 1));
  });
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
