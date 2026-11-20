// Build frontend-v2 into frontend-v2/dist. Uses the esbuild already present in
// the project's devDependencies; no new packages are installed.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'assets'), { recursive: true });

await build({
  entryPoints: {
    admin: join(root, 'src/admin/main.js'),
    checkout: join(root, 'src/public/checkout.js'),
    deploy: join(root, 'src/public/deploy.js'),
    collect: join(root, 'src/public/collect.js'),
  },
  outdir: join(dist, 'assets'),
  bundle: true,
  loader: { '.svg': 'text' },
  format: 'iife',
  target: 'es2020',
  // Product builds are optimized and do not expose development sourcemaps.
  minify: true,
  sourcemap: false,
  legalComments: 'linked',
  logLevel: 'info',
});

for (const file of readdirSync(join(root, 'styles'))) cpSync(join(root, 'styles', file), join(dist, 'assets', file));
for (const file of readdirSync(join(root, 'pages'))) cpSync(join(root, 'pages', file), join(dist, file));
console.log('frontend-v2 built into ' + dist);
