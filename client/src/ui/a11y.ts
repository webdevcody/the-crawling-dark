/**
 * The Crawling Dark — reduced-motion accessibility switch (M17 · t17d).
 *
 * This is the single switch every other UI module reads to decide whether to
 * play a non-essential animation. It folds two independent signals into one
 * boolean: the player's stored {@link Settings} `reducedMotion` preference and
 * the operating system's own `prefers-reduced-motion` media query. Either being
 * on means "reduce motion", so overlays, feeds, and transitions can gate their
 * flourishes on a single call to {@link prefersReducedMotion} rather than each
 * re-deriving the rule.
 *
 * Like {@link Settings}, this is a **pure helper**: it owns no DOM, mutates
 * nothing, and its OS read is fully guarded, so it is safe to call in any
 * environment — headless tests, SSR, or a browser without `matchMedia` — where
 * it simply reports the stored preference alone. Nothing here ever throws to its
 * caller.
 */

import type { Settings } from './Settings';

/**
 * Whether the UI should suppress non-essential motion — `true` when EITHER the
 * player has opted into reduced motion in {@link Settings} OR the operating
 * system signals `prefers-reduced-motion: reduce`. Callers gate overlay
 * fades/slides, feed slide-ins, and similar flourishes on this.
 */
export function prefersReducedMotion(settings: Settings): boolean {
  return settings.get('reducedMotion') || systemPrefersReducedMotion();
}

/**
 * Safely read the OS-level `prefers-reduced-motion: reduce` media query. Guarded
 * for environments where `window` / `matchMedia` is missing or throws (headless
 * tests, SSR, older browsers) — any failure degrades to `false` so the stored
 * preference alone decides.
 */
function systemPrefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false; // matchMedia absent or throwing — assume no OS preference.
  }
}
