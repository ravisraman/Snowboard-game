import * as THREE from 'three';
import { makeRng } from '../core/mathx.js';
import { bucketColliders } from './Trees.js';

/**
 * Stars and slalom gates: a way to score that needs no trick skill at all.
 *
 * Both are placed with their own seeded RNG, the same reason `Trees.js` keeps
 * one of its own — a run should not reshuffle every time an unrelated system
 * changes how many random draws it makes.
 *
 * Neither ever ends a run or costs speed. Missing a star just leaves it there;
 * missing a gate resets the streak, not the score already banked. That is the
 * whole point of a collectible track running alongside the trick score: a run
 * with zero tricks still ends on a positive number.
 */

/**
 * A star has to be found against snow, which is the hardest background this
 * game has: white, brightly lit from every direction, and filling most of the
 * frame. A saturated gold gem on it is still a light thing on a light thing —
 * legible when you already know where it is, easy to ride straight past when
 * you do not.
 *
 * So the star is drawn twice: a bright warm core, and a near-black shell one
 * fifth larger with its faces flipped, which the depth test leaves showing only
 * around the silhouette. That is an outline, and an outline is the one thing
 * that works regardless of what is behind it — the same conclusion `Resort.js`
 * reached about marker poles, arrived at from the opposite direction.
 */
const STAR_COLOR = new THREE.Color('#ff7a00');
const STAR_CORE = new THREE.Color('#ffa310');
const STAR_OUTLINE = new THREE.Color('#141a24');
/**
 * How much bigger the outline shell is than the core.
 *
 * Generous, because this is measured in *pixels* at the distance that matters.
 * A star forty metres out is about fifteen pixels tall, so a shell 20% larger
 * is a one-pixel fringe and does nothing; a third larger is three or four
 * pixels of dark edge, which is a shape the eye catches.
 */
const STAR_OUTLINE_SCALE = 1.34;

/**
 * One flag colour, not two.
 *
 * Alternating red and blue is what a real slalom does, and it is what a real
 * slalom does *because* the two colours mean different things to a racer. Here
 * they meant nothing, so all they did was make a gate look like two unrelated
 * objects — and the red sat a few degrees off the orange the resort's own
 * marker poles and safety netting already use, which made the piste read as
 * having two vocabularies of orange thing.
 */
const GATE_FLAG = new THREE.Color('#2f7fd6');
const GATE_SHAFT = new THREE.Color('#243040');

export const STAR_PICKUP_RADIUS = 1.5;

/** A small faceted "gem" rather than a flat sprite — reads at speed and from any angle. */
function starGeometry() {
  const geo = new THREE.OctahedronGeometry(0.46, 0);
  geo.scale(1, 1.35, 1);
  return geo;
}

/**
 * A slalom pole: a thin shaft with a flag near the top, in one merged shape.
 *
 * Vertex-coloured rather than tinted per instance, so the shaft can be dark and
 * the flag bright within the one draw call. Every gate is now the same colour,
 * which is what makes this possible — with two colours the split had to live in
 * `instanceColor` and the whole pole went with it.
 */
function poleGeometry() {
  const shaft = new THREE.CylinderGeometry(0.05, 0.07, 2.0, 6);
  shaft.translate(0, 1.0, 0);
  const flag = new THREE.ConeGeometry(0.26, 0.5, 4);
  flag.rotateZ(Math.PI / 2);
  flag.translate(0.22, 1.55, 0);

  const shaftNI = shaft.toNonIndexed();
  const flagNI = flag.toNonIndexed();
  const shaftCount = shaftNI.attributes.position.count;
  const flagCount = flagNI.attributes.position.count;

  const positions = [...shaftNI.attributes.position.array, ...flagNI.attributes.position.array];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const colors = new Float32Array((shaftCount + flagCount) * 3);
  for (let i = 0; i < shaftCount + flagCount; i++) {
    const c = i < shaftCount ? GATE_SHAFT : GATE_FLAG;
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

export function buildCollectibles(course, { seed } = {}) {
  const cfg = course.config.collectibles;
  const rng = makeRng(seed ?? cfg.seed);
  const stars = [];
  const gates = [];

  /** Is there a rail within `pad` metres of this z? */
  const nearRail = (z, pad) =>
    course.railsNear(z).some((r) => z > r.z - pad && z < r.z + r.length + pad);

  /* ------------------------------------------------------------------
   * Stars: scattered close to the line, with an occasional light detour
   * off it. Never on a kicker ramp — a star buried under a jump would be
   * unreachable, not tempting.
   * ---------------------------------------------------------------- */
  const sc = cfg.stars;
  let z = sc.firstZ;
  while (z < course.finishZ - sc.endMargin) {
    z += sc.spacing.min + rng() * sc.spacing.range;
    if (rng() < sc.skipChance) continue;
    const cx = course.centerX(z);
    if (course.onKicker(cx, z, sc.kickerPad)) continue;

    const detour = rng() < sc.detourChance;
    const off = detour
      ? rng.spread(course.trackHalfWidth * sc.onTrackSpread)
      : rng.spread(course.trackHalfWidth + sc.offTrackExtra);
    const tan = course.trackTangent(z);
    const x = cx + off * tan.z;
    const zw = z - off * tan.x;
    if (course.onKicker(x, zw, 4)) continue;

    stars.push({
      id: stars.length,
      x,
      z: zw,
      y: course.groundHeight(x, zw) + sc.hover,
      phase: rng() * Math.PI * 2,
      collected: false,
    });
  }

  /* ------------------------------------------------------------------
   * Gates: short slalom runs, on stretches straight enough that a rider is
   * not already fighting the terrain.
   *
   * A gate is the one collectible with a *line* to it — you commit to the
   * whole group several poles ahead — so where it goes matters more than
   * where a star goes. Four things disqualify a site, and all four were
   * learned by looking at where gates actually ended up:
   *
   *   - a traverse. Weaving across a track that is already crossing the fall
   *     line asks the rider to fight two things at once.
   *   - a kicker or a rail inside the group. A pole pair in the middle of a
   *     take-off is a slalom nobody can ride and a jump nobody can hit.
   *   - the fork. Two lanes with a ridge between them cannot hold one slalom,
   *     and a group split down the divider reads as broken rather than hard.
   *   - anything that will not *fit*: the weave plus a pole's half-width has
   *     to stay inside the corduroy, or the outer pole of every gate stands in
   *     powder and the line through it is off the piste.
   *
   * The last one is why the weave is clamped rather than drawn: on the
   * Backcountry's eleven-metre half-width the drawn weave was regularly wider
   * than the run.
   * ---------------------------------------------------------------- */
  const gc = cfg.gates;
  let gz = gc.firstZ;
  let groupId = 0;
  while (gz < course.finishZ - gc.endMargin) {
    const n = gc.count.min + rng.int(0, gc.count.extra);
    const span = n * (gc.spacing.min + gc.spacing.range);

    /*
     * Swept along the whole group, not just tested at its first pole.
     *
     * A slalom is fifty to a hundred metres long and whatever it runs into is
     * usually not at the end you tested: checking only `gz` put the Park's
     * opening slalom at 220-313 straight through the kicker standing at 300.
     * Ten-metre steps, because that is finer than any feature these need to
     * miss is short.
     */
    let clear = Math.abs(course.centerSlope(gz)) < gc.maxSlope;
    for (let s = 0; s <= span && clear; s += 10) {
      const zz = gz + s;
      clear =
        !course.onKicker(course.centerX(zz), zz, gc.kickerPad) &&
        course.forkAmount(zz) === 0 &&
        !nearRail(zz, gc.kickerPad);
    }

    if (clear && rng() < gc.chance) {
      // Alternate which side each group opens on, so consecutive slaloms are
      // not all mirror images of each other.
      let side = groupId % 2 === 0 ? -1 : 1;
      for (let i = 0; i < n; i++) {
        const zz = gz + i * (gc.spacing.min + rng() * gc.spacing.range);
        const cx = course.centerX(zz);
        const tan = course.trackTangent(zz);
        const halfWidth = gc.halfWidth.min + rng() * gc.halfWidth.range;
        // Keep the whole gate on groomed snow, however wide the weave wanted
        // to be. `- 1` leaves the outer pole a metre inside the corduroy edge.
        const room = Math.max(0, course.trackHalfWidthAt(zz) - halfWidth - 1);
        const weave = side * Math.min(gc.weave.min + rng() * gc.weave.range, room);
        const x = cx + weave * tan.z;
        const zw = zz - weave * tan.x;
        gates.push({
          id: gates.length,
          x,
          z: zw,
          dirX: tan.x,
          dirZ: tan.z,
          halfWidth,
          groupId,
          index: i,
          passed: false,
        });
        side *= -1;
      }
      groupId++;
      gz += n * gc.gapPerGate + gc.gapAfter.min + rng() * gc.gapAfter.range;
    } else {
      gz += gc.stride;
    }
  }

  const group = new THREE.Group();
  group.name = 'collectibles';

  /* --- Stars, instanced and toggled invisible on pickup --------------- */
  // Shared scratch transform for every instanced write below.
  const dummy = new THREE.Object3D();

  const starGeo = starGeometry();
  /**
   * Emission turned *down*, not up.
   *
   * The instinct against a white background is to make the pickup brighter, and
   * it is exactly wrong: snow is already at the top of the range, so adding
   * light only pushes a gold gem further toward the white it is sitting on. At
   * 0.9 the star read as a pale smudge. What separates it is hue and darkness —
   * a saturated amber that is *less* bright than the snow, with the shell
   * around it.
   */
  const starMat = new THREE.MeshStandardMaterial({
    color: STAR_CORE,
    emissive: STAR_COLOR,
    emissiveIntensity: 0.45,
    roughness: 0.35,
    metalness: 0.15,
    flatShading: true,
  });
  /**
   * The silhouette shell. Back faces only, so the core hides all of it except
   * the fringe that falls outside the core's own outline — and `depthWrite`
   * off, so a shell never occludes the star in front of it.
   */
  const starOutlineMat = new THREE.MeshBasicMaterial({
    color: STAR_OUTLINE,
    side: THREE.BackSide,
    depthWrite: false,
  });

  const starMesh = stars.length ? new THREE.InstancedMesh(starGeo, starMat, stars.length) : null;
  const starOutline = stars.length
    ? new THREE.InstancedMesh(starGeo, starOutlineMat, stars.length)
    : null;
  if (starMesh) {
    starMesh.name = 'stars';
    starMesh.castShadow = true;
    starMesh.frustumCulled = false; // spread over 3 km; culling a chunk at a time is not worth the bookkeeping here
    group.add(starMesh);

    starOutline.name = 'star-outlines';
    starOutline.frustumCulled = false;
    // Drawn first, so the core always wins the depth test where they overlap.
    starOutline.renderOrder = -1;
    group.add(starOutline);
  }

  /**
   * One star, in both meshes at once.
   *
   * Every write to a star's transform has to hit the core and the shell or the
   * two come apart — a collected star whose outline stayed behind is a black
   * gem hanging over the piste. Keeping that in one function is the only
   * reason it cannot be forgotten in one of the three places it happens.
   */
  const writeStar = (id, place) => {
    if (!starMesh) return;
    place(1);
    starMesh.setMatrixAt(id, dummy.matrix);
    place(STAR_OUTLINE_SCALE);
    starOutline.setMatrixAt(id, dummy.matrix);
  };

  const flushStars = () => {
    if (!starMesh) return;
    starMesh.instanceMatrix.needsUpdate = true;
    starOutline.instanceMatrix.needsUpdate = true;
  };

  /* --- Gate poles, instanced, one colour --------------------------------
   * The dark shaft and bright flag come from the geometry's own vertex
   * colours, so there is nothing left for `instanceColor` to carry and it is
   * gone along with the buffer it needed.
   * -------------------------------------------------------------------- */
  const poleGeo = poleGeometry();
  const poleMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.7,
    metalness: 0,
    flatShading: true,
  });
  const poleMesh = gates.length ? new THREE.InstancedMesh(poleGeo, poleMat, gates.length * 2) : null;
  if (poleMesh) {
    poleMesh.name = 'gates';
    poleMesh.castShadow = true;
    poleMesh.frustumCulled = false;
    group.add(poleMesh);
  }

  if (poleMesh) {
    gates.forEach((g, i) => {
      const px = g.dirZ;
      const pz = -g.dirX;
      const ground = course.terrainHeight(g.x, g.z);
      for (let side = 0; side < 2; side++) {
        const sign = side === 0 ? -1 : 1;
        const x = g.x + px * g.halfWidth * sign;
        const z = g.z + pz * g.halfWidth * sign;
        dummy.position.set(x, ground, z);
        dummy.rotation.set(0, Math.atan2(g.dirX, g.dirZ), 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        poleMesh.setMatrixAt(i * 2 + side, dummy.matrix);
      }
    });
    poleMesh.instanceMatrix.needsUpdate = true;
  }

  const collectStar = (id) => {
    writeStar(id, () => {
      dummy.position.set(0, -500, 0);
      dummy.scale.setScalar(0);
      dummy.updateMatrix();
    });
    flushStars();
  };

  /** Bobs and spins every uncollected star — a couple hundred cheap matrix writes. */
  let time = 0;
  const update = (dt) => {
    if (!starMesh) return;
    time += dt;
    for (const s of stars) {
      if (s.collected) continue;
      writeStar(s.id, (scale) => {
        dummy.position.set(s.x, s.y + Math.sin(time * 1.6 + s.phase) * 0.18, s.z);
        dummy.rotation.set(0, time * 1.4 + s.phase, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
      });
    }
    flushStars();
  };

  // Initial placement, before the first `update()` call runs.
  for (const s of stars) {
    writeStar(s.id, (scale) => {
      dummy.position.set(s.x, s.y, s.z);
      dummy.rotation.set(0, s.phase, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
    });
  }
  flushStars();

  /** A fresh run: every star reappears, every gate is unpassed. */
  const resetRun = () => {
    for (const s of stars) s.collected = false;
    for (const g of gates) g.passed = false;
  };

  return {
    group,
    stars,
    gates,
    starsBucket: bucketColliders(stars, 12),
    gatesBucket: bucketColliders(gates, 20),
    collectStar,
    resetRun,
    update,
  };
}
