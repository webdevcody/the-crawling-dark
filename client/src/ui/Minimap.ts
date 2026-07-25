/**
 * The Crawling Dark — radar minimap overlay (M15 · t15a).
 *
 * `Minimap` is the self-contained, top-right Canvas2D radar that keeps the
 * seeded town readable at a glance without ever leaving the play view. It draws
 * a player-CENTERED, north-up sweep of everything close by — the lake, the
 * street grid, building footprints, and every nearby body — recentred on the
 * LOCAL player each frame so the middle of the dish is always "you". It owns a
 * single fixed-position panel (a `<canvas>` wrapped in a dark, rounded,
 * translucent shell) that it appends to a container passed in the constructor
 * (the same `#app` div the renderer + HUD live in), styled to match the HUD /
 * audio-panel idioms and, like the HUD, left `pointer-events: none` so it sits
 * above the WebGL canvas without ever stealing clicks.
 *
 * The projection is deliberately simple and allocation-free: world (x, z) is
 * mapped to canvas pixels by translating relative to the local player and
 * scaling {@link RADAR_RANGE_M} meters onto the dish radius, with world **+Z
 * drawn downward** so that north (−Z) is up and yaw 0 points straight up the
 * screen. Everything is clipped to a circular dish; the local player is a bright
 * wedge pinned at the center pointing along the camera look yaw, other humans
 * are dim green blips, and zombies are red blips.
 *
 * {@link update} is safe to call every render frame: it does a full clear +
 * redraw (cheap for the handful of in-range features) but allocates nothing per
 * frame — it iterates `entities.values()` and `world.buildings` directly and
 * inlines the projection math rather than closing over per-object helpers.
 * Before the world exists, or before the local body has spawned, it degrades to
 * a faint "no signal" dish instead of throwing. Like the HUD it depends only on
 * the DOM + shared world/wire types (no Three.js), mirroring the render-agnostic
 * split the rest of the client's UI uses.
 */

import {
  MAP_SIZE,
  type World,
  type Building,
  type AABB,
  type Tree,
  type Lake,
  type Road,
} from '@crawling-dark/shared';
import type { InterpolatedEntity } from '../net/Interpolation';

/* -------------------------------------------------------------------------- */
/* Palette + tuning                                                           */
/* -------------------------------------------------------------------------- */

/** Hopeful green — the local player wedge and other survivors' blips. */
const GREEN = '#53ffa8';
/** Ominous red — zombie blips. */
const RED = '#ff6b6b';
/** Energetic amber — the north orientation tick on the range ring. */
const AMBER = '#ffd24a';
/** Calm slate — the resting HUD text color (reused for the "no signal" copy). */
const SLATE = '#c8d6e5';
/** Muted slate — placeholders and secondary marks. */
const DIM = '#7f8c9a';

/** Dark radar-screen fill drawn behind every feature inside the dish. */
const FACE = 'rgba(6, 12, 11, 0.55)';
/** Faint green sweep grid (crosshair + inner ring) under the features. */
const GRID = 'rgba(83, 255, 168, 0.08)';
/** Dark blue lake disc. */
const WATER = 'rgba(28, 62, 92, 0.85)';
/** Muted slate building footprints. */
const BUILDING = 'rgba(200, 214, 229, 0.26)';
/** Dim street lines. */
const ROAD = 'rgba(127, 140, 154, 0.32)';
/** Slightly dimmed green for OTHER humans (the local player stays full-bright). */
const HUMAN_BLIP = 'rgba(83, 255, 168, 0.72)';
/** The range-ring border color, matching the HUD panel border. */
const RING = 'rgba(58, 90, 106, 0.85)';

/** CSS pixel size (square) of the radar canvas. */
const RADAR_PX = 168;
/**
 * World radius, in meters, the dish shows around the local player. At ~44 m it
 * reaches roughly two thirds of the way to the {@link MAP_SIZE} town's edge from
 * the centre — a useful neighbourhood — without collapsing the whole map to a dot.
 */
const RADAR_RANGE_M = 44;
/** Pixels kept between the canvas edge and the range ring, so the stroke fits. */
const RING_INSET = 3;
/** Blip radius (CSS px) for other entities. */
const BLIP_R = 2.4;
/** Local-player wedge geometry (CSS px): tip length, tail set-back, half-width. */
const WEDGE_TIP = 7;
const WEDGE_BACK = 4;
const WEDGE_HALF = 4.5;

/** Full turn in radians (local shorthand for the many arc calls). */
const TAU = Math.PI * 2;

/* -------------------------------------------------------------------------- */
/* Minimap                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The top-right radar overlay. Construct it once with the container to mount
 * into (the same `#app` div the renderer + HUD use), call {@link update} once
 * per render frame with the current world + interpolated entities, and
 * {@link dispose} on teardown. {@link setVisible} / {@link toggle} hide the
 * panel (and short-circuit `update`) so it can be bound to a HUD key.
 */
export class Minimap {
  /** Rounded, translucent shell appended to the container; holds the canvas. */
  private readonly wrapper: HTMLDivElement;
  /** The radar canvas itself (backing store sized by {@link dpr}). */
  private readonly canvas: HTMLCanvasElement;
  /** Cached 2D context; its base transform is the current dpr scale. */
  private readonly ctx: CanvasRenderingContext2D;

  /** Device pixel ratio the backing store is currently sized for (0 = unset). */
  private dpr = 0;
  /** Whether the panel is shown; when false, {@link update} early-returns. */
  private shown = true;

  constructor(container: HTMLElement) {
    // Panel shell — mirrors the HUD / audio-panel look (dark, rounded, blurred),
    // pinned to the top-right and left click-through like the HUD so it never
    // intercepts pointer events meant for the interactive audio controls.
    this.wrapper = document.createElement('div');
    Object.assign(this.wrapper.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      padding: '6px',
      lineHeight: '0',
      background: 'rgba(5, 7, 10, 0.72)',
      border: '1px solid rgba(58, 90, 106, 0.5)',
      borderRadius: '6px',
      pointerEvents: 'none',
      userSelect: 'none',
      backdropFilter: 'blur(2px)',
    } satisfies Partial<CSSStyleDeclaration>);

    // The canvas draws in CSS pixels; the backing store is sized by dpr in
    // syncDpr() so the radar stays crisp on high-density displays.
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      display: 'block',
      width: `${RADAR_PX}px`,
      height: `${RADAR_PX}px`,
    } satisfies Partial<CSSStyleDeclaration>);

    const ctx = this.canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Minimap: 2D canvas context is unavailable');
    }
    this.ctx = ctx;

    this.wrapper.append(this.canvas);
    container.append(this.wrapper);

    // Size the backing store + install the base (dpr) transform for the first
    // time, so all drawing after this uses CSS-pixel coordinates.
    this.syncDpr();
  }

  /* ---- Per-frame update ------------------------------------------------- */

  /**
   * Redraw the radar for one frame. `world` / `localId` may be `null` before
   * they exist (pre-WELCOME / between rounds), and the local body may simply not
   * be in `entities` yet; in any of those cases the dish renders a faint "no
   * signal" look rather than throwing. `localYaw` is the camera look yaw in
   * radians (forward `= (−sin, −cos)` on the XZ plane), which orients the local
   * player wedge. Safe to call every frame — it clears + redraws but allocates
   * nothing, iterating `entities.values()` and `world.buildings` in place.
   */
  update(
    world: World | null,
    entities: Map<number, InterpolatedEntity>,
    localId: number | null,
    localYaw: number,
  ): void {
    if (!this.shown) return;

    // Re-sync the backing store first so moving the window between monitors of
    // different density stays crisp (a no-op when the ratio is unchanged).
    this.syncDpr();

    const ctx = this.ctx;
    const center = RADAR_PX / 2;
    const radius = center - RING_INSET;

    ctx.clearRect(0, 0, RADAR_PX, RADAR_PX);

    // Everything inside the dish is clipped to the circular face.
    ctx.save();
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, TAU);
    ctx.clip();

    // Radar-screen fill + faint sweep grid, drawn under the features.
    ctx.fillStyle = FACE;
    ctx.fillRect(0, 0, RADAR_PX, RADAR_PX);
    this.drawGrid(center, radius);

    const local = localId !== null ? entities.get(localId) : undefined;
    if (world === null || local === undefined) {
      // No world yet, or the local body hasn't spawned — show an empty dish.
      this.drawNoSignal(center);
      ctx.restore();
      this.drawRing(center, radius);
      return;
    }

    // Player-centred, north-up projection: scale RADAR_RANGE_M meters onto the
    // dish radius, translate relative to the local player, and draw +Z downward
    // so north (−Z) is up. Projection math is inlined below to avoid per-frame
    // closures over these locals.
    const px = local.x;
    const pz = local.z;
    const scale = radius / RADAR_RANGE_M; // px per meter
    const rangeSq = RADAR_RANGE_M * RADAR_RANGE_M;

    if (world.water !== null) {
      this.drawLake(world.water, px, pz, center, scale);
    }
    this.drawRoads(world.roads, px, pz, center, scale);
    this.drawBuildings(world.buildings, px, pz, center, scale);

    // Entity blips (skip the local body — it is the wedge at the center).
    for (const e of entities.values()) {
      if (e.id === localId) continue;
      const dx = e.x - px;
      const dz = e.z - pz;
      if (dx * dx + dz * dz > rangeSq) continue;
      ctx.fillStyle = e.kind === 'zombie' ? RED : HUMAN_BLIP;
      ctx.beginPath();
      ctx.arc(center + dx * scale, center + dz * scale, BLIP_R, 0, TAU);
      ctx.fill();
    }

    // Local player: a bright wedge pinned at the center, pointing along the look
    // yaw (world forward projects to canvas (−sin, −cos) — up at yaw 0).
    this.drawLocalWedge(center, localYaw);

    ctx.restore();

    // The range ring is stroked OUTSIDE the clip so its full width shows.
    this.drawRing(center, radius);
  }

  /* ---- Feature drawing (all in already-clipped dish space) ------------- */

  /** Faint crosshair + inner ring, the static radar "sweep grid" backdrop. */
  private drawGrid(center: number, radius: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(center - radius, center);
    ctx.lineTo(center + radius, center);
    ctx.moveTo(center, center - radius);
    ctx.lineTo(center, center + radius);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(center, center, radius * 0.5, 0, TAU);
    ctx.stroke();
  }

  /** Fill the lake as a dark blue disc, when any of it is in range. */
  private drawLake(
    water: Lake,
    px: number,
    pz: number,
    center: number,
    scale: number,
  ): void {
    const dx = water.cx - px;
    const dz = water.cz - pz;
    if (Math.hypot(dx, dz) - water.radius > RADAR_RANGE_M) return;
    const ctx = this.ctx;
    ctx.fillStyle = WATER;
    ctx.beginPath();
    ctx.arc(center + dx * scale, center + dz * scale, water.radius * scale, 0, TAU);
    ctx.fill();
  }

  /** Stroke the street polylines as thin dim lines; cull roads wholly in range. */
  private drawRoads(
    roads: Road[],
    px: number,
    pz: number,
    center: number,
    scale: number,
  ): void {
    const ctx = this.ctx;
    ctx.strokeStyle = ROAD;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const road of roads) {
      // Skip roads with no point anywhere near the dish (padded by width).
      const pad = RADAR_RANGE_M + road.width;
      let near = false;
      for (const p of road.points) {
        if (Math.abs(p.x - px) <= pad && Math.abs(p.z - pz) <= pad) {
          near = true;
          break;
        }
      }
      if (!near) continue;

      ctx.beginPath();
      for (let i = 0; i < road.points.length; i++) {
        const p = road.points[i];
        const sx = center + (p.x - px) * scale;
        const sz = center + (p.z - pz) * scale;
        if (i === 0) ctx.moveTo(sx, sz);
        else ctx.lineTo(sx, sz);
      }
      ctx.stroke();
    }
  }

  /** Fill each in-range building footprint as a small rect from its AABB. */
  private drawBuildings(
    buildings: Building[],
    px: number,
    pz: number,
    center: number,
    scale: number,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = BUILDING;
    for (const b of buildings) {
      // Cheap AABB-vs-range reject on each axis before touching the canvas.
      if (
        Math.abs(b.cx - px) - b.hw > RADAR_RANGE_M ||
        Math.abs(b.cz - pz) - b.hd > RADAR_RANGE_M
      ) {
        continue;
      }
      const aabb: AABB = {
        minX: b.cx - b.hw,
        maxX: b.cx + b.hw,
        minZ: b.cz - b.hd,
        maxZ: b.cz + b.hd,
      };
      const sx = center + (aabb.minX - px) * scale;
      const sz = center + (aabb.minZ - pz) * scale;
      ctx.fillRect(sx, sz, (aabb.maxX - aabb.minX) * scale, (aabb.maxZ - aabb.minZ) * scale);
    }
  }

  /** The bright local-player wedge at the dish center, pointing along `yaw`. */
  private drawLocalWedge(center: number, yaw: number): void {
    const ctx = this.ctx;
    // Canvas-space forward (up at yaw 0) and its left-hand perpendicular.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const nx = -fz;
    const nz = fx;

    ctx.fillStyle = GREEN;
    ctx.shadowColor = GREEN;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(center + fx * WEDGE_TIP, center + fz * WEDGE_TIP);
    ctx.lineTo(
      center - fx * WEDGE_BACK + nx * WEDGE_HALF,
      center - fz * WEDGE_BACK + nz * WEDGE_HALF,
    );
    ctx.lineTo(
      center - fx * WEDGE_BACK - nx * WEDGE_HALF,
      center - fz * WEDGE_BACK - nz * WEDGE_HALF,
    );
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  /* ---- Chrome (outside the dish clip) ---------------------------------- */

  /** The range-ring border plus a small amber north (up) orientation tick. */
  private drawRing(center: number, radius: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = RING;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, TAU);
    ctx.stroke();

    // North tick — a short amber notch at the top edge so the dish reads as
    // north-up at a glance.
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(center, center - radius);
    ctx.lineTo(center, center - radius + 5);
    ctx.stroke();
  }

  /** Faint centered "NO SIGNAL" copy for the pre-world / pre-spawn dish. */
  private drawNoSignal(center: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = DIM;
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO SIGNAL', center, center);
  }

  /* ---- Backing store + visibility -------------------------------------- */

  /**
   * Resize the backing store to the current device pixel ratio (a no-op while
   * unchanged) and reinstate the base transform so drawing keeps using CSS
   * pixels. Setting `canvas.width`/`height` resets context state, which is why
   * the transform is re-applied here.
   */
  private syncDpr(): void {
    const dpr = window.devicePixelRatio || 1;
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    this.canvas.width = Math.round(RADAR_PX * dpr);
    this.canvas.height = Math.round(RADAR_PX * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Show or hide the whole panel; hidden makes {@link update} a no-op. */
  setVisible(visible: boolean): void {
    this.shown = visible;
    this.wrapper.style.display = visible ? 'block' : 'none';
  }

  /** Flip the panel's visibility (for a HUD keybind). */
  toggle(): void {
    this.setVisible(!this.shown);
  }

  /** Whether the panel is currently shown. */
  get visible(): boolean {
    return this.shown;
  }

  /* ---- Teardown --------------------------------------------------------- */

  /** Detach the panel from the container. Idempotent. */
  dispose(): void {
    this.wrapper.remove();
  }
}
