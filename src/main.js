import * as THREE from 'three';
import { Game } from './core/Game.js';
import { buildComposer } from './fx/Postprocess.js';
import { detectTier, qualityFor, isTouchDevice } from './core/Quality.js';

/**
 * Bootstrap: renderer, the frame loop, and window plumbing.
 */

const quality = qualityFor(detectTier());
if (isTouchDevice()) document.body.classList.add('is-touch');

const canvas = document.getElementById('scene');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  stencil: false,
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
renderer.shadowMap.enabled = quality.shadows;
renderer.shadowMap.type = quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Snow blows out badly under a linear response; ACES keeps the highlights.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Slightly under 1. The scene is a snowfield in direct sun — the top of the
// range is where all the detail is, and a touch of headroom keeps the piste
// from clipping to flat white the moment the sun catches it.
renderer.toneMappingExposure = 0.92;

const game = new Game(renderer, quality);

/**
 * Desktop renders through the post chain; a phone renders straight to the
 * canvas. Note that `renderer.toneMapping` stays set either way — three applies
 * it only when drawing to the default framebuffer, so the composer's
 * intermediate targets stay linear and `OutputPass` does the mapping exactly
 * once at the end.
 */
const post = quality.postprocess ? buildComposer(renderer, game.scene, game.camera, quality) : null;

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  post?.setSize(width, height);
  game.resize(width, height);
}

window.addEventListener('resize', resize);
// iOS fires orientationchange before the viewport has settled.
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
resize();

// Warm the shader cache before the first frame so the drop-in isn't a stutter.
renderer.compile(game.scene, game.camera);
game.hud.hideLoading();

let last = performance.now();

renderer.setAnimationLoop((now) => {
  const dt = (now - last) / 1000;
  last = now;
  game.update(dt);
  if (post) post.render();
  else renderer.render(game.scene, game.camera);
});

// A tab switch shouldn't bank up a huge dt on return.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) last = performance.now();
});

if (import.meta.env?.DEV) {
  window.game = game; // handy for tuning from the console
}

/**
 * Offline support for the hosted build.
 *
 * Registered only in production and only over http(s) — a service worker
 * cannot be registered from a `file://` page, and the single-file build is
 * already offline by construction, so there is nothing for it to do there.
 */
// The manifest link is the tell: the single-file build writes its own <head>
// and drops it, and that build has no sibling files to register against.
const hosted = !!document.querySelector('link[rel="manifest"]');

if (import.meta.env?.PROD && hosted && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // A worker that has just taken over from an older one is serving a build
  // this page did not come from, so the page has to be fetched again to match
  // it. Only on a *replacement*: the first install also fires this, and
  // reloading then would be a pointless flash on a first visit. The flag stops
  // any chance of a reload loop if the swap happens twice.
  //
  // `hadController` is read now, before registering: it is false on a first
  // visit — when taking control is expected and a reload would just be a flash
  // — and true only when a worker is being *replaced*, which is the case that
  // matters. `reloading` is a second belt against a loop.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', () => {
    // Relative to the document, not to this module — a project page is served
    // from a subdirectory and the bundle lives in `assets/` beneath it.
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      // Ask outright whether there is a newer worker, rather than waiting for
      // the browser's own schedule to get round to it.
      .then((reg) => reg.update())
      .catch(() => {
        /* offline support is a bonus, never a requirement */
      });
  });
}
