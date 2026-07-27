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
    shadowMapSize: 4096,
    shadowExtent: 96,
    softShadows: true,
    maxParticles: 4200,
    treeDensity: 1,
    farForest: true,
    // Metres between the coarse columns that carry the snowfields past the fog.
    skirtStep: 28,
    fogDensity: 0.0026,
    audio: true,
    trackSegments: 2600,
    // The post chain: multisampling, a high-threshold bloom and a grade.
    postprocess: true,
    msaaSamples: 4,
    bloom: true,
    grade: true,
    bloomStrength: 0.34,
    bloomThreshold: 0.92,
    // Resort furniture.
    chairlift: true,
    rocks: true,
    rockDensity: 1,
    clouds: true,
    spindrift: true,
    driftRate: 62,
    // Resolution of the mountain panorama's crestlines. It is drawn every
    // frame and never culled, so this is the one knob on it.
    panoramaDetail: 1,
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
    trackSegments: 1100,
    // A phone runs the chain too, but only the part that pays for itself: one
    // multisampled render target and the output pass. Bloom is three more
    // passes over every pixel on the hardware least able to afford them, and
    // the grade is a fourth.
    //
    // Skipping the chain entirely was the obvious call and the wrong one: the
    // sky writes its own fragments and is tone mapped only by `OutputPass`, so
    // a phone without the chain renders a visibly different sky from a desktop.
    // Multisampling is close to free on a tile-based GPU anyway.
    postprocess: true,
    msaaSamples: 4,
    bloom: false,
    grade: false,
    // The lift stays — it is most of what says "resort" — but the far-field
    // rocks thin out, since they are the detail least likely to be looked at.
    chairlift: true,
    rocks: true,
    rockDensity: 0.45,
    clouds: true,
    // Drift competes with the carve plume for the same, much smaller, particle
    // budget, so it thins out rather than disappearing.
    spindrift: true,
    driftRate: 24,
    panoramaDetail: 0.62,
  },
};

export function qualityFor(tier) {
  return { tier, ...TIERS[tier] };
}
