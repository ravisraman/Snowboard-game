/**
 * Who is riding.
 *
 * A leaderboard needs a name against every row, and asking for one is the
 * single most annoying thing a game can do badly — so it is asked for once,
 * before the first run, remembered afterwards, and changeable from the title
 * screen without a dialog.
 *
 * Deliberately not a login. There are no accounts here and there is nothing to
 * verify; a name is a label on a score, and treating it as anything more would
 * mean asking for an email address to make a snowboard game work.
 */

const KEY = 'alpine-carve.profile.v1';

/** Anything a leaderboard row would rather not carry. */
function clean(name) {
  return String(name ?? '')
    // Control characters and angle brackets only. The name is written into
    // the DOM as text either way, but a row arriving from a server later
    // should not be able to carry markup in on the back of a name.
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 14);
}

export class Profile {
  constructor() {
    this.name = '';
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      this.name = raw ? clean(JSON.parse(raw)?.name) : '';
    } catch {
      this.name = '';
    }
    return this.name;
  }

  save(name) {
    this.name = clean(name);
    try {
      localStorage.setItem(KEY, JSON.stringify({ name: this.name }));
    } catch {
      /* the run matters more than remembering the name */
    }
    return this.name;
  }

  /** Has this player ever told us who they are? */
  get known() {
    return this.name.length > 0;
  }

  /** What to put on a score when they have not. */
  get display() {
    return this.known ? this.name : 'RIDER';
  }
}
