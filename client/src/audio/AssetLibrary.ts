/**
 * The Crawling Dark — audio asset library (M12 · t12a).
 *
 * The {@link AudioEngine} synthesizes every sound from oscillators + filtered
 * noise because the game historically shipped **no audio files**. This library
 * adds the missing half: a small, offline-safe **sample path** so real recorded
 * one-shots and music can be dropped in and played, while any sound whose file
 * is absent transparently **falls back to the synth voice**.
 *
 * It is deliberately dumb and forgiving:
 *
 * - {@link load} fetches every URL in a manifest and {@link AudioContext.decodeAudioData
 *   decodes} it into an {@link AudioBuffer}, all in parallel. A fetch/decoding
 *   failure (offline build, missing file, unsupported codec) is **swallowed** —
 *   that name is simply left absent so the caller synth-falls-back. Nothing
 *   here ever throws into gameplay.
 * - {@link get} / {@link has} are synchronous lookups the audio hot-path uses to
 *   decide "real sample or synth?" without awaiting anything.
 *
 * URLs are resolved against Vite's {@link https://vitejs.dev/guide/build#public-base-path
 * BASE_URL} so a sub-path deploy still finds `client/public/audio/**`.
 */

/** A logical-name → URL map (URLs are relative to the app's `BASE_URL`). */
export type AudioManifest = Readonly<Record<string, string>>;

/**
 * Fetches + decodes a manifest of audio files into reusable {@link AudioBuffer}s,
 * degrading to "absent" (→ synth fallback) for anything that fails to load.
 */
export class AssetLibrary {
  /** Successfully decoded buffers, keyed by logical name. */
  private readonly buffers = new Map<string, AudioBuffer>();
  /** Names we've already tried (loaded or failed) so {@link load} is idempotent. */
  private readonly attempted = new Set<string>();
  /** App base path (e.g. `/` or `/game/`), used to resolve relative asset URLs. */
  private readonly base: string;

  constructor(base: string = importBaseUrl()) {
    // Normalize to exactly one trailing slash so joins never double up.
    this.base = base.endsWith('/') ? base : `${base}/`;
  }

  /**
   * Synchronously fetch a decoded buffer by name, or `undefined` if it never
   * loaded (absent file, decode error, or not yet loaded). Callers treat
   * `undefined` as "use the synth voice."
   */
  get(name: string): AudioBuffer | undefined {
    return this.buffers.get(name);
  }

  /** Whether a decoded buffer is available for `name`. */
  has(name: string): boolean {
    return this.buffers.has(name);
  }

  /** Number of buffers successfully loaded (handy for logging / a debug HUD). */
  get loadedCount(): number {
    return this.buffers.size;
  }

  /**
   * Fetch + decode every entry in `manifest` that hasn't been attempted yet,
   * all in parallel, storing the successes. Resolves once every entry has
   * settled; never rejects (per-file errors are swallowed). Safe to call more
   * than once and with overlapping manifests — already-tried names are skipped,
   * so later tasks (t12b–t12d) can register their own sounds incrementally.
   */
  async load(ctx: AudioContext, manifest: AudioManifest): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [name, url] of Object.entries(manifest)) {
      if (this.attempted.has(name)) continue;
      this.attempted.add(name);
      pending.push(this.loadOne(ctx, name, url));
    }
    if (pending.length > 0) await Promise.all(pending);
  }

  /** Fetch + decode a single asset; on any failure, leave it absent. */
  private async loadOne(ctx: AudioContext, name: string, url: string): Promise<void> {
    try {
      const res = await fetch(this.resolve(url));
      if (!res.ok) return; // 404 etc. — synth fallback.
      const bytes = await res.arrayBuffer();
      // `decodeAudioData` (promise form) rejects on unsupported/garbage data.
      const buffer = await ctx.decodeAudioData(bytes);
      this.buffers.set(name, buffer);
    } catch {
      // Offline build, blocked fetch, or an undecodable file: stay silent and
      // let the caller synth-fall-back. This MUST never throw into gameplay.
    }
  }

  /** Join a manifest URL onto the app base, tolerating a leading slash. */
  private resolve(url: string): string {
    if (/^https?:\/\//.test(url)) return url; // already absolute
    return this.base + url.replace(/^\/+/, '');
  }
}

/**
 * Read Vite's injected `BASE_URL` without hard-failing type-checks in non-Vite
 * contexts. Falls back to `'/'` when unavailable.
 */
function importBaseUrl(): string {
  // `import.meta.env` is Vite-injected; guard so this module stays importable
  // (and unit-testable) outside a Vite build.
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? '/';
}
