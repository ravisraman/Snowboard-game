/**
 * Bake a real mountain into a run preset.
 *
 * Walks a fall line down real elevation data and writes the result to
 * `src/world/Elevation.js` as two small tables — a steepness profile and a
 * lateral wander — which `Runs.js` hands to `Course` like any other numbers.
 *
 *     node tools/bake-run.mjs            # re-derive and rewrite the tables
 *     node tools/bake-run.mjs --dry      # print the profile, write nothing
 *
 * ---------------------------------------------------------------------------
 * Why only two tables
 * ---------------------------------------------------------------------------
 * The tempting version of "use real terrain" is to sample the DEM for ground
 * height directly. That would be a mistake here, for two reasons.
 *
 * The first is resolution. These tiles resolve about 30 m on the ground. The
 * groomed piste is 16 m wide. One elevation sample per two piste-widths cannot
 * describe a kicker, a mogul, a rail's landing or the fork's divider — every
 * feature the player actually touches would still have to be synthesised on
 * top of it, so the DEM can only ever supply the part of the mountain that is
 * *larger* than the game.
 *
 * The second is that `Course.terrainHeight(x, z)` is a pure analytic function,
 * and a great deal depends on that. Collision, the grooming mask, tree scatter,
 * the fork, the moguls and the tunnels all read it and all agree exactly
 * because they are all reading the same closed form. A sampled height field
 * becomes a second source of truth that has to be kept in step with the first.
 *
 * So the DEM contributes exactly the two things it is genuinely better at than
 * a hand-written sine sum, and both go in through doors that already exist:
 *
 *   - `grade.profile`  — how steep the mountain is at each point down the run.
 *     Feeds `_gradeAt`, which is integrated once at startup, so real steepness
 *     arrives as an ordinary term in the existing fall line.
 *   - `track.profile`  — how the fall line wanders left and right.
 *     Feeds `centerX`, alongside the sine waves rather than instead of them.
 *
 * Everything downhill of those two functions is untouched, which is why adding
 * a real mountain does not move a single one of Classic's digests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHeightGrid, lonLatToTile, sampleGrid, metresPerPixel } from './dem.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src', 'world', 'Elevation.js');

/* ------------------------------------------------------------------------
 * The mountain
 * ---------------------------------------------------------------------- */

/**
 * The Chamonix valley, under the Aiguilles Rouges and the Mont Blanc massif.
 *
 * Chosen for vertical: the block below spans a kilometre of valley floor to
 * over four thousand metres, so a three-kilometre descent is still descending
 * at the end of it. The first site tried had only four hundred metres of drop
 * above the valley and the walk simply ran out of mountain after 1300 m —
 * which is the whole reason `pickStart` below exists rather than a hand-picked
 * summit coordinate.
 *
 * `centre` only says which tiles to fetch. Where the run actually starts is
 * searched for, not specified.
 */
const SITE = {
  name: 'Chamonix–Argentière, Mont Blanc massif',
  centre: { lon: 6.945, lat: 45.975 },
  zoom: 13,
  // Odd, so the centre sits in the middle tile and the walk has the same room
  // in every direction — a real fall line does not know which way the block
  // was fetched.
  tiles: 5,
};

const RUN_LENGTH = 3000;   // metres of z the preset covers, matching the others
const STEP = 10;           // metres per walk step
const SAMPLE_STEP = 25;    // metres between baked samples

/**
 * What a good run looks like, for the search below.
 *
 * `targetGrade` is roughly where the existing three sit (0.17 to 0.21). The
 * bounds are not taste — they are the envelope the rest of the game was tuned
 * in, and a real mountain that falls outside it would need every other number
 * in the preset re-tuned to stay rideable.
 */
const WANT = {
  targetGrade: 0.19,
  minGrade: 0.10,      // below this the run has flat spots you have to skate
  maxGrade: 0.34,      // above this the rider is at terminal speed throughout
  maxWander: 150,      // metres off the chord before the run stops reading straight
};

/* ------------------------------------------------------------------------
 * Walking the fall line
 * ---------------------------------------------------------------------- */

/**
 * Separable Gaussian blur over the height grid.
 *
 * The walk needs this and the profile needs it for the same reason, at
 * different strengths: raw 30 m elevation has pits and gullies in it that a
 * steepest-descent walk falls into and never leaves, and that the game's own
 * `undulation` term is a better source of anyway. Blurring first leaves the
 * mountain and removes the noise.
 */
function blur(block, radiusM, lat) {
  const mpp = metresPerPixel(lat, block.zoom);
  const r = Math.max(1, Math.round(radiusM / mpp));
  const sigma = r / 2;
  const kernel = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const { width, height, grid } = block;
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += grid[y * width + clamp(x + i, width - 1)] * kernel[i + r];
      tmp[y * width + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += tmp[clamp(y + i, height - 1) * width + x] * kernel[i + r];
      out[y * width + x] = acc;
    }
  }
  return { ...block, grid: out };
}

/** Downhill unit vector in pixel space, from central differences. */
function downhill(block, px, py) {
  const d = 1.5;
  const gx = sampleGrid(block, px + d, py) - sampleGrid(block, px - d, py);
  const gy = sampleGrid(block, px, py + d) - sampleGrid(block, px, py - d);
  const len = Math.hypot(gx, gy);
  return len < 1e-6 ? { x: 0, y: 0 } : { x: -gx / len, y: -gy / len };
}

/**
 * Walk downhill from the summit, keeping some momentum.
 *
 * Pure steepest descent is not a ski line: it turns on the spot wherever two
 * slopes meet, and a piste does not. Carrying `MOMENTUM` of the previous
 * heading into each step is what makes the result a line someone could ride,
 * and it is also what stops the walk oscillating across the floor of a gully.
 */
function walk(block, startPx, startPy, lat) {
  const MOMENTUM = 0.86;
  const mpp = metresPerPixel(lat, block.zoom);
  const stepPx = STEP / mpp;

  let px = startPx;
  let py = startPy;
  let dir = downhill(block, px, py);
  const points = [{ px, py, h: sampleGrid(block, px, py), s: 0 }];

  for (let i = 0; i < 4000; i++) {
    const d = downhill(block, px, py);
    let nx = dir.x * MOMENTUM + d.x * (1 - MOMENTUM);
    let ny = dir.y * MOMENTUM + d.y * (1 - MOMENTUM);
    const len = Math.hypot(nx, ny);
    if (len < 1e-6) break;
    dir = { x: nx / len, y: ny / len };

    px += dir.x * stepPx;
    py += dir.y * stepPx;
    if (px < 2 || py < 2 || px > block.width - 3 || py > block.height - 3) break;

    const h = sampleGrid(block, px, py);
    points.push({ px, py, h, s: points[points.length - 1].s + STEP });
    if (points[points.length - 1].s > RUN_LENGTH * 1.6) break;
  }
  return points;
}

/* ------------------------------------------------------------------------
 * Turning a walk into game coordinates
 * ---------------------------------------------------------------------- */

/**
 * Project the walked line onto its own mean bearing.
 *
 * The game's axes are fixed: +z is downhill, +x is across. A real fall line has
 * no such axis, so one is chosen — the straight line from the first point to
 * the last — and the walk is resolved into distance along it (`z`) and offset
 * from it (`x`). That offset is precisely the "wander" the track config wants,
 * measured off a real mountain instead of invented.
 */
function toTrackSpace(points, mpp, axisEnd = points.length - 1) {
  const first = points[0];
  const last = points[axisEnd];
  const ax = (last.px - first.px) * mpp;
  const ay = (last.py - first.py) * mpp;
  const axis = Math.hypot(ax, ay);
  const ux = ax / axis;
  const uy = ay / axis;

  return points.map((p) => {
    const dx = (p.px - first.px) * mpp;
    const dy = (p.py - first.py) * mpp;
    return {
      z: dx * ux + dy * uy,
      // Sign chosen so that +x is the rider's right when facing downhill: the
      // axis normal is (-uy, ux) in pixel space, and pixel +y runs south.
      x: dx * -uy + dy * ux,
      h: p.h,
    };
  });
}

/** Resample an irregular {z, value} list onto an even grid, linearly. */
function resample(points, key, step, count) {
  const out = [];
  let i = 0;
  for (let k = 0; k < count; k++) {
    const z = k * step;
    while (i < points.length - 2 && points[i + 1].z < z) i++;
    const a = points[i];
    const b = points[i + 1] ?? a;
    const span = b.z - a.z;
    const f = span > 1e-6 ? Math.min(Math.max((z - a.z) / span, 0), 1) : 0;
    out.push(a[key] + (b[key] - a[key]) * f);
  }
  return out;
}

/**
 * Turn one walk into a candidate run, or reject it.
 *
 * The axis a walk is measured against is the chord between its endpoints, so
 * *which* endpoint matters: fit it over the whole walk and a line that reaches
 * the valley and then meanders along the floor gets an axis pointing down the
 * valley, against which the actual descent reads as sideways travel. Hence the
 * growing trim — take the shortest prefix of the path whose chord still spans
 * the full run, and measure against that.
 */
function evaluate(points, mpp) {
  for (let trim = 1.05; trim <= 1.8; trim += 0.05) {
    const end = Math.min(points.length - 1, Math.round((RUN_LENGTH * trim) / STEP));
    if (end < 10) break;
    const track = toTrackSpace(points, mpp, end).slice(0, end + 1);

    // A doubled-back line makes z non-monotonic and the resample meaningless.
    // Requiring real forward progress, not merely non-negative, also throws out
    // lines that stall in a hollow and inflate their reach a centimetre a step.
    let ok = true;
    for (let i = 1; i < track.length; i++) {
      if (track[i].z - track[i - 1].z < STEP * 0.15) { ok = false; break; }
    }
    if (!ok) continue;
    if (track[track.length - 1].z < RUN_LENGTH) continue;

    const count = Math.floor(RUN_LENGTH / SAMPLE_STEP) + 1;
    const heights = resample(track, 'h', SAMPLE_STEP, count);
    const wander = resample(track, 'x', SAMPLE_STEP, count);
    const mean = wander.reduce((a, b) => a + b, 0) / count;
    const wanderCentred = wander.map((v) => v - mean);

    const grades = heights.map((_, i) => {
      const lo = Math.max(0, i - 1);
      const hi = Math.min(count - 1, i + 1);
      return (heights[lo] - heights[hi]) / ((hi - lo) * SAMPLE_STEP);
    });

    const meanGrade = (heights[0] - heights[count - 1]) / RUN_LENGTH;
    const maxWander = Math.max(...wanderCentred.map(Math.abs));
    if (meanGrade < WANT.minGrade || meanGrade > WANT.maxGrade) continue;
    if (maxWander > WANT.maxWander) continue;

    /*
     * The score. Two terms, and the second is the one that matters.
     *
     * Being close to the target grade on *average* is easy — a run that is
     * vertical for a kilometre and flat for two averages out fine and is no
     * fun at all. So the dominant term penalises each individual sample that
     * strays outside the band, which is what selects for a descent that keeps
     * going rather than one that front-loads its drop.
     */
    let bad = 0;
    for (const g of grades) {
      if (g < WANT.minGrade) bad += WANT.minGrade - g;
      else if (g > WANT.maxGrade) bad += g - WANT.maxGrade;
    }
    const score = bad / count * 20 + Math.abs(meanGrade - WANT.targetGrade);

    return { score, track, heights, grades, wander: wanderCentred, count, meanGrade, maxWander, trim };
  }
  return null;
}

/* ------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------- */

const { lon, lat } = SITE.centre;
const t = lonLatToTile(lon, lat, SITE.zoom);
const half = (SITE.tiles - 1) / 2;
const raw = await fetchHeightGrid({
  zoom: SITE.zoom,
  // `floor` of the tile the point is in, not `round` of the point: rounding a
  // coordinate whose fraction happens to be small shifts the whole block by a
  // tile and leaves the start pinned against a corner.
  minTx: Math.floor(t.x) - half,
  minTy: Math.floor(t.y) - half,
  tilesX: SITE.tiles,
  tilesY: SITE.tiles,
});
const mpp = metresPerPixel(lat, SITE.zoom);

// Two blurs, because the walk and the profile want different things. The walk
// wants a mountain with no gullies to fall into; the profile wants to keep the
// rolls that make the descent interesting.
const forWalk = blur(raw, 220, lat);
const forProfile = blur(raw, 90, lat);

/*
 * Search the block for the best three kilometres on it.
 *
 * Every point on a coarse grid is tried as a start, walked, and scored. This
 * replaced a hand-picked summit coordinate, and not for elegance: the picked
 * summit turned out to have only four hundred metres of mountain under it, so
 * the walk hit the valley floor at 1300 m and spent the rest of its length
 * wandering along the flat. Searching finds the shoulder that actually has
 * three kilometres of consistent fall line below it, which is a thing about
 * the terrain that no amount of confidence about place names can supply.
 *
 * A few thousand walks at ~300 steps each is a second or two, once, offline.
 */
const strideM = 120;
const stride = strideM / mpp;
const margin = 4;
let best = null;
let tried = 0;
let reached = 0;

for (let py = margin; py < raw.height - margin; py += stride) {
  for (let px = margin; px < raw.width - margin; px += stride) {
    tried++;
    const walked = walk(forWalk, px, py, lat);
    if (walked.length < 100) continue;
    // Heights come from the lighter blur: the walk decides *where* the line
    // goes, the sharper grid decides how steep it is along the way.
    for (const p of walked) p.h = sampleGrid(forProfile, p.px, p.py);
    const cand = evaluate(walked, mpp);
    if (!cand) continue;
    reached++;
    if (!best || cand.score < best.score) best = { ...cand, px, py, summit: walked[0].h };
  }
}

if (!best) throw new Error(`no usable ${RUN_LENGTH} m descent in the block (${tried} starts tried)`);

const { heights, grades, count, meanGrade, maxWander, summit } = best;
const wanderCentred = best.wander;
const drop = heights[0] - heights[count - 1];
const maxGrade = Math.max(...grades);
const minGrade = Math.min(...grades);

if (process.argv.includes('--trace')) {
  for (let i = 0; i < best.track.length; i += 10) {
    const p = best.track[i];
    console.log(`z=${p.z.toFixed(0).padStart(5)}  x=${p.x.toFixed(0).padStart(5)}  h=${p.h.toFixed(0)}`);
  }
  process.exit(0);
}

console.log(`site        ${SITE.name}`);
console.log(`starts      ${tried} tried, ${reached} spanned ${RUN_LENGTH} m, best score ${best.score.toFixed(4)}`);
console.log(`summit      ${summit.toFixed(0)} m`);
console.log(`resolution  ${mpp.toFixed(1)} m/px at zoom ${SITE.zoom}`);
console.log(`drop        ${drop.toFixed(0)} m over ${RUN_LENGTH} m`);
console.log(`grade       mean ${meanGrade.toFixed(3)}, ${minGrade.toFixed(3)} .. ${maxGrade.toFixed(3)}`);
console.log(`wander      +/- ${maxWander.toFixed(0)} m`);
console.log('');
for (let i = 0; i < count; i += 8) {
  const z = i * SAMPLE_STEP;
  const bar = '#'.repeat(Math.round(grades[i] * 120));
  console.log(`${String(z).padStart(4)}m  ${heights[i].toFixed(0).padStart(4)}m  ${grades[i].toFixed(3)}  ${bar}`);
}

if (process.argv.includes('--dry')) process.exit(0);

const fmt = (arr, dp) => {
  const lines = [];
  for (let i = 0; i < arr.length; i += 10) {
    lines.push('  ' + arr.slice(i, i + 10).map((v) => v.toFixed(dp)).join(', ') + ',');
  }
  return lines.join('\n');
};

fs.writeFileSync(OUT, `/**
 * A real mountain, as two tables.
 *
 * GENERATED BY \`node tools/bake-run.mjs\` — edit that, not this.
 *
 * Sampled from ${SITE.name} via the public AWS terrarium elevation tiles at
 * zoom ${SITE.zoom} (about ${mpp.toFixed(0)} m per pixel on the ground). A steepest-descent
 * walk from the ${summit.toFixed(0)} m summit was projected onto the chord between its
 * endpoints, giving distance downhill and offset across — the game's own z and
 * x. The descent drops ${drop.toFixed(0)} m over ${RUN_LENGTH} m, a mean grade of ${meanGrade.toFixed(3)}.
 *
 * These are the only two things taken from the real world, and both are
 * low-frequency by necessity: 30 m elevation postings cannot describe a 16 m
 * piste, let alone a kicker on it. Everything the rider actually touches is
 * still the analytic height field in \`Course.js\`. See the header of
 * \`tools/bake-run.mjs\` for the full reasoning.
 *
 * Samples are every ${SAMPLE_STEP} m of z, starting at z = 0.
 */

/** Metres between consecutive samples in both tables below. */
export const ELEVATION_STEP = ${SAMPLE_STEP};

/**
 * Steepness down the fall line — metres of drop per metre of z, the same units
 * as \`grade.base\`. Range ${minGrade.toFixed(3)} to ${maxGrade.toFixed(3)}.
 */
export const ELEVATION_GRADE = [
${fmt(grades, 4)}
];

/**
 * How far the real fall line sits left or right of the straight chord, in
 * metres. Mean removed, so the run stays centred on x = 0 like every other
 * preset. Reaches ${maxWander.toFixed(0)} m off the chord at its widest.
 */
export const ELEVATION_WANDER = [
${fmt(wanderCentred, 2)}
];
`);

console.log(`\nwrote ${path.relative(path.join(HERE, '..'), OUT)} — ${count} samples`);
