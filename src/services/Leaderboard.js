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
 */

const KEY = 'alpine-carve.scores.v1';
const KEEP = 50;

/** The shape every store speaks in. Anything missing is filled in here. */
export function makeEntry({
  name, score, timeMs, tricks = 0, topSpeed = 0, bestAir = 0,
  difficulty = 'cruise', seed = 0, finished = true,
}) {
  const entry = {
    name: String(name || 'RIDER').slice(0, 14),
    score: Math.max(0, Math.round(score)),
    timeMs: Math.max(0, Math.round(timeMs)),
    tricks: Math.round(tricks),
    topSpeed: +topSpeed.toFixed(2),
    bestAir: +bestAir.toFixed(2),
    difficulty,
    seed,
    finished,
    version: 1,
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
  const s = `${e.name}|${e.score}|${e.timeMs}|${e.tricks}|${e.difficulty}|${e.seed}|${e.version}`;
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
 * Kept per difficulty, because CRUISE and ORIGINAL are different games — the
 * same rider scores far more on cruise, where the air is longer and the
 * landings forgive more, and mixing them into one table would make the
 * original's rows unreachable and the comparison meaningless.
 */
export class LocalStore {
  constructor(key = KEY) {
    this.key = key;
  }

  _read() {
    try {
      const raw = localStorage.getItem(this.key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; // private browsing, a corrupted value, an embedded frame
    }
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
    // Trimmed per difficulty rather than globally, or a good run on one would
    // slowly evict the whole table of the other.
    const byDifficulty = new Map();
    for (const row of rows) {
      if (!byDifficulty.has(row.difficulty)) byDifficulty.set(row.difficulty, []);
      byDifficulty.get(row.difficulty).push(row);
    }
    const kept = [];
    for (const group of byDifficulty.values()) {
      group.sort(rank);
      kept.push(...group.slice(0, KEEP));
    }
    this._write(kept);
    return entry;
  }

  async top(difficulty) {
    return this._read().filter((r) => r.difficulty === difficulty).sort(rank);
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

  async top(difficulty) {
    return this._fetch(`?difficulty=${encodeURIComponent(difficulty)}&limit=${KEEP}`);
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
      const rows = await this.store.top(entry.difficulty);
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

  /** The table, best first. Never throws — an empty board is a valid answer. */
  async top(difficulty, limit = 10) {
    try {
      return (await this.store.top(difficulty)).slice(0, limit);
    } catch {
      return [];
    }
  }

  /** Where a score *would* land, without filing it. */
  async rankOf(difficulty, score) {
    const rows = await this.top(difficulty, KEEP);
    const at = rows.findIndex((r) => r.score < score);
    return at < 0 ? rows.length + 1 : at + 1;
  }

  async clear(difficulty) {
    if (this.store.clear) await this.store.clear(difficulty);
  }
}
