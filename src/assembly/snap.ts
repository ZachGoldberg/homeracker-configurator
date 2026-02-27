import type { GridPosition, Axis, Direction } from "../types";
import type { AssemblyState } from "./AssemblyState";
import { getPartDefinition } from "../data/catalog";
import { getAdjacentPosition, directionToAxis, getWorldCells } from "./grid-utils";

export interface SnapCandidate {
  /** Grid position where the support origin should be placed */
  position: GridPosition;
  /** Orientation the support should have to align with the socket */
  orientation: Axis;
  /** The connector instance ID that provides this snap point */
  connectorInstanceId: string;
  /** The socket direction on the connector */
  socketDirection: Direction;
  /** Euclidean distance (grid units) from cursor position */
  distance: number;
}

/**
 * Find all available snap points for a given support definition,
 * based on connectors currently in the assembly.
 *
 * Algorithm:
 * 1. Iterate all placed connectors
 * 2. For each connector, iterate its female connection points
 * 3. For each socket, compute the adjacent cell in that direction
 * 4. Determine orientation from socket's axis
 * 5. Compute support origin position (accounting for which end connects)
 * 6. Verify all orientation-transformed cells are unoccupied
 * 7. Return sorted by distance from cursor
 */
export function findSnapPoints(
  assembly: AssemblyState,
  supportDefId: string,
  cursorGridPos: GridPosition,
  maxDistance: number = 3,
): SnapCandidate[] {
  const supportDef = getPartDefinition(supportDefId);
  if (!supportDef || supportDef.category !== "support") return [];

  const candidates: SnapCandidate[] = [];
  const supportLength = supportDef.gridCells.length;

  for (const part of assembly.getAllParts()) {
    const partDef = getPartDefinition(part.definitionId);
    if (!partDef || partDef.category !== "connector") continue;

    for (const cp of partDef.connectionPoints) {
      if (cp.type !== "female") continue;

      // World position of the socket (connector position + offset)
      const socketWorldPos: GridPosition = [
        part.position[0] + cp.offset[0],
        part.position[1] + cp.offset[1],
        part.position[2] + cp.offset[2],
      ];

      // The cell adjacent to the connector in this socket's direction
      const adjacentCell = getAdjacentPosition(socketWorldPos, cp.direction);

      // Determine the axis the support needs to span
      const orientation = directionToAxis(cp.direction);

      // Compute the support origin position.
      // Supports have male ends at:
      //   -axis end (origin, offset [0,0,0]) with direction "-y"
      //   +axis end (far end, offset [0,units-1,0]) with direction "+y"
      //
      // A connector's +axis socket accepts the support's -axis (origin) end.
      //   → Origin IS at adjacentCell, support extends away in +axis direction.
      // A connector's -axis socket accepts the support's +axis (far) end.
      //   → Far end at adjacentCell, origin is (length-1) back from there.
      let originPos: GridPosition;

      if (cp.direction.startsWith("+")) {
        // +axis socket: support origin enters here, extends away
        originPos = adjacentCell;
      } else {
        // -axis socket: support far end enters here, origin is offset back
        originPos = [...adjacentCell] as GridPosition;
        const axisIndex = orientation === "x" ? 0 : orientation === "y" ? 1 : 2;
        originPos[axisIndex] -= supportLength - 1;
      }

      // Distance from cursor to the snap point (use adjacent cell as reference)
      const dx = cursorGridPos[0] - adjacentCell[0];
      const dy = cursorGridPos[1] - adjacentCell[1];
      const dz = cursorGridPos[2] - adjacentCell[2];
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (distance > maxDistance) continue;

      // Verify all cells the support would occupy are free
      const worldCells = getWorldCells(supportDef.gridCells, originPos, orientation);
      const allFree = worldCells.every((cell) => {
        if (cell[1] < 0) return false; // Below ground
        return !assembly.isOccupied(cell);
      });

      if (!allFree) continue;

      candidates.push({
        position: originPos,
        orientation,
        connectorInstanceId: part.instanceId,
        socketDirection: cp.direction,
        distance,
      });
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates;
}

/**
 * Find the best snap point for a support near a cursor position.
 * Returns null if no snap points are within range.
 */
export function findBestSnap(
  assembly: AssemblyState,
  supportDefId: string,
  cursorGridPos: GridPosition,
  snapRadius: number = 3,
): SnapCandidate | null {
  const candidates = findSnapPoints(assembly, supportDefId, cursorGridPos, snapRadius);
  return candidates.length > 0 ? candidates[0] : null;
}
