import type { GridPosition, Axis, Rotation3 } from "../types";
import type { AssemblyState } from "./AssemblyState";
import { getPartDefinition } from "../data/catalog";
import { rotateAxis } from "./grid-utils";
import { detectAllMeshCollisions, type MeshCollisionResult } from "./mesh-collision";

/**
 * Returns collision cells grouped by part instance ID.
 * Each entry maps a part ID to the list of absolute grid positions
 * where that part collides with another.
 */
export function detectCollisionCellsPerPart(assembly: AssemblyState): Map<string, GridPosition[]> {
  const result = new Map<string, GridPosition[]>();

  for (const [key, ids] of assembly.gridOccupancy) {
    if (ids.length < 2) continue;
    if (isValidPullThroughCell(ids, assembly)) continue;

    const [x, y, z] = key.split(",").map(Number);
    const cell: GridPosition = [x, y, z];

    for (const id of ids) {
      let cells = result.get(id);
      if (!cells) {
        cells = [];
        result.set(id, cells);
      }
      cells.push(cell);
    }
  }

  return result;
}

/**
 * A cell is a valid pull-through overlap if it contains exactly one
 * pull-through connector and one or more supports, and the connector's
 * effective PT axis matches each support's orientation.
 */
function isValidPullThroughCell(ids: string[], assembly: AssemblyState): boolean {
  let ptConnectorCount = 0;
  let ptAxis: Axis | null = null;
  let supportCount = 0;
  let otherCount = 0;

  for (const id of ids) {
    const part = assembly.getPartById(id);
    if (!part) { otherCount++; continue; }
    const def = getPartDefinition(part.definitionId);
    if (!def) { otherCount++; continue; }

    if (def.category === "connector" && def.pullThroughAxis) {
      ptConnectorCount++;
      const rotation: Rotation3 = part.rotation ?? [0, 0, 0];
      ptAxis = rotateAxis(def.pullThroughAxis, rotation);
    } else if (def.category === "support") {
      supportCount++;
      const supportOrientation: Axis = part.orientation ?? "y";
      // We'll verify axis match below
      if (ptAxis !== null && supportOrientation !== ptAxis) return false;
    } else {
      otherCount++;
    }
  }

  if (otherCount > 0 || ptConnectorCount !== 1 || supportCount === 0) return false;

  // Re-verify all supports match the PT axis (in case ptAxis was set after a support was checked)
  for (const id of ids) {
    const part = assembly.getPartById(id);
    if (!part) continue;
    const def = getPartDefinition(part.definitionId);
    if (!def || def.category !== "support") continue;
    const supportOrientation: Axis = part.orientation ?? "y";
    if (supportOrientation !== ptAxis) return false;
  }

  return true;
}

/**
 * Full collision detection: grid broad-phase + mesh narrow-phase.
 * Returns mesh collision results with intersection AABBs per colliding pair.
 */
export function detectMeshCollisionsForAssembly(assembly: AssemblyState): MeshCollisionResult[] {
  return detectAllMeshCollisions(assembly);
}

export type { MeshCollisionResult };
