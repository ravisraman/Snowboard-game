/**
 * Who you are riding as.
 *
 * All three share one body: the same skinned mesh, the same skeleton, the same
 * physics and the same animation code. What differs is the palette baked into
 * the texture atlas and a handful of rigid pieces hung off the head and hands —
 * a snout and ears, or a hat, a beard and a staff.
 *
 * That is a deliberate limit rather than a shortcut. The rider is one mesh with
 * one material and one draw call, and every pose in `Rider.js` is written
 * against that specific skeleton; a genuinely different body would be a second
 * rig, a second atlas and a second set of poses, and three of those is a
 * different project. A recoloured rig with a good silhouette on top reads as a
 * different character from the chase camera, which is the only place anyone
 * ever sees it.
 *
 * ---------------------------------------------------------------------------
 * Adding one
 * ---------------------------------------------------------------------------
 * A new entry needs a full `palette` — every key, because the paint functions
 * in `RiderTextures.js` index it directly and a missing one paints
 * `undefined` — and a `head` style that `RiderModel.js` knows how to build.
 * Everything else is optional.
 */

/** The palette the game shipped with, and the base every other one varies. */
const RIDER_PALETTE = {
  shell: '#f0742b',
  shellDark: '#c9541a',
  shellDeep: '#8f3a12',
  trim: '#1e2a38',
  trimLight: '#33465c',
  pants: '#2f568f',
  pantsDark: '#24406d',
  skin: '#e7b189',
  skinShade: '#cf9068',
  beanie: '#f2b431',
  beanieDark: '#d8921f',
  boot: '#1b2028',
  mitten: '#222c3a',
};

export const CHARACTERS = [
  {
    id: 'rider',
    name: 'THE RIDER',
    blurb: 'Orange shell, yellow beanie, goggles down.',
    /** Emoji shown on the picker card — cheaper and clearer than a 3D preview. */
    badge: '🏂',
    head: 'beanie',
    palette: RIDER_PALETTE,
  },

  {
    id: 'fox',
    name: 'THE FOX',
    blurb: 'Ears up, tail out, goggles on. Still knows how to land it.',
    badge: '🦊',
    head: 'fox',
    /**
     * Fur where the fabric was. The jacket becomes the fox's back, the pants
     * its haunches, and mittens and boots go to near-black for paws — which is
     * the whole trick, because a fox reads almost entirely as "orange body,
     * dark feet, white front".
     *
     * `skin` is the face, so it is fur orange here rather than a skin tone; the
     * cream of the muzzle is a separate piece of geometry, since the head is
     * one sphere with one UV island and a two-tone face cannot be painted into
     * it without a second island.
     */
    palette: {
      shell: '#e2762b',
      shellDark: '#bb571b',
      shellDeep: '#8a3d10',
      trim: '#f7e6cd',
      trimLight: '#fff6e8',
      pants: '#c9631f',
      pantsDark: '#a04c14',
      skin: '#e2762b',
      skinShade: '#bb571b',
      beanie: '#e2762b',
      beanieDark: '#bb571b',
      boot: '#241c18',
      mitten: '#2b211b',
    },
  },

  {
    id: 'wizard',
    name: 'THE WIZARD',
    blurb: 'Grey robes, long beard, and a staff he refuses to leave behind.',
    badge: '🧙',
    head: 'wizard',
    /** No goggles on this one — the beard is the silhouette, and it needs the face. */
    staff: true,
    palette: {
      shell: '#84808f',
      shellDark: '#65626f',
      shellDeep: '#4a4753',
      trim: '#3f3c47',
      trimLight: '#56525f',
      pants: '#5d5a67',
      pantsDark: '#484552',
      skin: '#e7b189',
      skinShade: '#cf9068',
      beanie: '#84808f',
      beanieDark: '#65626f',
      boot: '#3a3128',
      mitten: '#6b5a49',
    },
  },
];

/** The one everything that came before this file was built around. */
export const DEFAULT_CHARACTER = CHARACTERS[0].id;

/** Never throws and never returns something that is not in the list. */
export function characterById(id) {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}
