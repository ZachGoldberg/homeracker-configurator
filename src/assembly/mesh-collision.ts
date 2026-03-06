import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { PlacedPart, GridPosition, Axis, Rotation3 } from "../types";
import type { AssemblyState } from "./AssemblyState";
import { getPartDefinition } from "../data/catalog";
import { getCustomPartGeometry, isCustomPart } from "../data/custom-parts";
import { getRegisteredGeometry } from "./geometry-registry";
import { orientationToRotation, rotateGridCells, transformCell, rotateAxis } from "./grid-utils";
import { BASE_UNIT } from "../constants";

export interface MeshCollisionResult {
  partIdA: string;
  partIdB: string;
  intersectionBBox: THREE.Box3;
}

// BVH cache keyed by definitionId
const bvhCache = new Map<string, MeshBVH>();

function getGeometryForPart(definitionId: string): THREE.BufferGeometry | undefined {
  if (isCustomPart(definitionId)) {
    return getCustomPartGeometry(definitionId);
  }
  return getRegisteredGeometry(definitionId);
}

function getBVH(definitionId: string): MeshBVH | undefined {
  let bvh = bvhCache.get(definitionId);
  if (bvh) return bvh;
  const geometry = getGeometryForPart(definitionId);
  if (!geometry) return undefined;
  bvh = new MeshBVH(geometry);
  bvhCache.set(definitionId, bvh);
  return bvh;
}

/** Clear cached BVH (call when a custom part geometry changes) */
export function clearBVHCache(definitionId?: string): void {
  if (definitionId) {
    bvhCache.delete(definitionId);
  } else {
    bvhCache.clear();
  }
}

function gridToWorld(pos: GridPosition): [number, number, number] {
  return [pos[0] * BASE_UNIT, pos[1] * BASE_UNIT + BASE_UNIT / 2, pos[2] * BASE_UNIT];
}

function modelCenterOffset(gridCells: GridPosition[], orientation: Axis = "y"): [number, number, number] {
  const cells = gridCells.map((c) => transformCell(c, orientation));
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const maxZ = Math.max(...cells.map((c) => c[2]));
  return [
    ((minX + maxX) / 2) * BASE_UNIT,
    ((minY + maxY) / 2) * BASE_UNIT,
    ((minZ + maxZ) / 2) * BASE_UNIT,
  ];
}

/**
 * Compute world matrix for a part, matching the Three.js scene graph nesting:
 *   group(worldPos) > group(offset) > group(partEuler) > [group(orientEuler) for GLB]
 *
 * For custom parts: worldPos + offset + partRotation (geometry already centered)
 * For GLB parts: worldPos + offset + partRotation + orientRotation
 */
function getPartWorldMatrix(part: PlacedPart): THREE.Matrix4 | undefined {
  const def = getPartDefinition(part.definitionId);
  if (!def) return undefined;

  const custom = isCustomPart(part.definitionId);
  const rotation: Rotation3 = part.rotation ?? [0, 0, 0];
  const orient: Axis = part.orientation ?? "y";

  // Compute offset: must match how ViewportCanvas computes it
  let offset: [number, number, number];
  if (custom) {
    const rotatedCells = rotateGridCells(def.gridCells, rotation);
    offset = modelCenterOffset(rotatedCells);
  } else {
    const orientedCells = def.gridCells.map((c) => transformCell(c, orient));
    const rotatedCells = rotateGridCells(orientedCells, rotation);
    offset = modelCenterOffset(rotatedCells);
  }

  const worldPos = gridToWorld(part.position);

  // Build matrix matching the scene graph nesting (outermost first):
  // worldPos -> offset -> partEuler -> [orientEuler for GLB]
  const partEuler = new THREE.Euler(
    (rotation[0] * Math.PI) / 180,
    (rotation[1] * Math.PI) / 180,
    (rotation[2] * Math.PI) / 180,
    "XYZ",
  );

  const mat = new THREE.Matrix4();

  if (!custom) {
    const orientRot = orientationToRotation(orient);
    const orientEuler = new THREE.Euler(
      (orientRot[0] * Math.PI) / 180,
      (orientRot[1] * Math.PI) / 180,
      (orientRot[2] * Math.PI) / 180,
      "XYZ",
    );
    mat.makeRotationFromEuler(orientEuler);
  }

  // Apply part rotation
  const partRotMat = new THREE.Matrix4().makeRotationFromEuler(partEuler);
  mat.premultiply(partRotMat);

  // Apply offset translation
  const offsetMat = new THREE.Matrix4().makeTranslation(offset[0], offset[1], offset[2]);
  mat.premultiply(offsetMat);

  // Apply world position
  const worldMat = new THREE.Matrix4().makeTranslation(worldPos[0], worldPos[1], worldPos[2]);
  mat.premultiply(worldMat);

  return mat;
}

/** Compute world-space AABB for a part's geometry */
function getPartWorldAABB(part: PlacedPart): THREE.Box3 | undefined {
  const geo = getGeometryForPart(part.definitionId);
  if (!geo) return undefined;
  const mat = getPartWorldMatrix(part);
  if (!mat) return undefined;

  geo.computeBoundingBox();
  const localBox = geo.boundingBox!.clone();
  localBox.applyMatrix4(mat);
  return localBox;
}

/**
 * Check if a pair of parts is a valid pull-through connection (connector + support
 * along matching axis). These intentionally overlap and should not be flagged.
 */
function isValidPullThroughPair(partA: PlacedPart, partB: PlacedPart): boolean {
  const defA = getPartDefinition(partA.definitionId);
  const defB = getPartDefinition(partB.definitionId);
  if (!defA || !defB) return false;

  // Check A=connector, B=support
  if (defA.category === "connector" && defA.pullThroughAxis && defB.category === "support") {
    const ptAxis = rotateAxis(defA.pullThroughAxis, partA.rotation ?? [0, 0, 0]);
    const supportAxis = partB.orientation ?? "y";
    if (ptAxis === supportAxis) return true;
  }

  // Check B=connector, A=support
  if (defB.category === "connector" && defB.pullThroughAxis && defA.category === "support") {
    const ptAxis = rotateAxis(defB.pullThroughAxis, partB.rotation ?? [0, 0, 0]);
    const supportAxis = partA.orientation ?? "y";
    if (ptAxis === supportAxis) return true;
  }

  return false;
}

/**
 * Full mesh collision detection.
 * Broad phase: world AABB overlap (catches boundary overlaps the grid misses).
 * Narrow phase: BVH intersectsGeometry for actual mesh intersection.
 * Clip region: intersection of the two parts' world AABBs (fast approximation).
 */
export function detectAllMeshCollisions(assembly: AssemblyState): MeshCollisionResult[] {
  const allParts = assembly.getAllParts();

  // Pre-compute world AABBs and matrices for all parts that have geometry
  const partData: { part: PlacedPart; aabb: THREE.Box3; mat: THREE.Matrix4 }[] = [];
  for (const part of allParts) {
    const aabb = getPartWorldAABB(part);
    const mat = getPartWorldMatrix(part);
    if (!aabb || !mat) continue;
    partData.push({ part, aabb, mat });
  }

  const results: MeshCollisionResult[] = [];

  // Check all pairs — AABB broad phase then BVH narrow phase
  for (let i = 0; i < partData.length; i++) {
    for (let j = i + 1; j < partData.length; j++) {
      const a = partData[i];
      const b = partData[j];

      // Broad phase: AABB overlap
      if (!a.aabb.intersectsBox(b.aabb)) continue;

      // Skip valid pull-through connections (connector + support along matching axis)
      if (isValidPullThroughPair(a.part, b.part)) continue;

      // Narrow phase: BVH mesh intersection
      const bvhB = getBVH(b.part.definitionId);
      const geoA = getGeometryForPart(a.part.definitionId);
      if (!bvhB || !geoA) continue;

      const matAToB = b.mat.clone().invert().multiply(a.mat);
      if (!bvhB.intersectsGeometry(geoA, matAToB)) continue;

      // Clip region: intersection of the two world AABBs
      const clipBox = a.aabb.clone().intersect(b.aabb);

      results.push({
        partIdA: a.part.instanceId,
        partIdB: b.part.instanceId,
        intersectionBBox: clipBox,
      });
    }
  }

  return results;
}
