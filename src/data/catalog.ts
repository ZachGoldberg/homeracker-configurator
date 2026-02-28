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
  isFoot: boolean = false,
  pullThroughAxis?: "x" | "y" | "z"
): PartDefinition {
  const footSuffix = isFoot ? "-foot" : "";
  const ptSuffix = pullThroughAxis ? `-pt-${pullThroughAxis}` : "";
  const config = CONNECTOR_CONFIGS[configId];
  const footLabel = isFoot ? " Foot" : "";
  const ptLabel = pullThroughAxis
    ? ` PT-${pullThroughAxis.toUpperCase()}`
    : "";

  return {
    id: `connector-${configId}${footSuffix}${ptSuffix}`,
    category: "connector",
    name: `${config.dimensions}D ${config.directions}-Way${footLabel}${ptLabel}`,
    description: `${config.dimensions}-dimensional ${config.directions}-way connector${footLabel}${pullThroughAxis ? ` with ${pullThroughAxis.toUpperCase()}-axis pull-through` : ""}`,
    modelPath: `models/connector-${configId}${footSuffix}${ptSuffix}.glb`,
    connectionPoints: connectorConnectionPoints(configId),
    gridCells: [[0, 0, 0]],
    pullThroughAxis: pullThroughAxis,
  };
}

/** Full catalog — all supports (1-18u), all connectors, lock pins */
export const PART_CATALOG: PartDefinition[] = [
  // Supports (1u through 18u)
  ...Array.from({ length: 18 }, (_, i) => supportDef(i + 1)),

  // Connectors — all base variants
  connectorDef("1d1w"),
  connectorDef("1d2w"),
  connectorDef("2d2w"),
  connectorDef("2d3w"),
  connectorDef("2d4w"),
  connectorDef("3d3w"),
  connectorDef("3d4w"),
  connectorDef("3d5w"),
  connectorDef("3d6w"),

  // Connectors — foot variants
  connectorDef("2d2w", true),
  connectorDef("2d3w", true),
  connectorDef("2d4w", true),
  connectorDef("3d3w", true),
  connectorDef("3d4w", true),
  connectorDef("3d5w", true),
  connectorDef("3d6w", true),

  // Connectors — pull-through variants (base)
  connectorDef("1d1w", false, "z"),
  connectorDef("1d2w", false, "z"),

  connectorDef("2d2w", false, "z"),
  connectorDef("2d2w", false, "x"),
  connectorDef("2d3w", false, "z"),
  connectorDef("2d3w", false, "x"),
  connectorDef("2d4w", false, "z"),
  connectorDef("2d4w", false, "x"),

  connectorDef("3d3w", false, "z"),
  connectorDef("3d3w", false, "x"),
  connectorDef("3d3w", false, "y"),
  connectorDef("3d4w", false, "z"),
  connectorDef("3d4w", false, "x"),
  connectorDef("3d4w", false, "y"),
  connectorDef("3d5w", false, "z"),
  connectorDef("3d5w", false, "x"),
  connectorDef("3d5w", false, "y"),
  connectorDef("3d6w", false, "z"),
  connectorDef("3d6w", false, "x"),
  connectorDef("3d6w", false, "y"),

  // Connectors — foot + pull-through variants (z-axis PT overridden by foot)
  connectorDef("2d2w", true, "x"),
  connectorDef("2d3w", true, "x"),
  connectorDef("2d4w", true, "x"),
  connectorDef("3d3w", true, "x"),
  connectorDef("3d3w", true, "y"),
  connectorDef("3d4w", true, "x"),
  connectorDef("3d4w", true, "y"),
  connectorDef("3d5w", true, "x"),
  connectorDef("3d5w", true, "y"),
  connectorDef("3d6w", true, "x"),
  connectorDef("3d6w", true, "y"),

  // Lock pins
  {
    id: "lockpin-standard",
    category: "lockpin",
    name: "Lock Pin",
    description: "Standard 4mm square lock pin with grip",
    modelPath: "models/lockpin-standard.glb",
    connectionPoints: [],
    gridCells: [[0, 0, 0]],
  },
  {
    id: "lockpin-no-grip",
    category: "lockpin",
    name: "Lock Pin (No Grip)",
    description: "4mm square lock pin without grip",
    modelPath: "models/lockpin-no-grip.glb",
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
