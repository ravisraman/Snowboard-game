import * as THREE from 'three';
import { Game } from './core/Game.js';

/**
 * Bootstrap: renderer, the frame loop, and window plumbing.
 */

const canvas = document.getElementById('scene');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  stencil: false,
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Snow blows out badly under a linear response; ACES keeps the highlights.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

const game = new Game(renderer);

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  game.resize(width, height);
}

window.addEventListener('resize', resize);
resize();

// Warm the shader cache before the first frame so the drop-in isn't a stutter.
renderer.compile(game.scene, game.camera);
game.hud.hideLoading();

let last = performance.now();

renderer.setAnimationLoop((now) => {
  const dt = (now - last) / 1000;
  last = now;
  game.update(dt);
  renderer.render(game.scene, game.camera);
});

// A tab switch shouldn't bank up a huge dt on return.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) last = performance.now();
});

if (import.meta.env?.DEV) {
  window.game = game; // handy for tuning from the console
}
