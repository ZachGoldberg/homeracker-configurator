import type { GridPosition, Axis, Direction, Rotation3, RotationStep } from "../types";

/**
 * Transform a grid cell offset based on support orientation.
 * Catalog defines supports along Y. This remaps to the target axis.
 *
 * orientation "y" -> identity: [0,i,0] stays [0,i,0]
 * orientation "x" -> swap Y and X: [0,i,0] -> [i,0,0]
 * orientation "z" -> swap Y and Z: [0,i,0] -> [0,0,i]
 */
export function transformCell(
  cell: GridPosition,
  orientation: Axis,
): GridPosition {
  switch (orientation) {
    case "y":
      return cell;
    case "x":
      return [cell[1], cell[0], cell[2]];
    case "z":
      return [cell[0], cell[2], cell[1]];
  }
}

/**
 * Get all world-space grid cells a part would occupy at a position
 * with a given orientation.
 */
export function getWorldCells(
  cells: GridPosition[],
  position: GridPosition,
  orientation: Axis = "y",
): GridPosition[] {
  return cells.map((cell) => {
    const t = transformCell(cell, orientation);
    return [
      position[0] + t[0],
      position[1] + t[1],
      position[2] + t[2],
    ] as GridPosition;
  });
}

/**
 * Get the Rotation3 that visually matches a support orientation.
 *
 * GLB models are authored in OpenSCAD Z-up, baked into Y-up GLBs.
 * After the -90deg X rotation in <primitive>, supports extend along Y.
 * To reorient:
 *   "y" -> [0,0,0]   (default vertical)
 *   "x" -> [0,0,90]  (rotate 90 around Z to lay along X)
 *   "z" -> [90,0,0]  (rotate 90 around X to lay along Z)
 */
export function orientationToRotation(orientation: Axis): Rotation3 {
  switch (orientation) {
    case "y":
      return [0, 0, 0];
    case "x":
      return [0, 0, 90 as RotationStep];
    case "z":
      return [90 as RotationStep, 0, 0];
  }
}

/**
 * Rotate a single grid cell by a 90° increment around one axis.
 * Uses right-hand-rule axis swaps:
 *   90° around X: [x, y, z] → [x, -z, y]
 *   90° around Y: [x, y, z] → [z, y, -x]
 *   90° around Z: [x, y, z] → [-y, x, z]
 */
function rotateCellOnce(
  cell: GridPosition,
  axis: 0 | 1 | 2,
): GridPosition {
  const [x, y, z] = cell;
  switch (axis) {
    case 0: return [x, -z, y];   // X-axis
    case 1: return [z, y, -x];   // Y-axis
    case 2: return [-y, x, z];   // Z-axis
  }
}

/**
 * Rotate a grid cell by a Rotation3 (degrees in 90° increments).
 * Applies X rotation first, then Y, then Z.
 */
function rotateCellByRotation3(cell: GridPosition, rotation: Rotation3): GridPosition {
  let result = cell;
  // Apply each axis rotation in order: X, Y, Z
  for (let axis = 0; axis < 3; axis++) {
    const degrees = rotation[axis];
    const steps = (degrees / 90) % 4;
    for (let s = 0; s < steps; s++) {
      result = rotateCellOnce(result, axis as 0 | 1 | 2);
    }
  }
  return result;
}

/**
 * Rotate an array of grid cells by a Rotation3.
 * Used to compute world-space occupancy for rotated parts.
 */
export function rotateGridCells(
  cells: GridPosition[],
  rotation: Rotation3,
): GridPosition[] {
  // Skip if no rotation
  if (rotation[0] === 0 && rotation[1] === 0 && rotation[2] === 0) {
    return cells;
  }
  return cells.map((cell) => rotateCellByRotation3(cell, rotation));
}

/** Extract the axis from a direction string. */
export function directionToAxis(direction: Direction): Axis {
  if (direction === "+x" || direction === "-x") return "x";
  if (direction === "+y" || direction === "-y") return "y";
  return "z";
}

/** Get the adjacent grid position in a given direction. */
export function getAdjacentPosition(
  pos: GridPosition,
  direction: Direction,
): GridPosition {
  const [x, y, z] = pos;
  switch (direction) {
    case "+x":
      return [x + 1, y, z];
    case "-x":
      return [x - 1, y, z];
    case "+y":
      return [x, y + 1, z];
    case "-y":
      return [x, y - 1, z];
    case "+z":
      return [x, y, z + 1];
    case "-z":
      return [x, y, z - 1];
  }
}

/** Cycle support orientation: y -> x -> z -> y */
export function nextOrientation(current: Axis): Axis {
  const cycle: Axis[] = ["y", "x", "z"];
  return cycle[(cycle.indexOf(current) + 1) % 3];
}
