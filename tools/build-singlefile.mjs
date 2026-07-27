/**
 * Folds the Vite build into one self-contained HTML file.
 *
 * The game already loads nothing over the network — every mesh, texture and
 * shader is generated at runtime — so inlining the bundle and the stylesheet is
 * enough to make it work anywhere a file can be opened, including sandboxes
 * that block external requests entirely.
 *
 *   npm run build && npm run bundle    # -> dist/alpine-carve.html
 *
 * Pass --fragment to emit body content only, for hosts that supply their own
 * document shell.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const fragment = process.argv.includes('--fragment');

const assets = readdirSync(join(DIST, 'assets'));
const jsName = assets.find((f) => f.endsWith('.js'));
const cssName = assets.find((f) => f.endsWith('.css'));
if (!jsName || !cssName) throw new Error('No build found — run `npm run build` first.');

const css = readFileSync(join(DIST, 'assets', cssName), 'utf8');
// A literal </script> anywhere in the bundle — inside a shader string, say —
// would close the tag early and truncate the game.
const js = readFileSync(join(DIST, 'assets', jsName), 'utf8').replaceAll('</script', '<\\/script');
const html = readFileSync(join(DIST, 'index.html'), 'utf8');

const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/\s*<script[^>]*><\/script>/g, '')
  .trim();

const head = `<title>Alpine Carve — Downhill Snowboarding</title>
<style>
${css}
</style>`;

const scripted = `${body}

<script type="module">
${js}
</script>`;

const out = fragment
  ? `${head}\n\n${scripted}\n`
  : `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${head}
</head>
<body>
${scripted}
</body>
</html>
`;

const target = join(DIST, fragment ? 'alpine-carve.fragment.html' : 'alpine-carve.html');
writeFileSync(target, out);
console.log(`${target}  ${(out.length / 1024).toFixed(0)} kB`);
