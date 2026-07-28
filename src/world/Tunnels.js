import * as THREE from 'three';
import { clamp, smoothstep } from '../core/mathx.js';

/**
 * Tunnels — an avalanche gallery bored through the mountain, and the atmosphere
 * that goes with it.
 *
 * This is spectacle, and only spectacle. A tunnel is not a hazard and cannot
 * become one: nothing here is ever consulted by `_checkHazards`, the roof has
 * no collision, and the bore is cut with more headroom than the rider can
 * reach off anything the course can build. The game's rule that almost nothing
 * but a tree square-on ends a run survives this feature untouched.
 *
 * What a tunnel *is* is a change of room. Three things move together as the
 * rider crosses a portal — the light drops, the fog closes in and darkens, and
 * the two continuous audio voices get a low-pass dragged down over them — all
 * driven by one number, `interiorAt(x, z)`, which is 0 in daylight and 1 deep
 * inside. That number is a smooth blend rather than a switch, because at 36 m/s
 * a hard cut at a plane is a visible pop.
 *
 * ---------------------------------------------------------------------------
 * The bore
 * ---------------------------------------------------------------------------
 * A tunnel follows the track: its axis is the centre line, so it bends with
 * `centerX(z)` and its cross-section is squared up to `trackTangent(z)`. The
 * section is a gallery arch — short vertical side walls up to a springline,
 * then an elliptical vault to the crown:
 *
 *        clearance(u) = wallHeight + (crown - wallHeight) * sqrt(1 - (u/hw)^2)
 *
 * so headroom is `crown` on the centre line, never less than `wallHeight`
 * anywhere inside, and falls to `wallHeight` only where the wall is — a dozen
 * metres outside the groomed corduroy.
 *
 * Those two numbers are a *starting shape*, not the built one:
 * `_raiseForHeadroom()` scales the section up until it clears the highest a
 * rider could get inside that particular span, which is what makes "no jump
 * lands you in the ceiling" a property of the code rather than a hope about
 * the numbers somebody typed into a preset. `tools/check-mechanics.mjs`
 * measures the real clearance and the real reach rather than trusting either.
 *
 * ---------------------------------------------------------------------------
 * Config (`tunnels` in `Runs.js`)
 * ---------------------------------------------------------------------------
 * Empty and inert on Classic. `Runs.js` holds the annotated defaults and is
 * the place to read about what each field does; `TUNNEL_DEFAULTS` below is
 * only the fallback for a caller building tunnels without a run preset.
 */

/* ------------------------------------------------------------------
 * Palette
 *
 * The interior shell is drawn with an unlit material and hand-shaded vertex
 * colours, on purpose: the lights are being dimmed to almost nothing by the
 * time the rider is inside, and a lit interior would go to solid black and
 * take the ribs, the walls and any sense of motion with it. Unlit plus fog
 * means the shape stays readable while everything that *should* go dark —
 * the rider, the board, the snow underfoot — still does.
 * ---------------------------------------------------------------- */

const VAULT_COLOR = new THREE.Color('#1d242e');   // the roof, out of the light
const WALL_COLOR = new THREE.Color('#2c3644');    // side walls, catching a little sky
const RIB_COLOR = new THREE.Color('#0d1219');     // the arch ribs
const MOUTH_COLOR = new THREE.Color('#8fa8bd');   // the lit lip right at a portal
const SHELL_COLOR = new THREE.Color('#9fb2c4');   // the outside of the structure
const SHELL_SNOW = new THREE.Color('#eef5fb');    // snow lying on top of it
const FACADE_COLOR = new THREE.Color('#6f8091');  // the portal wall itself

/** Fog and light deep inside, blended toward from the run's daylight values. */
const INTERIOR_FOG = new THREE.Color('#4d5a6b');

/** Portal collar: how far it stands proud of the bore, laterally, over the crown, and along z. */
const PORTAL_SIDE = 13;
const PORTAL_TOP = 6;
const PORTAL_REACH = 3.4;

/** Shell depth over the bore: thin at the springline, a drift of snow at the crown. */
const SHELL_MIN = 1.2;
const SHELL_DRIFT = 7;

/** Deterministic 0..1 from one number — enough jitter for a snow line, and no rng state. */
const hash1 = (n) => {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

export const TUNNEL_DEFAULTS = {
  enabled: false,
  spans: [],
  halfWidth: 28,
  wallHeight: 8,
  crown: 16,
  shoulder: 6,
  headroom: 6,
  jumpHeadroom: 19,
  ribSpacing: 9,
  blend: 30,
  fogDensity: 0.011,
  sunScale: 0.13,
  hemiScale: 0.42,
  fillScale: 1.5,
  muffleHz: 620,
  echo: 0.3,
};

/**
 * Builds every tunnel on a run.
 *
 * Deliberately shaped like `buildKickers()` and `buildRails()` — takes the
 * course, samples it along a span, hands back a group — with one addition:
 * the returned object also answers "am I inside one", which the game needs
 * every frame and which no mesh can be asked.
 *
 * @param {import('./Course.js').Course} course
 * @param {object} [config] the `tunnels` section of a run preset
 */
export function buildTunnels(course, config) {
  return new Tunnels(course, config);
}

export class Tunnels {
  constructor(course, config = {}) {
    this.course = course;
    const cfg = { ...TUNNEL_DEFAULTS, ...(config ?? {}) };
    this.config = cfg;

    /**
     * One record per bore. Every number a span leaves out falls back to the
     * run-wide value, so a preset can say `{ from: 900, to: 1050 }` and get a
     * sensible tunnel, or override the section per span for variety.
     */
    this.list = [];
    if (cfg.enabled) {
      for (const span of cfg.spans ?? []) {
        const from = span.from ?? 0;
        const to = span.to ?? from;
        if (!(to > from)) continue;
        const t = {
          from,
          to,
          halfWidth: span.halfWidth ?? cfg.halfWidth,
          wallHeight: span.wallHeight ?? cfg.wallHeight,
          crown: span.crown ?? cfg.crown,
          ribSpacing: span.ribSpacing ?? cfg.ribSpacing,
          // Half the blend sits outside the portal and half inside, so the
          // change is centred on the mouth rather than starting at it.
          blend: Math.min(span.blend ?? cfg.blend, (to - from) * 0.9),
          overJump: this._hasKicker(from, to),
        };
        this._raiseForHeadroom(t, cfg);
        this.list.push(t);
      }
    }

    this.group = new THREE.Group();
    this.group.name = 'tunnels';
    if (this.list.length) this._build();

    /* Live state. `interior` is what the world is currently dressed for;
     * `target` is what the rider's position says it should be. */
    this.interior = 0;
    this.target = 0;
    this._bound = null;
    this._daylight = null;
  }

  /**
   * Is there a kicker that could put a rider in the air inside this span?
   *
   * Reaches back sixty metres before the entrance, because a lip that far up
   * the hill still lands you well inside the bore.
   */
  _hasKicker(from, to) {
    for (const k of this.course.kickers ?? []) {
      if (k.z > from - 60 && k.z < to) return true;
    }
    return false;
  }

  /**
   * Guarantees headroom, by growing the arch rather than by trusting the
   * preset author to have thought about it.
   *
   * This is the whole safety argument for the feature. A tunnel is spectacle
   * and must never become a way to crash, so "is the ceiling high enough" is
   * not left as a number somebody types into `Runs.js` — it is enforced here,
   * against the span's own contents, every time a tunnel is built.
   *
   * The binding point is the *shoulder*: the outside edge of the corduroy plus
   * a few metres of powder, which is as far off the line as a rider can
   * plausibly be and still be doing anything like full speed. The arch only
   * gets taller from there inward, so clearing the shoulder clears everything
   * a jump can reach. If it does not clear, both `wallHeight` and `crown` are
   * scaled by the same factor, which raises the roof without changing the
   * proportions the section was authored with.
   *
   * `jumpHeadroom` is 19 m by default because 15.84 m is the highest a rider
   * can get above the snow anywhere on Classic — measured, at the 36 m/s
   * terminal speed of the `original` tuning, off the biggest kicker on the
   * mountain, with the ollie popped right at the lip. Three metres of margin
   * on top of that. A run with bigger kickers than Classic's should raise it,
   * and `tools/check-mechanics.mjs` measures the real reach rather than
   * trusting this paragraph.
   */
  _raiseForHeadroom(t, cfg) {
    const shoulder = this.course.trackHalfWidth + (cfg.shoulder ?? 6);
    const needed = t.overJump ? cfg.jumpHeadroom : cfg.headroom;
    t.shoulder = shoulder;
    t.headroom = needed;
    if (shoulder >= t.halfWidth) {
      // Pathologically narrow bore: the arch has no room to be an arch, so
      // there is nothing to scale. Leave it — `clearanceAt` still reports the
      // truth and the harness will say so.
      return;
    }
    const have = this.archHeight(t, shoulder);
    if (have >= needed) return;
    const scale = needed / Math.max(have, 0.001);
    t.wallHeight *= scale;
    t.crown *= scale;
  }

  /* ==================================================================
   * Queries — pure functions of position, so the harness can sample them
   * ================================================================== */

  /** The bore at `z`, or null when there is no tunnel over that stretch. */
  tunnelAt(z) {
    for (const t of this.list) {
      if (z >= t.from - t.blend && z <= t.to + t.blend) return t;
    }
    return null;
  }

  /**
   * Headroom of the arch above the bore's floor reference at a cross-track
   * offset `u`. Zero outside the bore's own half-width.
   */
  archHeight(t, u) {
    const au = Math.abs(u);
    if (au >= t.halfWidth) return 0;
    const s = au / t.halfWidth;
    return t.wallHeight + (t.crown - t.wallHeight) * Math.sqrt(1 - s * s);
  }

  /**
   * The floor the arch is measured from: the terrain on the centre line at
   * this z. Sampling one point rather than the ground under `x` keeps the
   * section a clean straight arch instead of inheriting the powder's lumps.
   */
  floorAt(t, z) {
    return this.course.terrainHeight(this.course.centerX(z), z);
  }

  /** World height of the roof directly above a position, or Infinity outside. */
  roofHeightAt(x, z) {
    for (const t of this.list) {
      if (z < t.from || z > t.to) continue;
      const h = this.archHeight(t, this.course.trackOffset(x, z));
      if (h <= 0) continue;
      return this.floorAt(t, z) + h;
    }
    return Infinity;
  }

  /**
   * Metres between the ridable ground and the roof. `Infinity` where there is
   * no roof — which is what makes "there is no ceiling to hit here" and "there
   * is loads of room here" the same answer to callers.
   *
   * This is the number the harness asserts on, and it is measured against
   * `groundHeight`, kickers included, rather than against the arch's own floor
   * reference — a ramp under the roof eats headroom and has to show up here.
   */
  clearanceAt(x, z) {
    const roof = this.roofHeightAt(x, z);
    if (!Number.isFinite(roof)) return Infinity;
    return roof - this.course.groundHeight(x, z);
  }

  /**
   * How much of the tunnel's atmosphere applies at a position: 0 in open
   * daylight, 1 deep inside.
   *
   * Smooth and monotonic across a portal by construction — one smoothstep in
   * on the way through the entrance, one smoothstep out at the exit — and
   * faded sideways so a rider who has wandered a long way off the piste at the
   * mouth of a tunnel is not standing in the dark on an open slope.
   */
  interiorAt(x, z) {
    let best = 0;
    for (const t of this.list) {
      const half = t.blend * 0.5;
      const enter = smoothstep(t.from - half, t.from + half, z);
      const leave = 1 - smoothstep(t.to - half, t.to + half, z);
      let f = enter * leave;
      if (f <= 0) continue;
      const au = Math.abs(this.course.trackOffset(x, z));
      f *= 1 - smoothstep(t.halfWidth, t.halfWidth + 10, au);
      best = Math.max(best, f);
    }
    return best;
  }

  /** True when the rider is under a roof at all — handy for HUD and debugging. */
  isInside(x, z) {
    return this.interiorAt(x, z) > 0.5;
  }

  /* ==================================================================
   * Ambience
   * ================================================================== */

  /**
   * Hands the tunnels the three things they dim: the scene's fog, the lighting
   * rig and the audio. Captures the daylight values *once*, at bind time, so
   * the restore is always back to what the run was actually built with rather
   * than to a constant that could drift.
   */
  bind({ scene, lights, audio }) {
    this._bound = { scene, lights, audio };
    this._daylight = {
      fogColor: scene.fog ? scene.fog.color.clone() : new THREE.Color(),
      fogDensity: scene.fog?.density ?? 0,
      sun: lights?.sun?.intensity ?? 0,
      hemi: lights?.hemi?.intensity ?? 0,
      fill: lights?.fill?.intensity ?? 0,
    };
    this._apply(0);
    return this;
  }

  /**
   * Per frame. `interior` chases the position's own factor rather than
   * snapping to it, which costs nothing and covers the one case the positional
   * blend cannot: a rescue or a respawn that moves the rider tens of metres in
   * a single frame.
   */
  update(dt, position) {
    if (!this.list.length) return;
    this.target = this.interiorAt(position.x, position.z);
    // ~60 ms to close most of a gap. Fast enough that riding through at speed
    // is governed by the positional blend, slow enough to swallow a teleport.
    const k = 1 - Math.exp(-dt / 0.06);
    this.interior += (this.target - this.interior) * k;
    if (Math.abs(this.target - this.interior) < 0.0005) this.interior = this.target;
    this._apply(this.interior);
  }

  /**
   * Back to full daylight, immediately and unconditionally.
   *
   * Called from `Game.reset()`. Restarting a run from inside a tunnel used to
   * be the obvious way to leave the world dark and the audio muffled for the
   * whole of the next descent: the rider teleports to the gate, but nothing
   * had told the atmosphere about it.
   */
  reset() {
    this.interior = 0;
    this.target = 0;
    this._apply(0);
  }

  _apply(amount) {
    const b = this._bound;
    if (!b || !this._daylight) return;
    const d = this._daylight;
    const cfg = this.config;
    const a = clamp(amount, 0, 1);

    if (b.scene?.fog) {
      b.scene.fog.color.copy(d.fogColor).lerp(INTERIOR_FOG, a);
      b.scene.fog.density = d.fogDensity + (cfg.fogDensity - d.fogDensity) * a;
    }
    if (b.lights) {
      // The sun goes almost all the way out — it is behind a hillside — while
      // the sky fill only halves, so the interior reads as shadow rather than
      // as night, and the fill is *raised* to keep the rider legible.
      if (b.lights.sun) b.lights.sun.intensity = d.sun * (1 + (cfg.sunScale - 1) * a);
      if (b.lights.hemi) b.lights.hemi.intensity = d.hemi * (1 + (cfg.hemiScale - 1) * a);
      if (b.lights.fill) b.lights.fill.intensity = d.fill * (1 + (cfg.fillScale - 1) * a);
    }
    b.audio?.setMuffle?.(a, cfg.muffleHz, cfg.echo);
  }

  /* ==================================================================
   * Geometry
   * ================================================================== */

  _build() {
    const inner = new Shell();
    const outer = new Shell();

    for (const t of this.list) {
      this._buildBore(t, inner, outer);
      this._buildPortal(t, t.from, -1, outer);
      this._buildPortal(t, t.to, 1, outer);
    }

    // Interior: unlit, so it survives the lights being taken away, and drawn
    // from the inside only.
    const innerMesh = inner.mesh(
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: true })
    );
    innerMesh.name = 'tunnel-bore';
    innerMesh.frustumCulled = false;   // a 150 m arch you are standing inside
    this.group.add(innerMesh);

    // Exterior: an ordinary lit surface, because from outside it is a
    // snow-covered concrete gallery in full sun like everything else.
    const outerMesh = outer.mesh(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.85,
        metalness: 0,
        side: THREE.DoubleSide,
      })
    );
    outerMesh.name = 'tunnel-shell';
    outerMesh.castShadow = true;
    outerMesh.receiveShadow = true;
    this.group.add(outerMesh);
  }

  /**
   * The bore: a swept arch, sampled along z and around the section.
   *
   * Two surfaces come out of one sweep — the inner face the rider sees from
   * under it, and an outer shell lifted by `THICKNESS` so the structure has
   * substance where it breaks out of the hillside.
   */
  _buildBore(t, inner, outer) {
    const SECTION = 26;                       // segments round the arch
    const zStep = 4;
    const steps = Math.max(8, Math.round((t.to - t.from) / zStep));

    const ringInner = [];
    const ringOuter = [];
    const shadeInner = [];
    const shadeOuter = [];

    for (let i = 0; i <= steps; i++) {
      const z = t.from + ((t.to - t.from) * i) / steps;
      const cx = this.course.centerX(z);
      const tan = this.course.trackTangent(z);
      const px = tan.z;                        // perpendicular, skier's right
      const pz = -tan.x;
      const floor = this.floorAt(t, z);

      // Ribs every `ribSpacing` metres. They are the only thing in the bore
      // that moves relative to the rider, and they are what turns a dark
      // tube into a sense of speed.
      const ribPhase = Math.abs(((z - t.from) / t.ribSpacing) % 1 - 0.5) * 2;
      const rib = 1 - smoothstep(0.62, 0.96, ribPhase);

      // Daylight reaching in from either mouth. Deliberately short and weak:
      // the first version washed the first thirty metres almost to the snow's
      // own colour, which made the side walls invisible against the slope and
      // let the chairlift beyond them read as if it ran through the roof.
      const fromEnds = Math.min(z - t.from, t.to - z);
      const mouth = 1 - smoothstep(0, 12, fromEnds);

      const rowI = [];
      const rowO = [];
      const shI = [];
      const shO = [];
      for (let j = 0; j <= SECTION; j++) {
        const s = j / SECTION;
        // Parametrised so the section starts on the ground at the left wall,
        // runs up the wall, over the vault, and back down the right.
        const { u, y, nx, ny } = this._sectionPoint(t, s);
        const x = cx + px * u;
        const zz = z + pz * u;
        rowI.push(new THREE.Vector3(x, floor + y, zz));

        // The shell is thin down at the walls and deep over the crown, which
        // is the whole silhouette: a snow drift lying along the back of the
        // gallery, standing proud of the portal collars at either end. A
        // constant-thickness shell instead gave a bare grey pipe with a fat
        // grey ring stuck on each end, and read as plumbing.
        const up = clamp(y / t.crown, 0, 1);
        const thick = SHELL_MIN + (SHELL_DRIFT - SHELL_MIN) * smoothstep(0.3, 1, up);
        rowO.push(new THREE.Vector3(x + px * nx * thick, floor + y + ny * thick, zz + pz * nx * thick));

        // Vault dark, walls a touch lighter, ribs darker still, and the whole
        // section washed toward daylight near a mouth.
        const col = WALL_COLOR.clone().lerp(VAULT_COLOR, smoothstep(0.3, 0.8, up));
        col.lerp(RIB_COLOR, rib * 0.8);
        col.lerp(MOUTH_COLOR, mouth * 0.25);
        shI.push(col);

        const outCol = SHELL_COLOR.clone().lerp(SHELL_SNOW, smoothstep(0.3, 0.75, up));
        shO.push(outCol);
      }
      ringInner.push(rowI);
      ringOuter.push(rowO);
      shadeInner.push(shI);
      shadeOuter.push(shO);
    }

    inner.strip(ringInner, shadeInner);
    outer.strip(ringOuter, shadeOuter);
  }

  /**
   * A point on the arch section at parameter `s` in 0..1, plus the outward
   * normal of the surface there.
   *
   * The first and last tenth of `s` are the two vertical side walls; the rest
   * is the vault. Splitting it explicitly rather than using a single ellipse
   * keeps the walls straight, which is what makes the section read as built
   * rather than as a pipe.
   */
  _sectionPoint(t, s) {
    const WALL_SPAN = 0.1;
    if (s < WALL_SPAN) {
      const k = s / WALL_SPAN;
      return { u: -t.halfWidth, y: k * t.wallHeight, nx: -1, ny: 0 };
    }
    if (s > 1 - WALL_SPAN) {
      const k = (1 - s) / WALL_SPAN;
      return { u: t.halfWidth, y: k * t.wallHeight, nx: 1, ny: 0 };
    }
    // Vault: a half-ellipse from the left springline over to the right.
    const k = (s - WALL_SPAN) / (1 - 2 * WALL_SPAN);
    const theta = Math.PI * (1 - k);
    const u = t.halfWidth * Math.cos(theta);
    const rise = t.crown - t.wallHeight;
    const y = t.wallHeight + rise * Math.sin(theta);
    // Normal of the ellipse, which is not the radius unless it is a circle.
    const nx = Math.cos(theta) / t.halfWidth;
    const ny = Math.sin(theta) / Math.max(rise, 0.001);
    const len = Math.hypot(nx, ny) || 1;
    return { u, y, nx: nx / len, ny: ny / len };
  }

  /**
   * The collar the bore breaks out of at each end.
   *
   * Without one, a bore is a floating arch and the entrance does not read at
   * all until the rider is already in it. The collar is a second, larger arch
   * concentric with the first, so the portal is a ring of masonry around a
   * genuine hole rather than a slab with a hole painted on it — and because
   * both rows are walked with the same section parameter, the quads between
   * them stay well-formed the whole way round.
   *
   * The first version used a plain rectangular boundary instead. It gave every
   * portal a twenty-metre vertical cliff either side of the arch, which from
   * the approach read as a dam across the piste rather than as something bored
   * through a shoulder of the mountain.
   *
   * It projects `OVERHANG` metres past the span, which is what casts the hard
   * shadow that makes an approaching portal legible from three hundred metres.
   */
  _buildPortal(t, z, sign, shell) {
    // Coarser than the bore. The interior wants to be a smooth vault; the
    // portal wants facets, because everything else standing on this mountain
    // — the peaks, the trees, the kickers — is faceted.
    const SECTION = 16;

    const cx = this.course.centerX(z);
    const tan = this.course.trackTangent(z);
    const px = tan.z;
    const pz = -tan.x;
    const floor = this.floorAt(t, z);

    const at = (u, y, along) => new THREE.Vector3(
      cx + px * u + tan.x * along,
      floor + y,
      z + pz * u + tan.z * along
    );

    // The enlarged section, as a stand-in tunnel record so the same
    // `_sectionPoint` walks it. Its feet sit on the snow either side of the
    // bore's own, which is what makes the ring look like it is holding the
    // hillside back.
    const collar = {
      halfWidth: t.halfWidth + PORTAL_SIDE,
      wallHeight: t.wallHeight + PORTAL_SIDE * 0.5,
      crown: t.crown + PORTAL_TOP,
    };

    const front = sign * PORTAL_REACH;
    const archFront = [];
    const collarFront = [];
    const archBack = [];
    const collarBack = [];
    const shadeRim = [];
    const shadeBank = [];
    const shadeSoffitIn = [];
    const shadeSoffitOut = [];
    const shadeSkin = [];

    for (let j = 0; j <= SECTION; j++) {
      const s = j / SECTION;
      const arch = this._sectionPoint(t, s);
      const wide = this._sectionPoint(collar, s);

      // Ragged, not perfect. The ring is snow heaped over a portal, and a
      // mathematically exact outer arc reads as a moulded concrete donut —
      // which is precisely what the first version looked like. Pushing each
      // vertex a different fraction of the way out breaks the silhouette
      // without moving the opening a millimetre.
      const jag = 0.6 + 0.55 * hash1(j * 7.31 + z * 0.043);
      const bound = {
        u: arch.u + (wide.u - arch.u) * jag,
        y: arch.y + (wide.y - arch.y) * jag,
      };

      archFront.push(at(arch.u, arch.y, front));
      collarFront.push(at(bound.u, bound.y, front));
      archBack.push(at(arch.u, arch.y, 0));
      collarBack.push(at(bound.u, bound.y, 0));

      // The ring is shaded *across* its width rather than up its height: a
      // narrow band of concrete right at the lip of the arch, and everything
      // outside that is the snow bank piled over the portal. Shading it by
      // height instead gave a uniform grey donut sitting on a white slope,
      // which read as plumbing rather than as a way through a mountain.
      const up = clamp(bound.y / collar.crown, 0, 1);
      shadeRim.push(FACADE_COLOR.clone());
      shadeBank.push(SHELL_SNOW.clone().lerp(SHELL_COLOR, 0.35 * (1 - up)));
      shadeSoffitIn.push(RIB_COLOR.clone().lerp(FACADE_COLOR, 0.22));
      shadeSoffitOut.push(FACADE_COLOR.clone().lerp(RIB_COLOR, 0.35));
      shadeSkin.push(SHELL_COLOR.clone().lerp(SHELL_SNOW, smoothstep(0.4, 0.95, up)));
    }

    // The face of the ring, looking back up the hill at an approaching rider.
    shell.quadStrip(archFront, collarFront, shadeRim, shadeBank);
    // Its soffit — the underside of the overhang, and what reads as depth.
    shell.quadStrip(archBack, archFront, shadeSoffitIn, shadeSoffitOut);
    // And its outer skin, so the collar has thickness from the side too.
    shell.quadStrip(collarBack, collarFront, shadeSkin, shadeSkin);
  }

  /**
   * Plan-view footprint of a tunnel and its portal collars, with a margin.
   *
   * `Game` feeds this into the forest's exclusion test, for the plain reason
   * that a spruce growing through the roof of a tunnel looks like a bug. It is
   * a *scatter* filter and nothing more — no collision, no hazard, no effect
   * on any run whose preset has no tunnels on it, which is what keeps
   * Classic's forest digest bit-for-bit what it was.
   */
  covers(x, z, pad = 3) {
    if (!this.list.length) return false;
    for (const t of this.list) {
      if (z < t.from - PORTAL_REACH - pad || z > t.to + PORTAL_REACH + pad) continue;
      if (Math.abs(this.course.trackOffset(x, z)) <= t.halfWidth + PORTAL_SIDE + pad) return true;
    }
    return false;
  }
}

/* ------------------------------------------------------------------
 * A tiny geometry accumulator.
 *
 * Both surfaces are quad grids, so rather than repeating the index arithmetic
 * three times this collects rows of points and colours and does it once.
 * ---------------------------------------------------------------- */
class Shell {
  constructor() {
    this.positions = [];
    this.colors = [];
    this.indices = [];
  }

  _push(v, c) {
    const i = this.positions.length / 3;
    this.positions.push(v.x, v.y, v.z);
    this.colors.push(c.r, c.g, c.b);
    return i;
  }

  /** A grid of rows: `rows[i][j]` is a vertex, stitched into quads. */
  strip(rows, shades) {
    const base = this.positions.length / 3;
    const cols = rows[0].length;
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < cols; j++) this._push(rows[i][j], shades[i][j]);
    }
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = base + i * cols + j;
        this.indices.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }
  }

  /** Two matched rows of points, stitched edge to edge. */
  quadStrip(rowA, rowB, shadeA, shadeB) {
    const base = this.positions.length / 3;
    for (let j = 0; j < rowA.length; j++) {
      this._push(rowA[j], shadeA[j]);
      this._push(rowB[j], shadeB[j]);
    }
    for (let j = 0; j < rowA.length - 1; j++) {
      const a = base + j * 2;
      this.indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }

  mesh(material) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }
}
