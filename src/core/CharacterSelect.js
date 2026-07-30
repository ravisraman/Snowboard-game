/**
 * Which character you are riding as — the player's side of the choice.
 *
 * The same split `RunSelect.js` makes, for the same reason: `entities/
 * Characters.js` describes what a character *is* (palette, what is on its
 * head), and this file is everything around that — remembering the choice, and
 * carrying a drop-in across the reload that changing it needs.
 *
 * ---------------------------------------------------------------------------
 * Why changing character reloads the page
 * ---------------------------------------------------------------------------
 * The rider's atlas is painted once into a canvas at start-up and the body
 * material is a module-level singleton holding those maps. Swapping character
 * live would mean rebuilding the model, repainting three 1024² canvases, and
 * re-pointing the material — while `Rider.js` holds direct references to the
 * bones of the model being thrown away, and `Game.js` holds the group it sits
 * in. Every one of those is a place to leave a dangling reference.
 *
 * A reload does the whole job exactly, costs a second on the loading screen the
 * player already expects to see, and is what switching run already does. The
 * drop-in is parked in `sessionStorage` the same way so the press is not lost.
 */

import { CHARACTERS, DEFAULT_CHARACTER, characterById } from '../entities/Characters.js';

export { CHARACTERS, DEFAULT_CHARACTER, characterById };

export const CHARACTER_IDS = CHARACTERS.map((c) => c.id);

const KEY = 'alpine-carve.character';

export function loadCharacter() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && CHARACTER_IDS.includes(saved)) return saved;
  } catch {
    /* private browsing, embedded frames */
  }
  return DEFAULT_CHARACTER;
}

export function saveCharacter(id) {
  try {
    localStorage.setItem(KEY, characterById(id).id);
  } catch {
    /* nothing worth interrupting a run over */
  }
}
