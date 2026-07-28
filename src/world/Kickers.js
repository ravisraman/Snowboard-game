import * as THREE from 'three';
import { clamp } from '../core/mathx.js';

/**
 * Kicker ramps.
 *
 * The geometry is sampled from exactly the same `kickerProfile()` the physics
 * reads, so what the rider sees is what the board rides. Each ramp ends in a
 * hard lip: the ground falls away instantly, which is what flings the rider.
 *
 * A step-down or a gap adds a *deck* — a raised platform the ramp stands on,
 * with a roll-in behind it and a landing stepping back down to the snow in
 * front. It is drawn as two more patches of the same sampled ground, wider
 * than the ramp, and the lip face is dropped only as far as the deck rather
 * than all the way to the terrain.
 */

const BASE_COLOR = new THREE.Color('#93c1e7');
const LIP_COLOR = new THREE.Color('#ffffff');
const SIDE_COLOR = new THREE.Color('#9fc2e0');
// A deck is snow, not a structure, and it is thirty metres across: the ramp's
// saturated blue reads as a painted stripe at that size. These sit right next
// to `Terrain.js`'s own palette, so the shape comes from the flat shading and
// the tint only separates the packed top from the untouched flanks.
const DECK_LOW_COLOR = new THREE.Color('#c6dbef');
const DECK_TOP_COLOR = new THREE.Color('#f4faff');

export function buildKickers(course) {
  const positions = [];
  const colors = [];
  const indices = [];
  const color = new THREE.Color();
  const ramp = new THREE.Color();

  for (const k of course.kickers) {
    const px = k.dirZ; // perpendicular, skier's right
    const pz = -k.dirX;
    const deck = k.deck;

    /**
     * A grid patch of sampled ground over `s0..s1` at half-width `hw`. Every
     * vertex sits 15 mm above `terrainHeight + kickerProfile`, which keeps the
     * skirt out of the slope's z-buffer without lifting it enough to see.
     */
    const patch = (s0, s1, hw, si, ti, tintAt) => {
      const start = positions.length / 3;
      for (let i = 0; i <= si; i++) {
        const s = s0 + (i / si) * (s1 - s0);
        for (let j = 0; j <= ti; j++) {
          const t = -hw + (j / ti) * hw * 2;
          const x = k.x + k.dirX * s + px * t;
          const z = k.z + k.dirZ * s + pz * t;
          const lift = course.kickerProfile(k, x, z);
          positions.push(x, course.terrainHeight(x, z) + lift + 0.015, z);
          tintAt(color, lift, s, t);
          colors.push(color.r, color.g, color.b);
        }
      }
      const row = ti + 1;
      for (let i = 0; i < si; i++) {
        for (let j = 0; j < ti; j++) {
          const a = start + i * row + j;
          indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
        }
      }
    };

    /** Snow on the deck: packed and bright on top, untouched down the flanks. */
    const deckTint = (c, lift) => {
      c.copy(DECK_LOW_COLOR).lerp(DECK_TOP_COLOR, 0.3 + 0.7 * clamp(lift / deck.lift, 0, 1) ** 1.2);
    };

    // Deliberately coarse. A finely tessellated ramp renders as a flat white
    // slab with no readable form; faceting it at roughly a metre gives the
    // shoulders and the transition real shading, and matches the low-poly
    // language of the trees and peaks.
    const sSteps = Math.max(7, Math.round(k.length / 1.1));
    // On a deck the ramp patch has to span the deck's full width, or the
    // ground between the ramp's shoulder and the deck's edge is simply missing.
    const rampHW = deck ? deck.halfWidth : k.halfWidth;
    const tSteps = Math.max(6, Math.round((rampHW * 2) / 1.5));

    // --- Ramp surface (and, on a deck, the table it stands on) ----------
    //
    // Packed snow brightens toward the lip so the take-off reads at speed. On a
    // deck the patch reaches out past the ramp's shoulders, so the tint has to
    // be measured against the deck under *that* column rather than against the
    // terrain — the deck's flank is a metre lower than its middle, and reading
    // the ramp's height off the terrain paints the whole flank as ramp.
    patch(0, k.length, rampHW, sSteps, tSteps, (c, lift, s, t) => {
      const floor = deck ? course.kickerProfile(k, k.x + px * t, k.z + pz * t) : 0;
      const up = clamp((lift - floor) / k.height, 0, 1);
      ramp.copy(BASE_COLOR).lerp(LIP_COLOR, 0.12 + 0.88 * up * up);
      if (!deck) { c.copy(ramp); return; }
      deckTint(c, floor);
      c.lerp(ramp, clamp(up * 4, 0, 1));
    });

    // --- Lip face: the vertical drop the rider launches off ------------
    //
    // On a deck it stops at the deck rather than at the terrain: the snow
    // below that is the deck's own body, and drawing the face through it puts
    // a sliver of wall inside a solid.
    const lipSteps = Math.max(6, Math.round((k.halfWidth * 2) / 1.5));
    const lipStart = positions.length / 3;
    for (let j = 0; j <= lipSteps; j++) {
      const t = -k.halfWidth + (j / lipSteps) * k.halfWidth * 2;
      const x = k.x + k.dirX * k.length + px * t;
      const z = k.z + k.dirZ * k.length + pz * t;
      const ground = course.terrainHeight(x, z);
      const lift = course.kickerProfile(k, x, z);
      const foot = deck
        ? ground + course.kickerProfile(k, x + k.dirX * 0.4, z + k.dirZ * 0.4) - 0.05
        : ground - 0.05;
      positions.push(x, ground + lift + 0.015, z);
      colors.push(LIP_COLOR.r, LIP_COLOR.g, LIP_COLOR.b);
      positions.push(x, foot, z);
      colors.push(SIDE_COLOR.r, SIDE_COLOR.g, SIDE_COLOR.b);
    }
    for (let j = 0; j < lipSteps; j++) {
      const a = lipStart + j * 2;
      indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }

    if (!deck) continue;

    // --- The roll-in behind the ramp, and the landing in front of it -----
    //
    // Both are sampled from `kickerProfile()` exactly like the ramp, so what
    // is drawn is what is ridden. At their outer ends the profile has eased to
    // zero, so each patch meets the terrain mesh flush and the seam does not
    // read.
    const deckT = Math.max(12, Math.round((deck.halfWidth * 2) / 1.3));
    patch(-deck.approach, 0, deck.halfWidth,
      Math.max(10, Math.round(deck.approach / 1.6)), deckT, deckTint);
    patch(k.length, k.length + deck.length, deck.halfWidth,
      Math.max(16, Math.round(deck.length / 1.4)), deckT, deckTint);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.8,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'kickers';
  return mesh;
}
