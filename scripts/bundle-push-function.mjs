// Dashboard's inline editor cannot traverse repository-relative imports. This
// prepares the same reviewed implementation as one deployable TypeScript file.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

// Vite already provides esbuild. Bundle our source imports, preserve the pinned
// npm runtime dependencies, and compile the entry's TypeScript to plain JS.
const result = await build({
  entryPoints: [resolve('supabase/functions/send-push-reminders/index.ts')],
  bundle: true, write: false, platform: 'neutral', format: 'esm', target: 'es2022',
  external: ['npm:*'], legalComments: 'none', minifySyntax: true,
});
const bundled = result.outputFiles[0].text;
const directory = resolve('tmp');
await mkdir(directory, { recursive: true });
const path = resolve(directory, 'send-push-reminders-dashboard.js');
await writeFile(path, bundled, 'utf8');
console.log(`Dashboard deploy source: ${path}`);
