/**
 * The Crawling Dark — town renderer (M2 · t2a client view).
 *
 * Builds the visible town as Three.js box meshes directly from the shared,
 * seeded {@link World} data — the exact same {@link Building} list the
 * authoritative server collides players against. Because both sides derive the
 * town from one `mapSeed` (see the WELCOME message), what you see is precisely
 * what you collide with: no separate art data to drift out of sync.
 *
 * Buildings are plain lit boxes for now (M2 is a gameplay milestone); swapping
 * in GLTF town assets later (M6 polish) is purely a rendering change and never
 * touches collision, which only ever reads the AABB footprints.
 *
 * M9 (t9c) drops the bare perimeter wall slabs from the render: the dense
 * perimeter forest (see {@link scene/Environment}) now walls the map edge, so
 * drawing the old boundary boxes would only clip through the trees. The wall is
 * still enforced in shared collision — it is a position clamp, never a collider —
 * so hiding its meshes changes nothing about what the player runs into.
 */

import * as THREE from 'three';
import { buildingAABB, type Building, type World } from '@crawling-dark/shared';

/** Deterministic, muted facade color from a building id (golden-ratio hue). */
function facadeColor(id: number): THREE.Color {
  const hue = (id * 0.61803398875) % 1;
  // Low saturation + low lightness keeps the town brooding and readable in fog.
  return new THREE.Color().setHSL(hue, 0.18, 0.34);
}

/** A perimeter wall slab spans the full map half-extent on one axis. */
function isPerimeterWall(b: Building, world: World): boolean {
  return b.hw >= world.half || b.hd >= world.half;
}

/**
 * Build a {@link THREE.Group} of building meshes for `world`. The group is
 * returned (not added to any scene) so the caller controls insertion and, if a
 * round ever regenerates the town, disposal via {@link disposeTown}.
 */
export function buildTown(world: World): THREE.Group {
  const group = new THREE.Group();
  group.name = 'town';

  for (const b of world.buildings) {
    // M9 (t9c): the perimeter is now a wall of forest, so the bare boundary
    // slabs are no longer drawn — skip them (collision is unchanged, the wall
    // being a clamp in shared, not a mesh). Every real building still renders.
    if (isPerimeterWall(b, world)) continue;

    const aabb = buildingAABB(b);
    const width = aabb.maxX - aabb.minX;
    const depth = aabb.maxZ - aabb.minZ;
    const geometry = new THREE.BoxGeometry(width, b.height, depth);

    const material = new THREE.MeshStandardMaterial({
      color: facadeColor(b.id),
      roughness: 0.9,
      metalness: 0,
    });

    const mesh = new THREE.Mesh(geometry, material);
    // Box origin is centered; lift by half the height so the base sits on y = 0.
    mesh.position.set(b.cx, b.height / 2, b.cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}

/** Dispose every geometry/material under a town group (call before dropping it). */
export function disposeTown(group: THREE.Group): void {
  const seenMaterials = new Set<THREE.Material>();
  for (const child of group.children) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const mat = child.material as THREE.Material;
      if (!seenMaterials.has(mat)) {
        seenMaterials.add(mat);
        mat.dispose();
      }
    }
  }
}
