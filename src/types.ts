/** 3D grid position as integer multiples of BASE_UNIT */
export type GridPosition = [number, number, number];

/** Part category */
export type PartCategory = "support" | "connector" | "lockpin";

/** Direction an arm/connection faces */
export type Direction = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

/** Axis a support spans along */
export type Axis = "x" | "y" | "z";

/** Connection point on a part */
export interface ConnectionPoint {
  /** Grid offset from part origin */
  offset: GridPosition;
  /** Direction the connection faces */
  direction: Direction;
  /** male = support end, female = connector socket */
  type: "male" | "female";
}

/** Definition of a part type in the catalog */
export interface PartDefinition {
  id: string;
  category: PartCategory;
  name: string;
  description: string;
  modelPath: string;
  thumbnailPath?: string;
  /** Connection points where other parts attach */
  connectionPoints: ConnectionPoint[];
  /** Grid cells this part occupies relative to its origin */
  gridCells: GridPosition[];
}

/** Rotation step: 0, 90, 180, or 270 degrees */
export type RotationStep = 0 | 90 | 180 | 270;

/** 3-axis rotation in degrees [X, Y, Z], each a multiple of 90 */
export type Rotation3 = [RotationStep, RotationStep, RotationStep];

/** A part placed in the assembly */
export interface PlacedPart {
  /** Unique instance ID */
  instanceId: string;
  /** References PartDefinition.id */
  definitionId: string;
  /** Grid position */
  position: GridPosition;
  /** Rotation in degrees [X, Y, Z] */
  rotation: Rotation3;
  /** For supports: which axis the beam spans */
  orientation?: Axis;
}

/** Interaction mode */
export type InteractionMode =
  | { type: "select" }
  | { type: "place"; definitionId: string };

/** State for a part being dragged */
export interface DragState {
  instanceId: string;
  definitionId: string;
  originalPosition: GridPosition;
  rotation: Rotation3;
  orientation?: Axis;
}

/** BOM entry */
export interface BOMEntry {
  definitionId: string;
  name: string;
  category: PartCategory;
  quantity: number;
}

/** Serialized assembly format */
export interface AssemblyFile {
  version: "1.0";
  name: string;
  parts: Array<{
    type: string;
    position: GridPosition;
    rotation: [number, number, number];
    orientation?: Axis;
  }>;
}
