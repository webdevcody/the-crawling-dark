/**
 * The Crawling Dark — pooled GPU particle system (M14 · t14b client).
 *
 * A single, FIXED-CAPACITY particle pool rendered as ONE {@link THREE.Points}
 * (one draw call for every spark, spore, and dust puff in flight). It backs the
 * game's short-lived impact/infection/footstep bursts: bat hits spit
 * {@link Particles.sparks}, infection coughs up {@link Particles.spores}, and
 * footfalls/landings kick up {@link Particles.dust}.
 *
 * The whole system is allocation-free in steady state. Every buffer — the GPU
 * attributes (position / color / size) and the CPU-side simulation arrays
 * (velocity, ttl, gravity, drag, base color/size) — is preallocated once at
 * {@link MAX_PARTICLES} capacity in the constructor. Live particles are packed
 * into the FRONT of those buffers and a running {@link Particles.count} tracks
 * how many are alive, so {@link Particles.update} can `setDrawRange(0, count)`
 * for a tight draw and reap dead particles with a cheap swap-remove. Spawning and
 * reaping only write scalars into the existing arrays; nothing is ever `new`'d
 * per spawn or per frame.
 *
 * Rendering notes:
 *  - A small custom {@link THREE.ShaderMaterial} is used rather than
 *    {@link THREE.PointsMaterial} specifically because `PointsMaterial` cannot
 *    read a PER-VERTEX size (its `size` is one global uniform), and the three
 *    emitters deliberately differ in scale (tiny sparks vs. fatter spores). The
 *    shader reads the per-particle `size` attribute and reproduces the same
 *    perspective size-attenuation `PointsMaterial` does (`gl_PointSize ∝
 *    size * bufferHeight / -viewZ`); the `scale` uniform it needs is refreshed
 *    from the live drawing-buffer height in {@link THREE.Object3D.onBeforeRender}
 *    (allocation-free, resize-safe), so the class needs nothing but the scene.
 *  - Particles are soft round discs, not squares: the point is textured with a
 *    radial-gradient sprite built ONCE as a {@link THREE.CanvasTexture} (opaque
 *    white core fading to transparent at the rim).
 *  - Blending is ADDITIVE with `depthWrite:false`, so the pool never sorts and
 *    reads as glow. There is no per-vertex alpha channel, so FADE-OUT is encoded
 *    by scaling each particle's per-vertex COLOR toward black as its ttl decays:
 *    under additive blending a dimming color IS a fade to nothing. Depth TEST is
 *    left on so particles are still occluded by geometry in front of them.
 */

import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Capacity & shared tunables                                                  */
/* -------------------------------------------------------------------------- */

/** Hard pool capacity. Bursts that would exceed this are dropped silently. */
const MAX_PARTICLES = 512;

/** 2π, cached so emitters can pick a random heading without recomputing it. */
const TAU = Math.PI * 2;

/** Side length (px) of the one-off soft-sprite texture. Small is plenty for a blurry disc. */
const SPRITE_TEX_SIZE = 64;

/** Tiny spawn-position jitter (meters) so a burst doesn't start as one coincident dot. */
const SPAWN_JITTER = 0.1;

/** Default for the size-attenuation `scale` uniform until the first render refreshes it. */
const DEFAULT_SCALE = 500;

/* -------------------------------------------------------------------------- */
/* Spark burst — warm bat-impact sparks (driven by `stun` events)              */
/* -------------------------------------------------------------------------- */

/** Sparks per {@link Particles.sparks} burst. */
const SPARK_COUNT = 14;
/** Spark lifetime (ms) — a fast, snappy pop. */
const SPARK_TTL = 350;
/** Downward accel (m/s²) so sparks arc and fall within their short life. */
const SPARK_GRAVITY = 11;
/** Linear velocity damping (per second) — sparks shed speed as they fly. */
const SPARK_DRAG = 1.5;

/* -------------------------------------------------------------------------- */
/* Spore burst — sickly-green infection spores (driven by `infect` events)     */
/* -------------------------------------------------------------------------- */

/** Spores per {@link Particles.spores} burst — the densest cloud of the three. */
const SPORE_COUNT = 24;
/** Spore lifetime (ms) — a slow, lingering drift. */
const SPORE_TTL = 900;
/** Barely-there gravity so spores hang and waft rather than fall. */
const SPORE_GRAVITY = 0.6;
/** Gentle damping so the outward puff eases into a hover. */
const SPORE_DRAG = 0.7;
/** Sickly infection green. Split to normalized rgb once, below. */
const SPORE_COLOR = 0x76ff5a;
const SPORE_R = ((SPORE_COLOR >> 16) & 0xff) / 255;
const SPORE_G = ((SPORE_COLOR >> 8) & 0xff) / 255;
const SPORE_B = (SPORE_COLOR & 0xff) / 255;

/* -------------------------------------------------------------------------- */
/* Dust burst — grey/brown footstep & landing puffs                            */
/* -------------------------------------------------------------------------- */

/** Dust motes per {@link Particles.dust} burst — a small, cheap scuff. */
const DUST_COUNT = 8;
/** Dust lifetime (ms) — brief. */
const DUST_TTL = 500;
/** Moderate gravity so the puff sinks back down. */
const DUST_GRAVITY = 3;
/** Heavy damping so dust "settles" quickly instead of drifting off. */
const DUST_DRAG = 3.5;

/* -------------------------------------------------------------------------- */
/* Soft round sprite                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build the soft particle sprite ONCE: a radial gradient from an opaque white
 * core to a fully transparent rim, painted onto a small canvas. Multiplied by
 * the per-vertex color in the fragment shader, this turns every point into a
 * soft glowing disc instead of a hard GL square. Grayscale, so texture color
 * space is irrelevant. Built at construction, never per frame.
 */
function makeSoftSprite(): THREE.CanvasTexture {
  const n = SPRITE_TEX_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Particles: 2D canvas context unavailable for sprite');

  const c = n / 2;
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0.0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.65)');
  gradient.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, n, n);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* -------------------------------------------------------------------------- */
/* Shaders                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader. `position` / `modelViewMatrix` / `projectionMatrix` are provided
 * by three's ShaderMaterial prefix; `color` and `size` are our per-particle
 * attributes. `gl_PointSize` reproduces PointsMaterial's perspective attenuation
 * (`size * scale / -viewZ`, `scale` = half the drawing-buffer height), clamped so
 * a particle right on the lens can't blow up to a full-screen quad.
 */
const VERTEX_SHADER = `
  uniform float scale;
  attribute vec3 color;
  attribute float size;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(size * (scale / -mvPosition.z), 1.0, 128.0);
  }
`;

/**
 * Fragment shader. Samples the soft sprite at `gl_PointCoord` and multiplies its
 * rgb by the (fade-dimmed) per-vertex color. The sprite's own alpha shapes the
 * disc; under additive blending the framebuffer contribution is `rgb * a`, so a
 * color dimmed toward black by {@link Particles.update} reads as a clean fade-out.
 */
const FRAGMENT_SHADER = `
  uniform sampler2D map;
  varying vec3 vColor;
  void main() {
    vec4 tex = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vColor * tex.rgb, tex.a);
  }
`;

/* -------------------------------------------------------------------------- */
/* Particle pool                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The pooled particle system. Construct with the scene (the {@link THREE.Points}
 * is built and added for you), fire bursts with {@link Particles.sparks} /
 * {@link Particles.spores} / {@link Particles.dust}, advance the simulation once
 * per render frame with {@link Particles.update}, and free everything with
 * {@link Particles.dispose}.
 */
export class Particles {
  /** The single points cloud — owned here, added to / removed from the scene by us. */
  private readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly sprite: THREE.CanvasTexture;
  private readonly scene: THREE.Scene;

  /* GPU attribute buffers (packed: live particles occupy [0, count)). */
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;

  /* CPU-side simulation state, one entry per particle slot, preallocated. */
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly vz = new Float32Array(MAX_PARTICLES);
  private readonly ttl = new Float32Array(MAX_PARTICLES); // ms remaining
  private readonly maxTtl = new Float32Array(MAX_PARTICLES); // ms at birth (fade divisor)
  private readonly gy = new Float32Array(MAX_PARTICLES); // per-particle gravity (m/s²)
  private readonly drag = new Float32Array(MAX_PARTICLES); // per-particle damping (per second)
  private readonly baseR = new Float32Array(MAX_PARTICLES);
  private readonly baseG = new Float32Array(MAX_PARTICLES);
  private readonly baseB = new Float32Array(MAX_PARTICLES);
  private readonly baseSize = new Float32Array(MAX_PARTICLES);

  /** Count of live particles, all packed into slots [0, count). */
  private count = 0;

  /** Scratch for reading the drawing-buffer size each render — reused, never re-created. */
  private readonly bufSize = new THREE.Vector2();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.sprite = makeSoftSprite();

    // Preallocate every GPU attribute at full capacity; DynamicDrawUsage hints the
    // driver these buffers are re-uploaded often.
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3);
    this.sizeAttr = new THREE.BufferAttribute(this.sizes, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setAttribute('size', this.sizeAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.sprite },
        scale: { value: DEFAULT_SCALE },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'particles';
    // Particles roam far from the (stale) initial bounding sphere, so skip culling
    // rather than recompute bounds every frame.
    this.points.frustumCulled = false;
    // Refresh the size-attenuation scale from the true drawing-buffer height right
    // before each draw. This closure is created once (not per frame) and reuses the
    // scratch Vector2, so it allocates nothing at render time.
    this.points.onBeforeRender = (renderer: THREE.WebGLRenderer): void => {
      renderer.getDrawingBufferSize(this.bufSize);
      this.material.uniforms.scale.value = this.bufSize.y * 0.5;
    };

    this.scene.add(this.points);
  }

  /**
   * Warm bat-impact sparks: ~{@link SPARK_COUNT} fast, small motes flung outward
   * and upward from (x, y, z), colored orange→warm-white, that arc down under
   * {@link SPARK_GRAVITY} and wink out in {@link SPARK_TTL} ms. Drops silently if
   * the pool is full. Driven by `stun` events.
   */
  sparks(x: number, y: number, z: number): void {
    for (let k = 0; k < SPARK_COUNT; k++) {
      if (this.count >= MAX_PARTICLES) break;
      const a = Math.random() * TAU;
      const h = 1.5 + Math.random() * 3.0; // horizontal speed
      const t = Math.random(); // 0 = orange, 1 = warm white
      this.spawn(
        x,
        y,
        z,
        Math.cos(a) * h,
        2.0 + Math.random() * 3.5,
        Math.sin(a) * h,
        SPARK_TTL,
        1.0,
        0.6 + t * 0.35,
        0.2 + t * 0.5,
        0.04 + Math.random() * 0.03,
        SPARK_GRAVITY,
        SPARK_DRAG,
      );
    }
    this.markSpawned();
  }

  /**
   * Sickly-green infection spores: ~{@link SPORE_COUNT} slightly-fat soft motes
   * that puff gently outward and rise from (x, y, z), hang on almost no gravity,
   * and dissolve over {@link SPORE_TTL} ms. Drops silently if the pool is full.
   * Driven by `infect` events.
   */
  spores(x: number, y: number, z: number): void {
    for (let k = 0; k < SPORE_COUNT; k++) {
      if (this.count >= MAX_PARTICLES) break;
      const a = Math.random() * TAU;
      const h = 0.2 + Math.random() * 0.7; // gentle outward drift
      const m = 0.8 + Math.random() * 0.2; // per-spore brightness jitter
      this.spawn(
        x,
        y,
        z,
        Math.cos(a) * h,
        0.4 + Math.random() * 0.8,
        Math.sin(a) * h,
        SPORE_TTL,
        SPORE_R * m,
        SPORE_G * m,
        SPORE_B * m,
        0.1 + Math.random() * 0.06,
        SPORE_GRAVITY,
        SPORE_DRAG,
      );
    }
    this.markSpawned();
  }

  /**
   * Grey/brown ground dust: ~{@link DUST_COUNT} low puff motes kicked outward and
   * slightly up from (x, y, z) that settle fast under {@link DUST_GRAVITY} +
   * heavy {@link DUST_DRAG}, gone in {@link DUST_TTL} ms. Drops silently if the
   * pool is full. For footsteps and landings.
   */
  dust(x: number, y: number, z: number): void {
    for (let k = 0; k < DUST_COUNT; k++) {
      if (this.count >= MAX_PARTICLES) break;
      const a = Math.random() * TAU;
      const h = 0.3 + Math.random() * 0.8; // low outward scuff
      const v = Math.random(); // grey↔brown jitter
      this.spawn(
        x,
        y,
        z,
        Math.cos(a) * h,
        0.3 + Math.random() * 0.6,
        Math.sin(a) * h,
        DUST_TTL,
        0.4 + v * 0.15,
        0.36 + v * 0.13,
        0.3 + v * 0.12,
        0.07 + Math.random() * 0.05,
        DUST_GRAVITY,
        DUST_DRAG,
      );
    }
    this.markSpawned();
  }

  /**
   * Write one particle into the next free slot ({@link Particles.count}) and grow
   * the live count. Callers must guard `count < MAX_PARTICLES` first (the emitters
   * do, and stop the burst when full). All arguments are primitives written
   * straight into the preallocated buffers — no object or array is created. A tiny
   * position jitter breaks up coincident spawns. Born at full brightness (fade 1).
   */
  private spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    ttlMs: number,
    r: number,
    g: number,
    b: number,
    size: number,
    gravity: number,
    drag: number,
  ): void {
    const i = this.count++;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.ttl[i] = ttlMs;
    this.maxTtl[i] = ttlMs;
    this.gy[i] = gravity;
    this.drag[i] = drag;
    this.baseR[i] = r;
    this.baseG[i] = g;
    this.baseB[i] = b;
    this.baseSize[i] = size;

    const b3 = i * 3;
    this.positions[b3] = x + (Math.random() - 0.5) * SPAWN_JITTER;
    this.positions[b3 + 1] = y + (Math.random() - 0.5) * SPAWN_JITTER;
    this.positions[b3 + 2] = z + (Math.random() - 0.5) * SPAWN_JITTER;
    this.colors[b3] = r;
    this.colors[b3 + 1] = g;
    this.colors[b3 + 2] = b;
    this.sizes[i] = size;
  }

  /**
   * After a burst, widen the draw range to cover the new particles and flag all
   * three attributes for re-upload. Called once per emitter call (batched over the
   * whole burst), never per particle.
   */
  private markSpawned(): void {
    this.geometry.setDrawRange(0, this.count);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }

  /**
   * Advance the simulation by `dtMs` milliseconds: apply per-particle gravity and
   * linear drag, integrate position from velocity, decay ttl, and dim each
   * particle's color toward black by its remaining-life fraction (the fade). Dead
   * particles are swap-removed — overwritten by the last live particle so the live
   * set stays packed in [0, count) — then the draw range is tightened. Only the
   * attributes that actually changed are flagged for upload. Allocates nothing.
   */
  update(dtMs: number): void {
    if (this.count === 0) return;

    const dt = dtMs / 1000;
    let reaped = false;
    let i = 0;

    while (i < this.count) {
      const life = this.ttl[i] - dtMs;
      if (life <= 0) {
        // Reap: overwrite this slot with the last live particle, shrink the count,
        // and re-process the same index (it now holds the swapped-in survivor).
        const last = this.count - 1;
        if (i !== last) this.copyParticle(last, i);
        this.count--;
        reaped = true;
        continue;
      }
      this.ttl[i] = life;

      // Gravity, then damping (clamped so a large dt can't reverse the velocity).
      this.vy[i] -= this.gy[i] * dt;
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= damp;
      this.vy[i] *= damp;
      this.vz[i] *= damp;

      // Integrate position.
      const b3 = i * 3;
      this.positions[b3] += this.vx[i] * dt;
      this.positions[b3 + 1] += this.vy[i] * dt;
      this.positions[b3 + 2] += this.vz[i] * dt;

      // Fade: color = base * (remaining life fraction). Additive blend ⇒ dim = gone.
      const f = life / this.maxTtl[i];
      this.colors[b3] = this.baseR[i] * f;
      this.colors[b3 + 1] = this.baseG[i] * f;
      this.colors[b3 + 2] = this.baseB[i] * f;

      i++;
    }

    this.geometry.setDrawRange(0, this.count);
    // Position and color changed for every live particle this frame.
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    // Size only changed if a reap moved a survivor's size into a lower slot.
    if (reaped) this.sizeAttr.needsUpdate = true;
  }

  /**
   * Move every piece of a particle's state from slot `from` to slot `to` (both CPU
   * simulation arrays and the GPU attribute buffers). Used by the swap-remove reap
   * in {@link Particles.update}; pure scalar copies, no allocation.
   */
  private copyParticle(from: number, to: number): void {
    this.vx[to] = this.vx[from];
    this.vy[to] = this.vy[from];
    this.vz[to] = this.vz[from];
    this.ttl[to] = this.ttl[from];
    this.maxTtl[to] = this.maxTtl[from];
    this.gy[to] = this.gy[from];
    this.drag[to] = this.drag[from];
    this.baseR[to] = this.baseR[from];
    this.baseG[to] = this.baseG[from];
    this.baseB[to] = this.baseB[from];
    this.baseSize[to] = this.baseSize[from];

    const bf = from * 3;
    const bt = to * 3;
    this.positions[bt] = this.positions[bf];
    this.positions[bt + 1] = this.positions[bf + 1];
    this.positions[bt + 2] = this.positions[bf + 2];
    this.colors[bt] = this.colors[bf];
    this.colors[bt + 1] = this.colors[bf + 1];
    this.colors[bt + 2] = this.colors[bf + 2];
    this.sizes[to] = this.sizes[from];
  }

  /** Remove the points from the scene and dispose its geometry, material, and sprite. */
  dispose(): void {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
    this.sprite.dispose();
  }
}
