import type { Direction } from "../types";

/**
 * Connector arm configuration lookup table.
 * Mirrored from models/core/lib/connector.scad CONNECTOR_CONFIGS.
 *
 * Format: [+z, -z, +x, -x, +y, -y] (OpenSCAD Z-up)
 * In Three.js Y-up: [+y, -y, +x, -x, +z, -z]
 */

interface ConnectorConfig {
  dimensions: number;
  directions: number;
  /** Arms active: [+y, -y, +x, -x, +z, -z] (Three.js Y-up convention) */
  arms: [boolean, boolean, boolean, boolean, boolean, boolean];
}

// OpenSCAD Z-up [+z, -z, +x, -x, +y, -y] => Three.js Y-up [+y, -y, +x, -x, +z, -z]
export const CONNECTOR_CONFIGS: Record<string, ConnectorConfig> = {
  // 1D configurations (Z-axis only in OpenSCAD = Y-axis in Three.js)
  "1d1w": { dimensions: 1, directions: 1, arms: [true, false, false, false, false, false] },
  "1d2w": { dimensions: 1, directions: 2, arms: [true, true, false, false, false, false] },

  // 2D configurations (Z + X axes)
  "2d2w": { dimensions: 2, directions: 2, arms: [true, false, true, false, false, false] },
  "2d3w": { dimensions: 2, directions: 3, arms: [true, true, true, false, false, false] },
  "2d4w": { dimensions: 2, directions: 4, arms: [true, true, true, true, false, false] },

  // 3D configurations (all three axes)
  "3d3w": { dimensions: 3, directions: 3, arms: [true, false, true, false, true, false] },
  "3d4w": { dimensions: 3, directions: 4, arms: [true, true, true, false, true, false] },
  "3d5w": { dimensions: 3, directions: 5, arms: [true, true, true, true, true, false] },
  "3d6w": { dimensions: 3, directions: 6, arms: [true, true, true, true, true, true] },
};

const DIRECTION_MAP: Direction[] = ["+y", "-y", "+x", "-x", "+z", "-z"];

/** Get active arm directions for a connector config */
export function getArmDirections(configId: string): Direction[] {
  const config = CONNECTOR_CONFIGS[configId];
  if (!config) return [];
  return config.arms
    .map((active, i) => (active ? DIRECTION_MAP[i] : null))
    .filter((d): d is Direction => d !== null);
}
