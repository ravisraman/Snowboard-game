/**
 * Quality tiers.
 *
 * A phone is not a small desktop. The expensive things here are pixels first
 * (a modern handset renders at 3x device pixel ratio, which is nine times the
 * fragment work of 1x), then the shadow pass, then geometry — so the mobile
 * tier cuts in that order rather than uniformly.
 */

export function detectTier() {
  if (typeof window === 'undefined') return 'desktop';

  const params = new URLSearchParams(window.location.search);
  const forced = params.get('quality');
  if (forced === 'mobile' || forced === 'desktop') return forced;

  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  return coarse && shortSide < 900 ? 'mobile' : 'desktop';
}

export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  return (
    (window.matchMedia?.('(pointer: coarse)').matches ?? false) ||
    navigator.maxTouchPoints > 0
  );
}

const TIERS = {
  desktop: {
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 2048,
    shadowExtent: 68,
    softShadows: true,
    maxParticles: 4200,
    treeDensity: 1,
    farForest: true,
    // Metres between the coarse columns that carry the snowfields past the fog.
    skirtStep: 28,
    fogDensity: 0.0026,
    audio: true,
  },
  mobile: {
    // Capping the pixel ratio is by far the biggest single win, and on a phone
    // sized screen the difference is barely visible.
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    // A tighter shadow frustum keeps the smaller map's texel density usable.
    shadowExtent: 46,
    softShadows: false,
    maxParticles: 1600,
    treeDensity: 0.55,
    farForest: false,
    skirtStep: 70,
    // Slightly thicker air pulls the far draw in without showing an edge.
    fogDensity: 0.0034,
    audio: true,
  },
};

export function qualityFor(tier) {
  return { tier, ...TIERS[tier] };
}
