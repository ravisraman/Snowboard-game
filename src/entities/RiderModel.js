import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, smoothstep } from '../core/mathx.js';
import { riderTextures, remapUV, REGION } from './RiderTextures.js';

/**
 * The snowboarder: model and rig.
 *
 * `Rider.js` owns the physics and decides what pose the rider is in. What
 * lives here is the shape of the thing and the joints it bends at.
 *
 * **The body is one skinned mesh.** It used to be about forty boxes and
 * capsules bolted together, and it read exactly like that — a puppet on a
 * plank, which is unforgiving when it is the one object the camera never looks
 * away from. Now the torso, arms, legs, head and mittens are a single
 * continuous surface lofted along the bones, weighted so knees and elbows
 * crease instead of scissoring. Being one mesh with one material, it is also
 * *one draw call* for the whole character, which is fewer than the boxes cost.
 *
 * **The rig kept its old shape on purpose.** Every node `Rider.js` reaches for
 * — `armFront.root`, `legBack.joint`, `neck`, `head` — is still here under the
 * same name, because `Bone` extends `Object3D` and a bone can be posed exactly
 * as a group was. The geometry underneath changed completely; the interface
 * did not, so several hundred lines of posing code carried over untouched.
 *
 * **The legs are solved, not posed.** The boots are bolted to the board, so
 * every crouch has to come out of the knees — if the body simply slides down
 * the feet sink through the deck. A two-bone IK solve per leg pins the boots
 * to the bindings and lets the knees do the absorbing, which is most of what
 * makes the model read as a snowboarder rather than a puppet on a plank.
 *
 * Rigid things — the board, the bindings, the boots, the goggles, the beanie —
 * stay as baked child meshes hanging off bones. There is nothing to gain from
 * skinning a plank.
 */

/* ------------------------------------------------------------------
 * Proportions
 * ---------------------------------------------------------------- */

export const RIG = {
  boardTop: 0.11,        // where the bindings sit, in tilt space
  hipHeight: 0.68,       // hip height standing tall, above the board top
  thigh: 0.3,
  shin: 0.29,
  upperArm: 0.235,
  forearm: 0.222,
  frontBindingZ: 0.32,
  backBindingZ: -0.3,
  stanceX: 0.02,         // feet not quite on the centre line
};

/** Rest positions, in the space of `body`. Geometry is authored here too. */
const REST = {
  hip: { x: RIG.stanceX, y: -0.06, front: 0.14, back: -0.13 },
  torsoY: 0.06,
  shoulder: { x: 0.01, y: 0.55, z: 0.235 },   // z is +front / -back
  neck: { x: 0.005, y: 0.63 },
};

const MAT = {
  /**
   * The whole body: one atlas, one material, one draw call. Physical rather
   * than standard for the sheen — outerwear and knitwear catch a soft edge of
   * light that plain roughness cannot express, and the rider is close enough
   * to the camera for it to be worth the shader.
   */
  body: new THREE.MeshPhysicalMaterial({
    // Left at 1 so the roughness map is the whole story: it multiplies in, and
    // a material value below 1 would flatten every garment toward the same
    // finish regardless of what the atlas says.
    roughness: 1,
    metalness: 0,
    sheen: 0.4,
    sheenRoughness: 0.85,
    sheenColor: new THREE.Color('#cfe4ff'),
    normalScale: new THREE.Vector2(0.9, 0.9),
  }),
  goggleFrame: new THREE.MeshStandardMaterial({ color: '#1a2029', roughness: 0.45 }),
  goggleLens: new THREE.MeshPhysicalMaterial({
    color: '#7fd4f0', roughness: 0.06, metalness: 0.9,
    clearcoat: 1, clearcoatRoughness: 0.04,
    emissive: '#14384a', emissiveIntensity: 0.35,
  }),
  deck: new THREE.MeshStandardMaterial({ color: '#242a33', roughness: 0.42, flatShading: true }),
  deckArt: new THREE.MeshStandardMaterial({ color: '#f0742b', roughness: 0.4, flatShading: true }),
  base: new THREE.MeshStandardMaterial({ color: '#e9f1f8', roughness: 0.16, metalness: 0.2, flatShading: true }),
  edge: new THREE.MeshStandardMaterial({ color: '#c9d4de', roughness: 0.18, metalness: 0.95 }),
  binding: new THREE.MeshStandardMaterial({ color: '#39414d', roughness: 0.75 }),
};

/**
 * The parts that are actually metal, and so are the only ones with anything to
 * reflect: the board's base and steel edge, and the goggle lens.
 */
export const REFLECTIVE_MATERIALS = [MAT.base, MAT.edge, MAT.goggleLens];

/**
 * A cool rim light along the silhouette, keyed to the sky rather than to the
 * sun.
 *
 * A character against snow is lit from every direction at once and flattens
 * out; one fresnel term along the edge is the cheapest thing there is that
 * puts them back in front of the mountain instead of on it. It is added as
 * emission, which keeps it out of the shadow term — the rim should survive the
 * rider passing through a tree's shadow.
 */
function addRimLight(material, { colour = '#bcd9ff', strength = 0.26, power = 6 } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: new THREE.Color(colour) };
    shader.uniforms.uRimStrength = { value: strength };
    shader.uniforms.uRimPower = { value: power };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uRimColor;
         uniform float uRimStrength;
         uniform float uRimPower;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         float rimDot = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
         totalEmissiveRadiance += uRimColor * pow(rimDot, uRimPower) * uRimStrength;`
      );
  };
  material.customProgramCacheKey = () => `rider-rim-${strength}`;
  return material;
}

/* ------------------------------------------------------------------
 * Rigid parts: pile them up, bake them down
 * ---------------------------------------------------------------- */

/**
 * Adds a shape to a node's pending pile rather than as its own mesh.
 *
 * A rider assembled as one mesh per box is forty-odd draw calls for a single
 * character — more than the entire forest. Anything rigid with respect to its
 * parent can be baked into that parent's geometry instead, so each node ends
 * up with one mesh per material, and only the parts that actually move
 * separately stay separate.
 */
function mesh(geo, mat, parent, x = 0, y = 0, z = 0) {
  // `mergeGeometries` refuses to mix indexed with non-indexed, or to merge
  // geometries whose attribute sets disagree — so everything is de-indexed,
  // and UVs are kept only for the materials that actually sample a texture.
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!mat.map) g.deleteAttribute('uv');
  if (x || y || z) g.translate(x, y, z);
  if (!parent.userData.pending) parent.userData.pending = [];
  parent.userData.pending.push({ geo: g, mat });
  return g;
}

/** Bakes everything piled onto a node into one mesh per material. */
function bake(node) {
  const pending = node.userData.pending;
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
      node.add(m);
    }
    delete node.userData.pending;
  }
  for (const child of [...node.children]) if (!child.isMesh) bake(child);
  return node;
}

/** A box with its corners knocked off — the mittens, the boots, the bindings. */
function roundedBox(w, h, d, radius, segments = 2) {
  // Three has no rounded box, and a lathe cannot do a box. Scaling a
  // subdivided box out into a rounded shell is the cheapest thing that gives
  // the silhouette a bit of softness.
  const geo = new THREE.BoxGeometry(w, h, d, segments, segments, segments);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const half = new THREE.Vector3(w * 0.5 - radius, h * 0.5 - radius, d * 0.5 - radius);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
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

  mesh(roundedBox(0.28, 0.035, 0.34, 0.012), MAT.binding, g, 0, 0, 0);
  const highback = roundedBox(0.24, 0.2, 0.04, 0.015);
  highback.rotateX(0.22);
  mesh(highback, MAT.binding, g, 0, 0.1, -0.14);
  mesh(roundedBox(0.25, 0.045, 0.11, 0.02), MAT.binding, g, 0, 0.13, 0.02);   // ankle strap
  mesh(roundedBox(0.22, 0.04, 0.08, 0.018), MAT.binding, g, 0, 0.06, 0.13);   // toe strap
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
  mesh(roundedBox(0.04, 0.014, 0.5, 0.006), MAT.deck, board, 0.05, 0.057, 0.1);
  mesh(roundedBox(0.12, 0.012, 0.1, 0.005), MAT.binding, board, 0.02, 0.056, 0.02);

  buildBinding(board, RIG.frontBindingZ);
  buildBinding(board, RIG.backBindingZ);
  return board;
}

/* ------------------------------------------------------------------
 * Skinned surfaces
 * ---------------------------------------------------------------- */

/**
 * Lofts a tube through a list of rings and skins it.
 *
 * Each ring carries its centre, an elliptical cross-section, a texture V and
 * the bones it belongs to. Weights are per ring rather than per vertex, which
 * is all this rig needs: a limb creases across the joint, never around it.
 *
 * The frame is built from a fixed reference axis rather than by parallel
 * transport, because every part of this body runs roughly up-down and a stable
 * frame is worth more here than a perfectly minimal twist. It also means U=0
 * lands on the +Z side of every part, which is what lets the atlas put a zip
 * on the chest and a seam down the outside of a sleeve.
 */
function loft(rings, radial = 14) {
  const pos = [];
  const uv = [];
  const skinIndex = [];
  const skinWeight = [];

  const ringVerts = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    // Tangent from the neighbouring rings, so the cross-section stays square
    // to the run of the limb where it bends.
    const prev = rings[Math.max(0, r - 1)];
    const next = rings[Math.min(rings.length - 1, r + 1)];
    const tangent = tmp.copy(next.c).sub(prev.c);
    if (tangent.lengthSq() < 1e-9) tangent.set(0, -1, 0);
    tangent.normalize();

    const ref = Math.abs(tangent.dot(up)) > 0.92 ? new THREE.Vector3(1, 0, 0) : up;
    const axisX = new THREE.Vector3().crossVectors(ref, tangent).normalize();  // -> +Z-ish
    const axisZ = new THREE.Vector3().crossVectors(tangent, axisX).normalize();

    const verts = [];
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const p = new THREE.Vector3()
        .copy(ring.c)
        .addScaledVector(axisX, Math.cos(a) * ring.rx)
        .addScaledVector(axisZ, Math.sin(a) * ring.rz);
      verts.push(p);
      pos.push(p.x, p.y, p.z);
      uv.push(i / radial, ring.v);
      const b = ring.bones;
      skinIndex.push(b[0], b.length > 1 ? b[1] : 0, 0, 0);
      const w = ring.weights ?? [1, 0];
      skinWeight.push(w[0], w[1] ?? 0, 0, 0);
    }
    ringVerts.push(verts);
  }

  const index = [];
  const stride = radial + 1;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < radial; i++) {
      const a = r * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      // Wound so the faces point *out*. With (axisX, axisZ, tangent) forming a
      // right-handed frame, the other winding gives every tube an inward
      // normal: it still renders — you are looking at the inside of the far
      // wall — but the shading is subtly wrong everywhere and any opening,
      // like the collar, becomes a black hole instead of a neck.
      index.push(a, d, c, a, b, d);
    }
  }

  // Fan caps, so a limb does not end in a hole. The rings at the ends are
  // already pulled in tight by the dome helper, so these are small.
  const capAt = (r, flip) => {
    const ring = rings[r];
    const centre = pos.length / 3;
    pos.push(ring.c.x, ring.c.y, ring.c.z);
    uv.push(0.5, ring.v);
    const b = ring.bones;
    skinIndex.push(b[0], b.length > 1 ? b[1] : 0, 0, 0);
    const w = ring.weights ?? [1, 0];
    skinWeight.push(w[0], w[1] ?? 0, 0, 0);
    for (let i = 0; i < radial; i++) {
      const a = r * stride + i;
      if (flip) index.push(centre, a, a + 1);
      else index.push(centre, a + 1, a);
    }
  };
  capAt(0, true);
  capAt(rings.length - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setIndex(index);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  geo.computeVertexNormals();
  return geo;
}

/**
 * One rigid run of a limb — a thigh, a shin, an upper arm — as rings that
 * belong entirely to a single bone.
 *
 * **Why the limbs are not skinned across their joints.** They were, at first:
 * one continuous tube per limb with the weights blended over the knee, which
 * is what a character rig normally does. It cannot survive the poses this game
 * actually asks for. Linear blend skinning pulls the surface toward the bone
 * axis wherever two bones share a vertex, so a narrow blend band turned the
 * inside of a folded knee inside out in every grab — the rider spends whole
 * seconds at a hundred and fifteen degrees of knee — and a wide one sucked the
 * legs flat into ribbons in every hard carve. There is no width that survives
 * both. The real answers are dual quaternion skinning or corrective shapes,
 * and both are a great deal of machinery for a character this size.
 *
 * Rigid segments cannot deform at all, so neither failure exists. The seam at
 * each joint is covered by a ball centred exactly on the pivot — a point that
 * by definition never moves however far the joint bends. What comes out reads
 * as a stylised character rather than an anatomical one, which is what the
 * rest of this mountain looks like anyway.
 */
function segmentRings({ from, to, rFrom, rTo, bone, vFrom = 1, vTo = 0, steps = 4, squash = 0.96 }) {
  const rings = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = rFrom + (rTo - rFrom) * t;
    rings.push({
      c: new THREE.Vector3().lerpVectors(from, to, t),
      rx: r * squash,
      rz: r,
      v: vFrom + (vTo - vFrom) * t,
      bones: [bone, bone],
      weights: [1, 0],
    });
  }
  return rings;
}

/** Gives a plain geometry skin attributes tying every vertex to one bone. */
function skinToBone(geo, boneIndex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const idx = new Uint16Array(n * 4);
  const w = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    idx[i * 4] = boneIndex;
    w[i * 4] = 1;
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  return g;
}

/**
 * The ball that covers a joint.
 *
 * Rigidly attached to one of the two bones meeting there and centred on the
 * pivot, so it can never open a gap: whichever way the joint folds, the point
 * it folds about is exactly where the ball already is.
 */
function jointBall(centre, radius, boneIndex, region, segments = 12) {
  const geo = new THREE.SphereGeometry(radius, segments, Math.max(6, segments - 4));
  geo.translate(centre.x, centre.y, centre.z);
  return remapUV(skinToBone(geo, boneIndex), region);
}

/**
 * Rescales a geometry's UVs to fill 0-1 before it is folded into the atlas.
 *
 * Partial spheres and open cylinders come out of Three with UVs covering only
 * the slice they represent — a beanie dome uses V 0.4 to 1 — which would
 * sample only the top of its rectangle and never show the brim.
 */
function stretchUV(geo) {
  const uv = geo.attributes.uv;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    minU = Math.min(minU, uv.getX(i)); maxU = Math.max(maxU, uv.getX(i));
    minV = Math.min(minV, uv.getY(i)); maxV = Math.max(maxV, uv.getY(i));
  }
  const su = maxU - minU || 1;
  const sv = maxV - minV || 1;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) - minU) / su, (uv.getY(i) - minV) / sv);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Pulls the last ring of a run into a rounded dome instead of a flat end. */
function dome(rings, { steps = 3, reach = 1 } = {}) {
  const last = rings[rings.length - 1];
  const prev = rings[rings.length - 2] ?? last;
  const dir = new THREE.Vector3().subVectors(last.c, prev.c).normalize();
  const r = Math.max(last.rx, last.rz);
  for (let i = 1; i <= steps; i++) {
    const a = (i / (steps + 0.35)) * Math.PI * 0.5;
    rings.push({
      c: new THREE.Vector3().copy(last.c).addScaledVector(dir, Math.sin(a) * r * reach),
      rx: last.rx * Math.cos(a),
      rz: last.rz * Math.cos(a),
      v: last.v,
      bones: last.bones,
      weights: last.weights,
    });
  }
  return rings;
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

  /* ---- Bones. Same names, same rest transforms, as the groups they replace ---- */
  const bones = [];
  const bone = (name, parent, x = 0, y = 0, z = 0) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    bones.push(b);
    return b;
  };

  const hips = bone('hips', body);
  const torso = bone('torso', body, 0, REST.torsoY, 0);
  // A snowboarder stands sideways: the shoulders line up with the deck, so the
  // torso is turned a quarter turn and everything above it is authored in that
  // frame. Negative X in torso space is the nose end of the board.
  torso.rotation.y = Math.PI * 0.5;

  const neck = bone('neck', torso, 0, 0.57, 0.005);
  const head = bone('head', neck);

  const limb = (name, parent, x, y, z) => {
    const rootBone = bone(`${name}.root`, parent, x, y, z);
    const joint = bone(`${name}.joint`, rootBone, 0, -(name.startsWith('leg') ? RIG.thigh : RIG.upperArm), 0);
    const end = bone(`${name}.end`, joint, 0, -(name.startsWith('leg') ? RIG.shin : RIG.forearm), 0);
    return { root: rootBone, joint, end };
  };

  const legFront = limb('legFront', hips, REST.hip.x, REST.hip.y, REST.hip.front);
  const legBack = limb('legBack', hips, REST.hip.x, REST.hip.y, REST.hip.back);
  // Arms hang from the torso, which is why their rest positions are given in
  // torso space: -X is toward the nose, so the front arm — the one that takes
  // most of the grabs — hangs on that side.
  const armFront = limb('armFront', torso, -0.235, 0.49, 0.01);
  const armBack = limb('armBack', torso, 0.235, 0.49, 0.01);

  const index = new Map(bones.map((b, i) => [b, i]));
  root.updateMatrixWorld(true);

  /**
   * Everything below is authored in `body` space, which is where the skinned
   * mesh sits. `at()` converts a point in a bone's own space into it.
   */
  const bodyInverse = new THREE.Matrix4().copy(body.matrixWorld).invert();
  const toBody = new THREE.Matrix4();
  const at = (boneRef, x = 0, y = 0, z = 0) =>
    new THREE.Vector3(x, y, z).applyMatrix4(toBody.multiplyMatrices(bodyInverse, boneRef.matrixWorld));

  const parts = [];

  /* ---- Torso: one continuous loft from seat to collar ---- */
  {
    const iHips = index.get(hips);
    const iTorso = index.get(torso);
    const iNeck = index.get(neck);
    // rx is chest depth (front to back), rz is shoulder width — the rider
    // stands across the board, so the wide axis lies along it.
    const sections = [
      // The hem drops below the hip joints on purpose: a jacket that stops at
      // the waist leaves a gap between the legs you can see daylight through.
      [-0.19, 0.118, 0.146, 0.00, [iHips, iTorso], [1, 0]],
      [-0.12, 0.136, 0.172, 0.06, [iHips, iTorso], [1, 0]],
      [-0.05, 0.142, 0.178, 0.13, [iHips, iTorso], [1, 0]],
      [0.03, 0.135, 0.170, 0.22, [iHips, iTorso], [0.75, 0.25]],
      [0.14, 0.127, 0.159, 0.36, [iHips, iTorso], [0.3, 0.7]],
      [0.28, 0.140, 0.183, 0.52, [iHips, iTorso], [0.05, 0.95]],
      [0.42, 0.152, 0.212, 0.70, [iTorso, iNeck], [1, 0]],
      [0.52, 0.150, 0.233, 0.84, [iTorso, iNeck], [1, 0]],
      [0.58, 0.133, 0.214, 0.91, [iTorso, iNeck], [0.85, 0.15]],
      [0.63, 0.098, 0.138, 0.96, [iTorso, iNeck], [0.5, 0.5]],
      [0.67, 0.066, 0.070, 1.00, [iTorso, iNeck], [0.1, 0.9]],
    ];
    const rings = sections.map(([y, rx, rz, v, bonePair, weights]) => ({
      c: at(torso, 0, y - REST.torsoY, 0),
      rx, rz, v, bones: bonePair, weights,
    }));
    parts.push(remapUV(loft(rings, 18), REGION.torso));
  }

  /* ---- Head ---- */
  {
    // Slightly larger than life. A head sized off a real body reads as a pin
    // at chase-camera distance, and every game character that has ever looked
    // good has cheated this by about the same amount.
    const geo = new THREE.SphereGeometry(0.135, 20, 14);
    geo.scale(0.93, 1.05, 0.97);
    // Lifted so a collar's worth of neck shows: buried any deeper the head
    // reads as sitting straight on the shoulders.
    geo.translate(0, 0.142, 0);
    geo.applyMatrix4(toBody.multiplyMatrices(bodyInverse, head.matrixWorld));
    parts.push(remapUV(skinToBone(geo, index.get(head)), REGION.head));
  }

  /* ---- Arms: upper arm, forearm, mitten, and balls over the joints ---- */
  for (const arm of [armFront, armBack]) {
    const iRoot = index.get(arm.root);
    const iJoint = index.get(arm.joint);
    const iEnd = index.get(arm.end);
    const shoulder = at(arm.root);
    const elbow = at(arm.joint);
    const wrist = at(arm.end);

    // The shoulder ball belongs to the *torso*, not to the arm: it is the hole
    // in the jacket the arm comes out of, and it should stay with the jacket
    // when the rider reaches for a grab.
    parts.push(jointBall(shoulder, 0.083, index.get(torso), REGION.sleeve));
    parts.push(jointBall(elbow, 0.062, iJoint, REGION.sleeve, 10));

    parts.push(remapUV(loft(segmentRings({
      from: shoulder, to: elbow, rFrom: 0.079, rTo: 0.06, bone: iRoot,
      vFrom: 0.98, vTo: 0.6, squash: 0.94,
    }), 12), REGION.sleeve));

    parts.push(remapUV(loft(segmentRings({
      from: elbow, to: wrist, rFrom: 0.059, rTo: 0.046, bone: iJoint,
      vFrom: 0.58, vTo: 0.2, squash: 0.94,
    }), 12), REGION.sleeve));

    // The mitten, fully owned by the hand bone: a stubby taper with a rounded
    // end, sized so it reads as a hand at chase-camera distance.
    const mitten = segmentRings({
      from: wrist, to: wrist.clone().add(new THREE.Vector3(0, -0.068, 0)),
      rFrom: 0.05, rTo: 0.056, bone: iEnd, vFrom: 0.16, vTo: 0.86, steps: 3, squash: 0.9,
    });
    dome(mitten, { steps: 3 });
    parts.push(remapUV(loft(mitten, 12), REGION.mitten));
  }

  /* ---- Legs: thigh, shin, knee ball ---- */
  for (const leg of [legFront, legBack]) {
    const iRoot = index.get(leg.root);
    const iJoint = index.get(leg.joint);
    const hip = at(leg.root);
    const knee = at(leg.joint);
    const ankle = at(leg.end);

    // The hip ball rides with the body, and lives entirely inside the jacket.
    parts.push(jointBall(hip, 0.104, index.get(hips), REGION.pants));
    // The knee ball goes with the shin, which is where a kneecap sits.
    parts.push(jointBall(knee, 0.088, iJoint, REGION.pants));

    parts.push(remapUV(loft(segmentRings({
      from: hip, to: knee, rFrom: 0.115, rTo: 0.086, bone: iRoot,
      vFrom: 0.98, vTo: 0.56,
    }), 12), REGION.pants));

    parts.push(remapUV(loft(segmentRings({
      from: knee, to: ankle, rFrom: 0.087, rTo: 0.062, bone: iJoint,
      vFrom: 0.54, vTo: 0.06, steps: 5,
    }), 12), REGION.pants));
  }

  /* ---- One mesh, one material, one draw call ---- */
  const { map, normalMap, roughnessMap } = riderTextures();
  MAT.body.map = map;
  MAT.body.normalMap = normalMap;
  MAT.body.roughnessMap = roughnessMap;
  addRimLight(MAT.body);

  const geometry = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  const skeleton = new THREE.Skeleton(bones);
  const skinned = new THREE.SkinnedMesh(geometry, MAT.body);
  skinned.castShadow = true;
  // The bind pose says nothing about where a spinning, folded-up rider ends
  // up, so the bounds are useless and culling on them makes the character
  // vanish mid-trick.
  skinned.frustumCulled = false;
  body.add(skinned);
  skinned.bind(skeleton);

  /* ---- Rigid props, hanging off the bones ---- */

  // Boots. They are counter-rotated in the animation so they stay flat on the
  // board however the knee is bent, so they need to be nodes of their own.
  for (const leg of [legFront, legBack]) {
    const boot = new THREE.Group();
    leg.end.add(boot);
    mesh(remapUV(roundedBox(0.16, 0.15, 0.27, 0.05), REGION.boot), MAT.body, boot, 0, -0.045, 0.01);
    mesh(remapUV(roundedBox(0.15, 0.12, 0.14, 0.04), REGION.boot), MAT.body, boot, 0, 0.035, -0.02);
    leg.boot = boot;
  }

  // Goggles and a beanie. The beanie's bobble is its own node so it can swing.
  mesh(remapUV(stretchUV(new THREE.SphereGeometry(0.142, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.6)), REGION.beanie),
    MAT.body, head, 0, 0.216, 0);
  mesh(remapUV(stretchUV(new THREE.CylinderGeometry(0.147, 0.151, 0.064, 14)), REGION.beanie),
    MAT.body, head, 0, 0.183, 0);

  const bobble = new THREE.Group();
  bobble.position.set(0, 0.295, 0);
  head.add(bobble);
  mesh(remapUV(stretchUV(new THREE.SphereGeometry(0.046, 10, 8)), REGION.beanie), MAT.body, bobble, 0, 0.04, 0);

  mesh(roundedBox(0.212, 0.072, 0.05, 0.024), MAT.goggleFrame, head, 0, 0.164, 0.088);
  mesh(roundedBox(0.186, 0.052, 0.03, 0.014), MAT.goggleLens, head, 0, 0.164, 0.108);
  mesh(new THREE.CylinderGeometry(0.136, 0.136, 0.046, 14, 1, true), MAT.goggleFrame, head, 0, 0.164, 0);

  bake(root);
  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  return {
    root, tilt, board, body, hips, torso,
    armFront, armBack, legFront, legBack,
    neck, head, bobble, skinned, skeleton,
  };
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
  const d = clamp(reach, Math.abs(upper - lower) + 0.02, upper + lower - 0.015);

  // Direction from the joint root to the target, measured from straight down.
  const dir = Math.atan2(-targetZ, -targetY);
  const alpha = Math.acos(clamp((upper * upper + d * d - lower * lower) / (2 * upper * d), -1, 1));
  const gamma = Math.acos(clamp((upper * upper + lower * lower - d * d) / (2 * upper * lower), -1, 1));

  limbParts.root.rotation.x = dir + bend * alpha;
  limbParts.joint.rotation.x = -bend * (Math.PI - gamma);
}
