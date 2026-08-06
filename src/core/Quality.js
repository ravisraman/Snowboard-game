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
    shafts: 0.34,
    bloomStrength: 0.34,
    bloomThreshold: 0.92,
    /*
     * Screen-space ambient occlusion.
     *
     * The most valuable single thing in this chain on a scene made of white
     * shapes against white ground: it is what turns a flat-shaded low-poly
     * figure into something with volume, and what separates a tree from the
     * snow it is standing in. See the note in `fx/Postprocess.js` for why it
     * took a second algorithm to get one that survives a nine-kilometre view.
     */
    ao: true,
    aoQuality: 'Medium',
    aoIntensity: 3.4,
    aoRadius: 1.9,
    aoHalfRes: false,
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
    /*
     * No occlusion pass on a phone.
     *
     * It is a full-screen pass with a multi-sample hemisphere kernel and a
     * denoise, which is exactly the shape of work a mobile GPU is worst at —
     * and the tier already gives up bloom and the grade for the same reason.
     * The baked contact shading in the terrain stays on every tier, so a phone
     * still gets shade pooled around every trunk and post; what it loses is the
     * occlusion on the rider and between moving things.
     */
    ao: false,
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
  const q = { tier, ...TIERS[tier] };

  /*
   * Per-setting overrides from the query string, for looking at one thing at a
   * time: `?ao=0` turns the occlusion pass off, `?ao=1` forces it on.
   *
   * This exists because the honest way to judge a rendering change is a pair of
   * otherwise identical frames, and rebuilding the composer by hand between two
   * screenshots is a good way to end up comparing two different scenes.
   */
  if (typeof window !== 'undefined') {
    const p = new URLSearchParams(window.location.search);
    if (p.has('ao')) q.ao = p.get('ao') !== '0';
    if (p.has('aoIntensity')) q.aoIntensity = Number(p.get('aoIntensity'));
    if (p.has('aoRadius')) q.aoRadius = Number(p.get('aoRadius'));
  }
  return q;
}
