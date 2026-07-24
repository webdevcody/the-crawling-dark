/**
 * The Crawling Dark — per-client interest management (M7 · t7c).
 *
 * "Interest management" is the classic MMO/shooter bandwidth optimization: a
 * client is only sent the entities it can plausibly perceive, so the far side of
 * the {@link MAP_SIZE} town is culled from its snapshot instead of every client
 * receiving the entire roster every broadcast. This module owns the pure culling
 * decision; the {@link Room} owns the per-viewer state and the broadcast plumbing.
 *
 * The cull is a flat distance test on the XZ (ground) plane around the viewer.
 * Two details make it feel seamless rather than poppy:
 *
 *  - **Self is never culled.** A viewer's own entity is always included so the
 *    client has its authoritative position/stamina every snapshot for prediction
 *    reconciliation and the HUD, no matter where it stands relative to the crowd.
 *
 *  - **Hysteresis.** An entity ENTERS interest at {@link INTEREST_RADIUS} but is
 *    only dropped once it recedes past {@link INTEREST_RADIUS} +
 *    {@link INTEREST_HYSTERESIS} (the outer radius). Tracking each viewer's
 *    currently-included id set lets an entity loitering on the boundary — or a
 *    viewer strafing across it — stay stable instead of flashing in and out of
 *    the snapshot every broadcast (which would rebuild its client rig each tick).
 *
 * The function is intentionally **pure**: it neither mutates the shared input
 * entity list (the same array is handed to every client) nor the `visible` set
 * it is given; it returns a fresh culled array plus a fresh updated id set for
 * the caller to store back on the viewer. Ids of entities that have vanished
 * from `all` (e.g. a disconnect) simply never make it into the new set, so stale
 * membership drops out on its own.
 */

import {
  INTEREST_RADIUS,
  INTEREST_HYSTERESIS,
  type EntitySnapshot,
} from '@crawling-dark/shared';

/** Inner "enter interest" radius, squared (compare against squared distance). */
const ENTER_RADIUS_SQ = INTEREST_RADIUS * INTEREST_RADIUS;

/** Outer "exit interest" radius, squared — the enter radius plus the hysteresis band. */
const EXIT_RADIUS_SQ =
  (INTEREST_RADIUS + INTEREST_HYSTERESIS) * (INTEREST_RADIUS + INTEREST_HYSTERESIS);

/** The culled list for one viewer plus the id set that produced it. */
export interface InterestResult {
  /** New array of just the entities this viewer should receive this snapshot. */
  entities: EntitySnapshot[];
  /**
   * New set of the ids kept in {@link entities} — the viewer's next
   * currently-visible set, to be stored back on the viewer and fed in as
   * `previouslyVisible` on the following broadcast so hysteresis carries over.
   */
  visible: Set<number>;
}

/**
 * Cull `all` down to just the entities within interest of a viewer at
 * (`viewerX`, `viewerZ`) on the XZ plane, applying enter/exit hysteresis against
 * the viewer's `previouslyVisible` id set and always keeping the viewer's own
 * `viewerId` entity.
 *
 * An entity is included when either:
 *  - it is the viewer itself (`entity.id === viewerId`), or
 *  - it was NOT visible last broadcast and now sits within the inner
 *    {@link INTEREST_RADIUS} (it just entered interest), or
 *  - it WAS visible last broadcast and still sits within the outer
 *    `INTEREST_RADIUS + INTEREST_HYSTERESIS` radius (it hasn't yet exited).
 *
 * @param all              Full authoritative entity list (NOT mutated).
 * @param viewerId         Entity id of the viewer, always included.
 * @param viewerX          Viewer world-space X (meters).
 * @param viewerZ          Viewer world-space Z (meters).
 * @param previouslyVisible Ids kept for this viewer last broadcast (NOT mutated).
 * @returns the culled entity array and the fresh visible-id set (see {@link InterestResult}).
 */
export function cullByInterest(
  all: EntitySnapshot[],
  viewerId: number,
  viewerX: number,
  viewerZ: number,
  previouslyVisible: Set<number>,
): InterestResult {
  const entities: EntitySnapshot[] = [];
  const visible = new Set<number>();

  for (const entity of all) {
    // The viewer always sees itself — its own authoritative state drives client
    // prediction/HUD every snapshot, independent of any radius.
    if (entity.id === viewerId) {
      entities.push(entity);
      visible.add(entity.id);
      continue;
    }

    const dx = entity.x - viewerX;
    const dz = entity.z - viewerZ;
    const distSq = dx * dx + dz * dz;

    // Hysteresis: a currently-visible entity holds interest out to the wider
    // exit radius; a new one must cross the tighter enter radius to appear.
    const threshold = previouslyVisible.has(entity.id) ? EXIT_RADIUS_SQ : ENTER_RADIUS_SQ;
    if (distSq <= threshold) {
      entities.push(entity);
      visible.add(entity.id);
    }
  }

  return { entities, visible };
}
