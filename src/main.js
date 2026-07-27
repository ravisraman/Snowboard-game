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
