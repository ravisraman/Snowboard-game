/**
 * The high score table.
 *
 * Every method is async and every entry carries the fields a server would
 * need, even though the only store that exists today writes to `localStorage`.
 * That is the whole design decision here: the interface, the entry shape and
 * the entire UI are written once, against something that can be either local
 * or remote, so putting real scores behind it later is a change of one line in
 * one file rather than a rewrite of the screens that display them.
 *
 *   const board = new Leaderboard();          // local
 *   const board = new Leaderboard(new RemoteStore('/api/scores'));
 *
 * Two things are carried now purely so a server can use them later, and
 * nothing reads them yet: `seed`, which says which mountain the run was on,
 * and `checksum`, which lets a submission be tied to the run summary it claims
 * to describe. Adding them now costs nothing; adding them later means
 * migrating everything already stored.
 *
 * `course` was the third of those, and it is the one that came due. It says
 * *which run* was ridden, and unlike `seed` it is now read: the tables split on
 * course as well as difficulty, because Park and Classic are no more comparable
 * than cruise and original are. Everything filed before the field existed was
 * ridden on Classic, and is migrated to say so rather than being dropped.
 */

const KEY = 'alpine-carve.scores.v1';
const KEEP = 50;

/** The run every entry belongs to when nothing says otherwise. */
export const DEFAULT_COURSE = 'classic';

/**
 * Which table a row belongs in.
 *
 * Callers may pass either a bare difficulty name — which is what every caller
 * did before there was more than one course, and what a Classic-only caller
 * still reasonably means — or the full `{ course, difficulty }` pair.
 */
export function tableOf(where) {
  if (typeof where === 'string' || where == null) {
    return { course: DEFAULT_COURSE, difficulty: where ?? 'cruise' };
  }
  return {
    course: where.course ?? DEFAULT_COURSE,
    difficulty: where.difficulty ?? 'cruise',
  };
}

const tableKey = (row) => `${row.course ?? DEFAULT_COURSE}|${row.difficulty}`;

/** The shape every store speaks in. Anything missing is filled in here. */
export function makeEntry({
  name, score, timeMs, tricks = 0, topSpeed = 0, bestAir = 0,
  difficulty = 'cruise', course = DEFAULT_COURSE, seed = 0, finished = true,
}) {
  const entry = {
    name: String(name || 'RIDER').slice(0, 14),
    score: Math.max(0, Math.round(score)),
    timeMs: Math.max(0, Math.round(timeMs)),
    tricks: Math.round(tricks),
    topSpeed: +topSpeed.toFixed(2),
    bestAir: +bestAir.toFixed(2),
    difficulty,
    course,
    seed,
    finished,
    // Bumped when `course` joined the checksummed fields. The version is what
    // tells `checksum()` which field list a row was signed over, so a v1 row
    // that predates the course split still verifies as the v1 row it is.
    version: 2,
    createdAt: Date.now(),
  };
  entry.checksum = checksum(entry);
  return entry;
}

/**
 * A cheap hash over the fields that describe the run.
 *
 * This is not security — nothing running in the player's own browser can be —
 * and it is not pretending to be. It ties a submitted score to the rest of its
 * summary, so a server can at least reject a row whose numbers were edited
 * after the fact without being re-signed, and can tell an honest client's
 * payload from a hand-written one.
 */
function checksum(e) {
  const head = `${e.name}|${e.score}|${e.timeMs}|${e.tricks}|${e.difficulty}`;
  // Version 1 rows were signed before there was a course to sign. Rebuilding
  // their string the way it was built then is what lets a migrated row keep the
  // checksum it already has instead of being quietly invalidated by an upgrade.
  const s = e.version >= 2
    ? `${head}|${e.course}|${e.seed}|${e.version}`
    : `${head}|${e.seed}|${e.version}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Ranking order: score first, and a faster time breaks a tie.
 *
 * The run is scored rather than raced, so time is the tiebreak and never the
 * headline — but two identical scores are common enough (a clean run with the
 * same tricks) that leaving them in submission order looks arbitrary.
 */
function rank(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.timeMs - b.timeMs;
}

/* ------------------------------------------------------------------
 * Stores
 * ---------------------------------------------------------------- */

/**
 * The one that ships: the player's own browser.
 *
 * Kept per course *and* per difficulty, because CRUISE and ORIGINAL are
 * different games — the same rider scores far more on cruise, where the air is
 * longer and the landings forgive more — and because Classic and Park are
 * different mountains, with different amounts of scoreable furniture on them.
 * Mixing either pair into one table would make half the rows unreachable and
 * the comparison meaningless.
 */
export class LocalStore {
  constructor(key = KEY) {
    this.key = key;
  }

  _read() {
    try {
      const raw = localStorage.getItem(this.key);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return this._migrate(parsed);
    } catch {
      return []; // private browsing, a corrupted value, an embedded frame
    }
  }

  /**
   * Brings rows written before the course split up to date.
   *
   * There was exactly one mountain when they were filed, so every one of them
   * is a Classic run and gets stamped as such. The alternative — treating a
   * missing `course` as its own table, or dropping the rows — would either
   * strand somebody's whole history in a table with no name or throw away the
   * only thing on the title screen that makes them ride again.
   *
   * Written back the first time it happens, so this is a one-off cost rather
   * than something every read pays. The rows keep their `version: 1` and their
   * original checksum: they really were signed as v1 rows, and pretending
   * otherwise would be a lie a server could catch.
   */
  _migrate(rows) {
    let changed = false;
    for (const row of rows) {
      if (row && typeof row === 'object' && row.course === undefined) {
        row.course = DEFAULT_COURSE;
        changed = true;
      }
    }
    if (changed) this._write(rows);
    return rows;
  }

  _write(rows) {
    try {
      localStorage.setItem(this.key, JSON.stringify(rows));
    } catch {
      /* nothing worth interrupting the run for */
    }
  }

  async submit(entry) {
    const rows = this._read();
    rows.push(entry);
    // Trimmed per table rather than globally, or an afternoon in the park would
    // slowly evict every Classic run anybody had ever filed.
    const byTable = new Map();
    for (const row of rows) {
      const key = tableKey(row);
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key).push(row);
    }
    const kept = [];
    for (const group of byTable.values()) {
      group.sort(rank);
      kept.push(...group.slice(0, KEEP));
    }
    this._write(kept);
    return entry;
  }

  async top(where) {
    const { course, difficulty } = tableOf(where);
    return this._read()
      .filter((r) => r.difficulty === difficulty && (r.course ?? DEFAULT_COURSE) === course)
      .sort(rank);
  }

  async clear() {
    this._write([]);
  }
}

/**
 * The one that does not ship yet.
 *
 * Written now, unused and untested, so that the shape of the thing is fixed
 * while the local store is still the only caller. When there is a server, this
 * is what gets passed to the constructor.
 */
export class RemoteStore {
  constructor(url, { timeoutMs = 6000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async _fetch(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}${path}`, { ...init, signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async submit(entry) {
    return this._fetch('', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    });
  }

  async top(where) {
    const { course, difficulty } = tableOf(where);
    const q = new URLSearchParams({ course, difficulty, limit: String(KEEP) });
    return this._fetch(`?${q}`);
  }
}

/* ------------------------------------------------------------------
 * The board
 * ---------------------------------------------------------------- */

export class Leaderboard {
  constructor(store = new LocalStore()) {
    this.store = store;
  }

  /**
   * Files a run and says where it landed.
   *
   * Returns the rank, and whether it is the player's own best — which is what
   * the end-of-run screen actually wants to know. A store that throws (an
   * offline server, a full disk, private browsing) must never take the run
   * down with it: the score is still on screen either way.
   */
  async submit(fields) {
    const entry = makeEntry(fields);
    try {
      await this.store.submit(entry);
      const rows = await this.store.top({ course: entry.course, difficulty: entry.difficulty });
      const at = rows.findIndex((r) => r.checksum === entry.checksum && r.createdAt === entry.createdAt);
      const mine = rows.filter((r) => r.name === entry.name);
      return {
        entry,
        rank: at < 0 ? null : at + 1,
        total: rows.length,
        isTop10: at >= 0 && at < 10,
        isPersonalBest: mine.length > 0 && mine[0].createdAt === entry.createdAt,
        rows,
      };
    } catch {
      return { entry, rank: null, total: 0, isTop10: false, isPersonalBest: false, rows: [] };
    }
  }

  /**
   * The table, best first. Never throws — an empty board is a valid answer.
   *
   * `where` is a `{ course, difficulty }` pair, or a bare difficulty name for
   * the Classic table.
   */
  async top(where, limit = 10) {
    try {
      return (await this.store.top(where)).slice(0, limit);
    } catch {
      return [];
    }
  }

  /** Where a score *would* land, without filing it. */
  async rankOf(where, score) {
    const rows = await this.top(where, KEEP);
    const at = rows.findIndex((r) => r.score < score);
    return at < 0 ? rows.length + 1 : at + 1;
  }

  async clear(where) {
    if (this.store.clear) await this.store.clear(where);
  }
}
