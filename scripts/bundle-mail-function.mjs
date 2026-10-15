import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const result = await build({
  entryPoints: [resolve('supabase/functions/document-mail/index.ts')],
  bundle: true, write: false, platform: 'neutral', format: 'esm', target: 'es2022',
  external: ['npm:*'], loader: { '.png': 'dataurl' }, legalComments: 'none', minifySyntax: true,
  plugins: [{ name: 'pdf-runtime', setup(builder) {
    builder.onResolve({ filter: /^jspdf$/ }, () => ({ path: 'npm:jspdf@4.2.1', external: true }));
  } }],
});
await mkdir(resolve('tmp'), { recursive: true });
await writeFile(resolve('tmp/document-mail-dashboard.js'), result.outputFiles[0].text);
console.log('Función preparada: tmp/document-mail-dashboard.js');
