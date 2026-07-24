/**
 * Shared wire/simulation types. Kept intentionally small in M0; later
 * milestones (protocol, snapshots) will extend this surface.
 */

/** A 3D vector in world space. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Which side an entity is currently on. */
export type Team = 'human' | 'zombie';
