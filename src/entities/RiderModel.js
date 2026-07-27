import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The snowboarder: model and rig.
 *
 * Split out of `Rider.js`, which owns the physics and the posing. What lives
 * here is the shape of the thing and the joints it bends at.
 *
 * Two decisions shape all of it.
 *
 * **The limbs are round and the scenery is faceted.** The mountain is
 * deliberately flat-shaded low-poly; the rider is the one object the camera is
 * always looking at, so it gets smooth-shaded tapered limbs and eight-sided
 * joints. Reading as the hero against a faceted world is the point, not an
 * inconsistency.
 *
 * **The legs are solved, not posed.** The boots are bolted to the board, so
 * every crouch has to come out of the knees — if the body simply slides down,
 * as it used to, the feet sink through the deck. A two-bone IK solve per leg
 * pins the boots to the bindings and lets the knees do the absorbing, which is
 * most of what makes the model read as a snowboarder rather than a puppet on a
 * plank.
 */

/* ------------------------------------------------------------------
 * Proportions
 * ---------------------------------------------------------------- */

export const RIG = {
  boardTop: 0.11,        // where the bindings sit, in tilt space
  hipHeight: 0.68,       // hip height standing tall, above the board top
  thigh: 0.3,
  shin: 0.29,
  upperArm: 0.25,
  forearm: 0.24,
  frontBindingZ: 0.32,
  backBindingZ: -0.3,
  stanceX: 0.02,         // feet not quite on the centre line
};

const MAT = {
  jacket: new THREE.MeshStandardMaterial({ color: '#f4762a', roughness: 0.68 }),
  jacketDark: new THREE.MeshStandardMaterial({ color: '#cf5417', roughness: 0.72 }),
  jacketTrim: new THREE.MeshStandardMaterial({ color: '#23303f', roughness: 0.6 }),
  pants: new THREE.MeshStandardMaterial({ color: '#31589c', roughness: 0.82 }),
  pantsDark: new THREE.MeshStandardMaterial({ color: '#26457c', roughness: 0.84 }),
  boots: new THREE.MeshStandardMaterial({ color: '#1b2028', roughness: 0.62 }),
  strap: new THREE.MeshStandardMaterial({ color: '#39414d', roughness: 0.75 }),
  skin: new THREE.MeshStandardMaterial({ color: '#e8b48c', roughness: 0.75 }),
  beanie: new THREE.MeshStandardMaterial({ color: '#f2b431', roughness: 0.88 }),
  beanieBand: new THREE.MeshStandardMaterial({ color: '#e2762a', roughness: 0.88 }),
  goggleFrame: new THREE.MeshStandardMaterial({ color: '#20262f', roughness: 0.5 }),
  goggleLens: new THREE.MeshStandardMaterial({
    color: '#8fdcf4', roughness: 0.08, metalness: 0.85,
    emissive: '#14384a', emissiveIntensity: 0.3,
  }),
  deck: new THREE.MeshStandardMaterial({ color: '#242a33', roughness: 0.42, flatShading: true }),
  deckArt: new THREE.MeshStandardMaterial({ color: '#f4762a', roughness: 0.4, flatShading: true }),
  base: new THREE.MeshStandardMaterial({ color: '#e9f1f8', roughness: 0.16, metalness: 0.2, flatShading: true }),
  edge: new THREE.MeshStandardMaterial({ color: '#c9d4de', roughness: 0.18, metalness: 0.95 }),
};

/**
 * The parts that are actually metal, and so are the only ones with anything to
 * reflect: the board's base and steel edge, and the goggle lens.
 */
export const REFLECTIVE_MATERIALS = [MAT.base, MAT.edge, MAT.goggleLens];

/* ------------------------------------------------------------------
 * Primitives
 * ---------------------------------------------------------------- */

/**
 * Adds a shape to a group's pending pile rather than as its own mesh.
 *
 * A rider assembled as one mesh per box is forty-odd draw calls for a single
 * character — more than the entire forest. Anything rigid with respect to its
 * parent can be baked into that parent's geometry instead, so each group ends
 * up with one mesh per material, and only the parts that actually move
 * separately stay separate.
 */
function mesh(geo, mat, parent, x = 0, y = 0, z = 0) {
  // Uniformly de-indexed and stripped of UVs, because `mergeGeometries` refuses
  // to mix indexed with non-indexed or to merge geometries whose attribute sets
  // disagree — and nothing here is textured.
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  if (x || y || z) g.translate(x, y, z);
  if (!parent.userData.pending) parent.userData.pending = [];
  parent.userData.pending.push({ geo: g, mat });
  return g;
}

/** Bakes everything piled onto a group into one mesh per material. */
function bake(group) {
  const pending = group.userData.pending;
  if (pending) {
    const byMaterial = new Map();
    for (const { geo, mat } of pending) {
      if (!byMaterial.has(mat)) byMaterial.set(mat, []);
      byMaterial.get(mat).push(geo);
    }
    for (const [mat, geos] of byMaterial) {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      const m = new THREE.Mesh(merged, mat);
      m.castShadow = true;
      group.add(m);
    }
    delete group.userData.pending;
  }
  for (const child of group.children) if (child.isGroup) bake(child);
  return group;
}

/**
 * A tapered limb segment, hanging *down* from the origin so a joint rotation
 * swings it the way a real limb swings. Smooth-shaded, and only eight-sided:
 * enough to lose the corners at chase-camera distance, cheap enough not to
 * think about.
 */
function limb(parent, mat, { top, bottom, length, x = 0, z = 0, sides = 8 }) {
  const geo = new THREE.CylinderGeometry(top, bottom, length, sides, 1, true);
  geo.translate(0, -length * 0.5, 0);
  mesh(geo, mat, parent, x, 0, z);
  // Caps, which also serve as the joint balls — a limb that ends in a flat
  // disc reads as a piece of pipe.
  mesh(new THREE.SphereGeometry(top, sides, 4), mat, parent, x, 0, z);
  mesh(new THREE.SphereGeometry(bottom, sides, 4), mat, parent, x, -length, z);
}

/** A box with its corners knocked off — the torso, the mittens, the boots. */
function roundedBox(w, h, d, radius, segments = 2) {
  // Three has no rounded box, and a lathe cannot do a box. Scaling a
  // subdivided sphere into the corners of a box is the cheapest thing that
  // gives the silhouette a bit of softness.
  const geo = new THREE.BoxGeometry(w, h, d, segments, segments, segments);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const half = new THREE.Vector3(w * 0.5 - radius, h * 0.5 - radius, d * 0.5 - radius);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Push each vertex onto the surface of the rounded shape: clamp to the
    // inner box, then step out along the direction to the original point.
    const inner = new THREE.Vector3(
      THREE.MathUtils.clamp(v.x, -half.x, half.x),
      THREE.MathUtils.clamp(v.y, -half.y, half.y),
      THREE.MathUtils.clamp(v.z, -half.z, half.z)
    );
    const out = v.clone().sub(inner);
    if (out.lengthSq() > 1e-8) out.setLength(radius);
    pos.setXYZ(i, inner.x + out.x, inner.y + out.y, inner.z + out.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------
 * The board
 * ---------------------------------------------------------------- */

/**
 * A lofted deck with sidecut at the waist and kicked tips, built from a strip
 * of quads so it keeps the faceted look of the scenery.
 */
function buildBoardGeometry(inset = 0, thickness = 0.035) {
  const N = 18;
  const length = 1.62;
  const top = [];
  const bottom = [];

  for (let i = 0; i <= N; i++) {
    const s = (i / N) * 2 - 1;
    const z = (s * length) / 2;
    // Rounded nose and tail, waist narrower than the tips.
    const round = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(s), 8)));
    const w = Math.max(0.001, 0.166 * round * (1 - 0.17 * (1 - s * s)) - inset);
    const kick = 0.085 * Math.pow(Math.abs(s), 6);
    top.push([-w, kick + thickness, z], [w, kick + thickness, z]);
    bottom.push([-w, kick, z], [w, kick, z]);
  }

  const pos = [];
  const push = (a, b, c) => pos.push(...a, ...b, ...c);
  const quad = (a, b, c, d) => { push(a, b, c); push(a, c, d); };

  for (let i = 0; i < N; i++) {
    const t0 = top[i * 2], t1 = top[i * 2 + 1];
    const t2 = top[i * 2 + 2], t3 = top[i * 2 + 3];
    const b0 = bottom[i * 2], b1 = bottom[i * 2 + 1];
    const b2 = bottom[i * 2 + 2], b3 = bottom[i * 2 + 3];
    quad(t0, t2, t3, t1);   // deck
    quad(b0, b1, b3, b2);   // base
    quad(t0, t1, b1, b0);   // (degenerate at the tips, harmless)
    quad(t0, b0, b2, t2);   // left edge
    quad(t1, t3, b3, b1);   // right edge
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.translate(0, -thickness * 0.5, 0);
  return geo;
}

/** One binding: a baseplate, a highback, and two ratchet straps. */
function buildBinding(parent, z) {
  const g = new THREE.Group();
  g.position.set(RIG.stanceX, 0.075, z);
  // Turned across the board, the way a stance actually is.
  g.rotation.y = z > 0 ? -0.28 : 0.24;
  parent.add(g);

  mesh(roundedBox(0.28, 0.035, 0.34, 0.012), MAT.strap, g, 0, 0, 0);
  // Highback, leaning back off the heel edge. Rotated as geometry rather than
  // as a node, so it can be baked into the binding's single mesh.
  const highback = roundedBox(0.24, 0.2, 0.04, 0.015);
  highback.rotateX(0.22);
  mesh(highback, MAT.boots, g, 0, 0.1, -0.14);
  mesh(roundedBox(0.25, 0.045, 0.11, 0.02), MAT.strap, g, 0, 0.13, 0.02);   // ankle strap
  mesh(roundedBox(0.22, 0.04, 0.08, 0.018), MAT.strap, g, 0, 0.06, 0.13);   // toe strap
  return g;
}

function buildBoard(parent) {
  const board = new THREE.Group();
  parent.add(board);

  mesh(buildBoardGeometry(), MAT.deck, board, 0, 0.035, 0);
  // A bright base peeking out reads as the edge catching light mid-carve, and
  // the steel edge inside it is what the environment map has to work with.
  const base = buildBoardGeometry(0.004);
  base.scale(1, 0.5, 1);
  mesh(base, MAT.base, board, 0, 0.028, 0);
  const edge = buildBoardGeometry(0.001, 0.012);
  edge.scale(1.004, 1, 1.002);
  mesh(edge, MAT.edge, board, 0, 0.03, 0);

  // Top-sheet graphic: the board is seen almost edge-on from the chase camera,
  // and this is what keeps it from vanishing under the boots.
  mesh(roundedBox(0.085, 0.014, 1.3, 0.006), MAT.deckArt, board, 0, 0.056, 0);
  mesh(roundedBox(0.04, 0.014, 0.5, 0.006), MAT.jacketDark, board, 0.05, 0.056, 0.1);
  // Stomp pad between the bindings.
  mesh(roundedBox(0.12, 0.012, 0.1, 0.005), MAT.strap, board, 0.02, 0.056, 0.02);

  buildBinding(board, RIG.frontBindingZ);
  buildBinding(board, RIG.backBindingZ);
  return board;
}

/* ------------------------------------------------------------------
 * Limbs
 * ---------------------------------------------------------------- */

/**
 * A two-segment limb: a root that rotates at the shoulder or hip, and a joint
 * group partway down that rotates at the elbow or knee.
 */
function buildLimb(parent, { x, y, z, upper, lower, rTop, rMid, rBot, mat, matLower }) {
  const root = new THREE.Group();
  root.position.set(x, y, z);
  parent.add(root);

  limb(root, mat, { top: rTop, bottom: rMid, length: upper });

  const joint = new THREE.Group();
  joint.position.y = -upper;
  root.add(joint);

  limb(joint, matLower ?? mat, { top: rMid, bottom: rBot, length: lower });

  const end = new THREE.Group();
  end.position.y = -lower;
  joint.add(end);

  return { root, joint, end };
}

/**
 * Two-bone IK, solved in the limb's own bend plane.
 *
 * Given where the hand or foot has to be, this works out the two angles that
 * put it there: the law of cosines gives the joint angle, and the angle to the
 * target gives the rest. Everything is in the Y-Z plane because that is the
 * plane a knee and an elbow bend in — a snowboarder's knees track along the
 * board, not out to the side.
 *
 * `bend` picks which of the two mirror solutions to use: which way the knee
 * points.
 */
export function solveTwoBone(limbParts, targetY, targetZ, upper, lower, bend = 1) {
  // The caller may have swung the whole limb about Y to face the target; the
  // solve below is purely in the resulting bend plane.
  const reach = Math.hypot(targetY, targetZ);
  // Never fully straight: a locked-out limb snaps between solutions as the
  // target crosses the singularity, and it reads as a twitch.
  const d = THREE.MathUtils.clamp(reach, Math.abs(upper - lower) + 0.02, upper + lower - 0.015);

  // Direction from the joint root to the target, measured from straight down.
  const dir = Math.atan2(-targetZ, -targetY);
  const alpha = Math.acos(
    THREE.MathUtils.clamp((upper * upper + d * d - lower * lower) / (2 * upper * d), -1, 1)
  );
  const gamma = Math.acos(
    THREE.MathUtils.clamp((upper * upper + lower * lower - d * d) / (2 * upper * lower), -1, 1)
  );

  limbParts.root.rotation.x = dir + bend * alpha;
  limbParts.joint.rotation.x = -bend * (Math.PI - gamma);
}

/* ------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------- */

export function buildRiderModel() {
  const root = new THREE.Group();
  root.name = 'rider';

  const tilt = new THREE.Group();      // edge angle + slope alignment
  root.add(tilt);

  const board = buildBoard(tilt);

  const body = new THREE.Group();      // everything above the board
  body.position.y = RIG.boardTop + RIG.hipHeight;
  tilt.add(body);

  /* ---- Legs: hips on the board's centre line, boots at the bindings ---- */
  const hips = new THREE.Group();
  body.add(hips);
  mesh(roundedBox(0.3, 0.22, 0.42, 0.07), MAT.pantsDark, hips, 0, -0.02, 0);

  const legFront = buildLimb(hips, {
    x: RIG.stanceX, y: -0.06, z: 0.14,
    upper: RIG.thigh, lower: RIG.shin,
    rTop: 0.105, rMid: 0.075, rBot: 0.062,
    mat: MAT.pants,
  });
  const legBack = buildLimb(hips, {
    x: RIG.stanceX, y: -0.06, z: -0.13,
    upper: RIG.thigh, lower: RIG.shin,
    rTop: 0.105, rMid: 0.075, rBot: 0.062,
    mat: MAT.pants,
  });

  // Boots. They hang off the end of each leg and get counter-rotated in the
  // animation so they stay flat on the board however the knee is bent.
  for (const leg of [legFront, legBack]) {
    const boot = new THREE.Group();
    leg.end.add(boot);
    mesh(roundedBox(0.16, 0.14, 0.26, 0.05), MAT.boots, boot, 0, -0.04, 0.01);
    mesh(roundedBox(0.15, 0.1, 0.13, 0.04), MAT.boots, boot, 0, 0.04, -0.02);
    leg.boot = boot;
  }

  /* ---- Torso, turned across the board the way a rider stands ---- */
  const torso = new THREE.Group();
  torso.position.y = 0.06;
  torso.rotation.y = Math.PI * 0.5;
  body.add(torso);

  // Tapered from waist to shoulder, with a hem and a collar. A single box for
  // the whole torso reads as a carton at chase-camera distance — but the taper
  // has to be *shallow* front-to-back as well, or it reads as a barrel. The X
  // axis here is shoulder width, running along the board: a snowboarder stands
  // sideways, so the shoulders line up with the deck.
  mesh(roundedBox(0.4, 0.12, 0.3, 0.055), MAT.jacketDark, torso, 0, 0.05, 0);    // hem
  mesh(roundedBox(0.37, 0.24, 0.27, 0.075), MAT.jacket, torso, 0, 0.2, 0);       // waist
  mesh(roundedBox(0.44, 0.26, 0.3, 0.09), MAT.jacket, torso, 0, 0.42, 0);        // chest
  mesh(roundedBox(0.27, 0.09, 0.24, 0.045), MAT.jacketTrim, torso, 0, 0.55, 0);  // collar
  mesh(roundedBox(0.045, 0.3, 0.025, 0.011), MAT.jacketTrim, torso, 0, 0.3, 0.15); // zip

  // Negative X is the nose end of the board — see the note on the torso's
  // orientation above — so the *front* arm, the one nearer the nose and the one
  // that takes most of the grabs, hangs on that side.
  const armFront = buildLimb(torso, {
    x: -0.235, y: 0.49, z: 0.01,
    upper: RIG.upperArm, lower: RIG.forearm,
    rTop: 0.072, rMid: 0.054, rBot: 0.045,
    mat: MAT.jacket, matLower: MAT.jacketDark,
  });
  const armBack = buildLimb(torso, {
    x: 0.235, y: 0.49, z: 0.01,
    upper: RIG.upperArm, lower: RIG.forearm,
    rTop: 0.072, rMid: 0.054, rBot: 0.045,
    mat: MAT.jacket, matLower: MAT.jacketDark,
  });

  // Mittens, with a thumb — the silhouette that says "hand" at a distance.
  for (const [arm, side] of [[armFront, 1], [armBack, -1]]) {
    const hand = new THREE.Group();
    arm.end.add(hand);
    mesh(roundedBox(0.1, 0.13, 0.12, 0.045), MAT.jacketTrim, hand, 0, -0.05, 0);
    mesh(roundedBox(0.05, 0.07, 0.06, 0.022), MAT.jacketTrim, hand, side * 0.05, -0.03, 0.03);
    arm.hand = hand;
  }

  /* ---- Head ---- */
  const neck = new THREE.Group();
  neck.position.set(0, 0.57, 0.005);
  torso.add(neck);

  const head = new THREE.Group();
  neck.add(head);
  mesh(roundedBox(0.2, 0.22, 0.21, 0.075), MAT.skin, head, 0, 0.13, 0);
  // A knitted beanie with a turned-up brim and a bobble — the one spot of warm
  // colour up there, and it reads from a long way off.
  mesh(new THREE.SphereGeometry(0.132, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.62), MAT.beanie, head, 0, 0.185, 0);
  mesh(new THREE.CylinderGeometry(0.136, 0.139, 0.06, 12), MAT.beanieBand, head, 0, 0.155, 0);
  mesh(new THREE.SphereGeometry(0.045, 8, 6), MAT.beanie, head, 0, 0.29, 0);
  // Goggles: a lens, a frame around it, and a strap that carries on round.
  mesh(roundedBox(0.2, 0.082, 0.05, 0.026), MAT.goggleFrame, head, 0, 0.115, 0.085);
  mesh(roundedBox(0.175, 0.06, 0.03, 0.015), MAT.goggleLens, head, 0, 0.115, 0.103);
  mesh(new THREE.CylinderGeometry(0.128, 0.128, 0.055, 12, 1, true), MAT.goggleFrame, head, 0, 0.115, 0);

  // One mesh per material per moving part, instead of one per box.
  bake(root);
  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  return { root, tilt, board, body, hips, torso, armFront, armBack, legFront, legBack, neck, head };
}
