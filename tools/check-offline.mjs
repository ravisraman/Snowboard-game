/**
 * Does a deploy reach somebody who has been here before?
 *
 * This exists because the answer was once no, and nothing caught it. The
 * service worker precached `index.html` and served it cache-first, so a
 * returning visitor got the HTML from whichever build they saw first — which
 * names content-hashed assets that the next deploy deletes. They were pinned
 * to an old build, and once the browser's own HTTP cache let go of the file,
 * the page came up blank. The site was broken for exactly the people who had
 * played it before, which is the worst possible group to break it for.
 *
 * The test is the failure, reproduced:
 *
 *   1. Serve `dist/`, load it, let the worker install and cache the shell.
 *   2. Rename the hashed asset and repoint `index.html` at the new name —
 *      which is precisely what a deploy does: new names, old ones gone.
 *   3. Load again. The page must come up on the *new* asset, with nothing
 *      404ing.
 *
 * Step 2 is a rename rather than a rebuild so the whole thing takes a couple
 * of seconds and needs no source file touched.
 *
 *   npm run build
 *   node tools/check-offline.mjs
 *
 * Set CHROMIUM_PATH if Playwright's bundled browser isn't installed.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const DIST = new URL('../dist/', import.meta.url).pathname;
const PORT = 4199;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

/**
 * A static server with *no* caching headers.
 *
 * Deliberately not `vite preview`, which serves `/assets` as immutable for a
 * year: the browser's own HTTP cache would then answer for a file the server
 * no longer has, and the test would pass while the bug was still there.
 */
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = path === '/' ? 'index.html' : path.slice(1);
  try {
    const body = await readFile(join(DIST, file));
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

await new Promise((r) => server.listen(PORT, r));

const profile = await mkdtemp(join(tmpdir(), 'alpine-sw-'));
const launch = {
  viewport: { width: 800, height: 500 },
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;

/** One visit. Returns which script the page ended up on, and any failures. */
async function visit(ctx, { settle = 4000 } = {}) {
  const page = await ctx.newPage();
  const broken = [];
  page.on('response', (r) => { if (r.status() >= 400) broken.push(`${r.status()} ${r.url().split('/').pop()}`); });
  page.on('pageerror', (e) => broken.push(`error: ${e.message}`));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(settle);
  const out = await page.evaluate(async () => ({
    script: [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'))[0] ?? null,
    caches: await caches.keys(),
    // The title screen is in the served HTML, so it proves nothing on its own;
    // a sized canvas means the bundle actually ran.
    booted: (document.getElementById('scene')?.width ?? 0) > 0,
  }));
  await page.close();
  return { ...out, broken };
}

const results = [];
const say = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

let ctx = await chromium.launchPersistentContext(profile, launch);
const first = await visit(ctx);
say('the site loads, and installs a worker', first.booted && first.caches.length === 1,
  `${first.script}, cache ${first.caches.join()}`);
say('nothing fails on a first visit', first.broken.length === 0, first.broken.join('; ') || 'clean');
await ctx.close();

/* ---- Deploy: new hashed names, old ones gone ---- */
const assets = await readdir(join(DIST, 'assets'));
const oldJs = assets.find((f) => f.endsWith('.js'));
const newJs = oldJs.replace(/-(\w+)\.js$/, '-deploy2ed.js');
await rename(join(DIST, 'assets', oldJs), join(DIST, 'assets', newJs));
const html = await readFile(join(DIST, 'index.html'), 'utf8');
await writeFile(join(DIST, 'index.html'), html.replaceAll(oldJs, newJs));

ctx = await chromium.launchPersistentContext(profile, launch);
const second = await visit(ctx);
say('a returning visitor gets the new build, not the cached one',
  second.script?.includes(newJs), `served ${second.script}`);
say('and nothing 404s on the way', second.broken.length === 0, second.broken.join('; ') || 'clean');
say('the game still boots', second.booted, second.booted ? 'canvas is up' : 'blank page');
await ctx.close();

/* ---- Put the folder back the way it was ---- */
await rename(join(DIST, 'assets', newJs), join(DIST, 'assets', oldJs));
await writeFile(join(DIST, 'index.html'), html);
await rm(profile, { recursive: true, force: true });
server.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
