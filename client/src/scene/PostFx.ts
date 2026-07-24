/**
 * The Crawling Dark — client post-processing pipeline (M14 · t14a).
 *
 * Wraps three's {@link EffectComposer} in a small, self-contained class so
 * {@link main} can swap its single `renderer.render(scene, camera)` call for a
 * `postFx.render(dtMs)` call and get the whole horror grade for free. The chain
 * is intentionally short — four passes, one custom shader — so the cost over a
 * plain forward render stays modest on the mid-range GPUs this game targets:
 *
 *   RenderPass → UnrealBloomPass → HorrorPass (custom) → OutputPass
 *
 *   - {@link RenderPass} draws the scene into an OFFSCREEN linear buffer.
 *   - {@link UnrealBloomPass} blooms ONLY the brightest emissive sources (moon
 *     disc, lamp bulbs, lit windows, combat VFX) thanks to a high luminosity
 *     threshold — the dark town itself stays crisp, only the hot pixels glow.
 *   - {@link HORROR_SHADER} (one {@link ShaderPass}) adds the mood grade:
 *     a radial vignette, subtle animated film grain, and a slight cold
 *     desaturation — all cheap, single-tap operations.
 *   - {@link OutputPass} performs the FINAL tone-map + sRGB encode to the canvas.
 *
 * -------------------------------------------------------------------------- *
 * COLOR PIPELINE — do NOT double tone-map (preserves M11 · t11c).
 * -------------------------------------------------------------------------- *
 * `main.ts` configures the renderer once with
 * `toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = 1.2` and
 * `outputColorSpace = SRGBColorSpace`. This class deliberately NEVER touches any
 * of those — it relies on a key WebGLRenderer detail: tone-mapping and the sRGB
 * encode are applied ONLY when a material draws to the SCREEN (the null render
 * target). Every pass here except the last renders to an offscreen buffer, so
 * the scene stays in its raw LINEAR signal all the way through bloom and the
 * HorrorPass — which is exactly why those operate on linear color and must NOT
 * tone-map. {@link OutputPass} is the one pass that writes to the canvas; it
 * reads the renderer's `toneMapping` / `toneMappingExposure` / `outputColorSpace`
 * and applies the ACES curve + sRGB encode there, once. Tone-mapping inside the
 * HorrorPass would apply the filmic curve a SECOND time and wash the night out —
 * so keep the HorrorPass purely a linear-space grade.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/* -------------------------------------------------------------------------- */
/* Bloom tunables                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Luminosity threshold above which a pixel starts to bloom. Kept HIGH so only
 * genuinely bright emissive sources (the moon disc, lamp bulbs, lit windows and
 * combat VFX) glow — the dark, ambient-lit town reads sharp and never smears.
 */
const BLOOM_THRESHOLD = 0.85;

/** Overall bloom intensity. Modest, so glows feel like a haze, not a light-leak. */
const BLOOM_STRENGTH = 0.6;

/** Bloom spread across the mip chain. Small, for a tight halo around hot sources. */
const BLOOM_RADIUS = 0.4;

/* -------------------------------------------------------------------------- */
/* HorrorPass tunables                                                         */
/* -------------------------------------------------------------------------- */

/** How dark the frame edges get (0 = none, 1 = edges to black). */
const VIGNETTE_STRENGTH = 0.55;
/** Radius (in UV units from center) where the vignette begins to fall off. */
const VIGNETTE_INNER = 0.25;
/** Radius (in UV units from center) where the vignette reaches full darkness. */
const VIGNETTE_OUTER = 0.78;

/** Peak amplitude of the animated film grain. Subtle — a faint, nervous shimmer. */
const GRAIN_INTENSITY = 0.05;

/** How far color is pulled toward grey for a cold, drained horror look. */
const DESATURATION = 0.12;

/**
 * Format a JS number as a GLSL float literal (always with a decimal point), so
 * the tunable consts above are the SINGLE source of truth and get baked straight
 * into the shader — no matching magic numbers to drift out of sync in the GLSL.
 */
function glslFloat(n: number): string {
  const s = String(n);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

/**
 * The custom combined horror grade, expressed as a plain shader definition that
 * {@link ShaderPass} compiles into a full-screen material. Vignette + grain +
 * desaturation are folded into ONE fragment shader (rather than three chained
 * passes) so the whole grade is a single extra full-screen draw.
 *
 * `uTime` (seconds) is the only per-frame uniform — it seeds the grain so it
 * animates. Everything else is a baked const. All work is done on the LINEAR
 * signal (see the file header); OutputPass finishes the frame — this shader must
 * not tone-map.
 */
const HORROR_SHADER = {
  name: 'HorrorPass',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float uTime;

    varying vec2 vUv;

    // Baked grade constants (see PostFx.ts tunables).
    const float VIGNETTE_STRENGTH = ${glslFloat(VIGNETTE_STRENGTH)};
    const float VIGNETTE_INNER    = ${glslFloat(VIGNETTE_INNER)};
    const float VIGNETTE_OUTER    = ${glslFloat(VIGNETTE_OUTER)};
    const float GRAIN_INTENSITY   = ${glslFloat(GRAIN_INTENSITY)};
    const float DESATURATION      = ${glslFloat(DESATURATION)};

    // Cheap value-noise hash — a couple of fract/dot ops, no textures.
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb;

      // 1) Cold desaturation: pull slightly toward luma for a drained palette.
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(color, vec3(luma), DESATURATION);

      // 2) Animated film grain: zero-mean hash noise, re-seeded each frame by
      //    time so it crawls. fract(uTime) keeps the seed bounded for precision.
      float grain = hash(vUv * 1024.0 + fract(uTime) * 100.0) - 0.5;
      color += grain * GRAIN_INTENSITY;

      // 3) Radial vignette: bright at center, darkening toward the edges. The
      //    reversed smoothstep edges (OUTER > INNER) give 1.0 at the center and
      //    0.0 in the corners.
      float dist = distance(vUv, vec2(0.5));
      float v = smoothstep(VIGNETTE_OUTER, VIGNETTE_INNER, dist);
      color *= mix(1.0 - VIGNETTE_STRENGTH, 1.0, v);

      gl_FragColor = vec4(color, texel.a);
    }
  `,
};

/* -------------------------------------------------------------------------- */
/* PostFx                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The client post-processing pipeline. Own one per renderer/scene/camera trio.
 *
 * Integration (main.ts):
 *   - construct once after the renderer/scene/camera exist;
 *   - replace `renderer.render(scene, camera)` in the frame loop with
 *     `postFx.render(dtMs)`;
 *   - call `postFx.setSize(width, height)` from `onResize`;
 *   - call `postFx.dispose()` on teardown.
 *
 * Toggle {@link PostFx.enabled} off to bypass the composer entirely and fall
 * back to a plain forward render (useful for A/B or low-end fallback).
 */
export class PostFx {
  /**
   * When `false`, {@link PostFx.render} bypasses the composer and does a plain
   * `renderer.render(scene, camera)` — no bloom, no grade.
   */
  enabled = true;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;

  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly horrorPass: ShaderPass;
  private readonly outputPass: OutputPass;

  /** Cached grain-time uniform, so {@link PostFx.render} never walks the chain. */
  private readonly uTime: { value: number };
  /** Accumulated grain time in seconds (advanced by `dtMs` each frame). */
  private grainTimeS = 0;

  /** Reused for size queries — keeps {@link PostFx.setSize} allocation-free. */
  private readonly scratchSize = new THREE.Vector2();

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    // Size the bloom pass's mip chain to the current drawing-buffer resolution;
    // setSize() keeps it in sync afterwards.
    const size = renderer.getDrawingBufferSize(this.scratchSize);

    this.composer = new EffectComposer(renderer);

    this.renderPass = new RenderPass(scene, camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.horrorPass = new ShaderPass(HORROR_SHADER);
    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.horrorPass);
    this.composer.addPass(this.outputPass);

    this.uTime = this.horrorPass.uniforms['uTime'];

    // Match the renderer's DPR + logical size up front.
    renderer.getSize(this.scratchSize);
    this.setSize(this.scratchSize.x, this.scratchSize.y);
  }

  /**
   * Render one frame through the composer, advancing the grain animation by
   * `dtMs` (milliseconds). Replaces `renderer.render(scene, camera)`.
   *
   * Allocation-free: writes one uniform scalar then draws — no per-frame objects.
   * When {@link PostFx.enabled} is `false`, falls back to a plain forward render.
   */
  render(dtMs: number): void {
    if (!this.enabled) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.grainTimeS += dtMs * 0.001;
    this.uTime.value = this.grainTimeS;
    this.composer.render();
  }

  /**
   * Resize the composer (and every pass) to a new logical size. Call from
   * `onResize`. Re-syncs the pixel ratio too, so the offscreen buffers track the
   * canvas at the renderer's current DPR.
   */
  setSize(width: number, height: number): void {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  /**
   * Release GPU resources: the composer's internal render targets + copy pass,
   * then each pass's own targets / materials.
   */
  dispose(): void {
    this.composer.dispose();
    this.renderPass.dispose();
    this.bloomPass.dispose();
    this.horrorPass.material.dispose();
    this.outputPass.dispose();
  }
}
