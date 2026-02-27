import type { PartDefinition, ConnectionPoint, GridPosition } from "../types";
import { getArmDirections, CONNECTOR_CONFIGS } from "./connector-configs";
import { getCustomPartDefinition, getCustomParts } from "./custom-parts";

/** Generate connection points for a connector from its arm config */
function connectorConnectionPoints(configId: string): ConnectionPoint[] {
  return getArmDirections(configId).map((direction) => ({
    offset: [0, 0, 0] as GridPosition,
    direction,
    type: "female" as const,
  }));
}

/** Generate a support part definition */
function supportDef(units: number): PartDefinition {
  const cells: GridPosition[] = [];
  for (let i = 0; i < units; i++) {
    cells.push([0, i, 0]);
  }

  return {
    id: `support-${units}u`,
    category: "support",
    name: `Support (${units}u)`,
    description: `${units * 15}mm support beam (${units} unit${units > 1 ? "s" : ""})`,
    modelPath: `models/support-${units}u.glb`,
    connectionPoints: [
      { offset: [0, 0, 0], direction: "-y", type: "male" },
      { offset: [0, units - 1, 0], direction: "+y", type: "male" },
    ],
    gridCells: cells,
  };
}

/** Generate a connector part definition */
function connectorDef(
  configId: string,
  isFoot: boolean = false
): PartDefinition {
  const suffix = isFoot ? "-foot" : "";
  const config = CONNECTOR_CONFIGS[configId];
  const footLabel = isFoot ? " Foot" : "";

  return {
    id: `connector-${configId}${suffix}`,
    category: "connector",
    name: `${config.dimensions}D ${config.directions}-Way${footLabel}`,
    description: `${config.dimensions}-dimensional ${config.directions}-way connector${footLabel}`,
    modelPath: `models/connector-${configId}${suffix}.glb`,
    connectionPoints: connectorConnectionPoints(configId),
    gridCells: [[0, 0, 0]],
  };
}

/** MVP catalog — core parts only */
export const PART_CATALOG: PartDefinition[] = [
  // Supports (3 sizes for MVP)
  supportDef(3),
  supportDef(5),
  supportDef(10),

  // Connectors (key variants for MVP)
  connectorDef("2d2w"),
  connectorDef("2d4w"),
  connectorDef("3d4w"),
  connectorDef("3d6w"),

  // Lock pin
  {
    id: "lockpin-standard",
    category: "lockpin",
    name: "Lock Pin",
    description: "Standard 4mm square lock pin with grip",
    modelPath: "models/lockpin-standard.glb",
    connectionPoints: [],
    gridCells: [[0, 0, 0]],
  },
];

/** Look up a part definition by ID (checks built-in catalog, then custom parts) */
export function getPartDefinition(id: string): PartDefinition | undefined {
  return PART_CATALOG.find((p) => p.id === id) ?? getCustomPartDefinition(id);
}

/** Get parts filtered by category */
export function getPartsByCategory(
  category: PartDefinition["category"]
): PartDefinition[] {
  if (category === "custom") return getCustomParts();
  return PART_CATALOG.filter((p) => p.category === category);
}
