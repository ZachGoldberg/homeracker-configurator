import type { PlacedPart, GridPosition, Axis, BOMEntry, AssemblyFile, Rotation3, PartCategory } from "../types";
import { getPartDefinition, PART_CATALOG } from "../data/catalog";
import { getWorldCells, getAdjacentPosition, rotateGridCells, rotateDirection, transformDirection, rotateAxis } from "./grid-utils";

/**
 * Check if any connection point arm would extend below Y=0.
 * Arms extend ~1 grid unit from the cell, so if the adjacent position
 * in the arm direction has Y < 0, the arm geometry goes underground.
 */
function hasArmBelowGround(
  def: { connectionPoints: { offset: GridPosition; direction: string }[]; gridCells: GridPosition[] },
  position: GridPosition,
  rotation: Rotation3,
  orientation: Axis,
): boolean {
  for (const cp of def.connectionPoints) {
    // Transform direction: orientation first, then rotation
    const orientedDir = transformDirection(cp.direction as any, orientation);
    const rotatedDir = rotateDirection(orientedDir, rotation);
    // Compute where the arm points to from the part position
    const adjacentPos = getAdjacentPosition(position, rotatedDir);
    if (adjacentPos[1] < 0) return true;
  }
  return false;
}

function gridKey(pos: GridPosition): string {
  return `${pos[0]},${pos[1]},${pos[2]}`;
}

let nextId = 0;
function generateId(): string {
  return `part-${++nextId}-${Date.now()}`;
}

export interface AssemblySnapshot {
  parts: PlacedPart[];
  customPartsSkipCollision: boolean;
  snapEnabled: boolean;
}

/**
 * Tracks how a cell is occupied. Supports are thin bars along a single axis,
 * so perpendicular supports can share a cell. Connectors and other parts
 * block the entire cell.
 */
interface CellOccupant {
  instanceId: string;
  /** Which axis this occupant runs along, or "full" for connectors/lockpins/custom */
  axis: Axis | "full";
  /** For pull-through connectors: the effective PT axis (after rotation) */
  pullThroughAxis?: Axis;
}

const SETTINGS_KEY = "homeracker-settings";

export class AssemblyState {
  private parts: Map<string, PlacedPart> = new Map();
  /** Maps "x,y,z" grid key to the occupants at that cell */
  private gridOccupancy: Map<string, CellOccupant[]> = new Map();
  private listeners: Set<() => void> = new Set();
  /** Cached snapshot — only replaced on mutation so useSyncExternalStore stays stable */
  private cachedSnapshot: AssemblySnapshot = { parts: [], customPartsSkipCollision: false, snapEnabled: true };

  /** When true, custom STL parts skip collision detection entirely */
  customPartsSkipCollision: boolean = false;

  /** When true, parts snap to nearby connection points during placement/drag */
  snapEnabled: boolean = true;

  constructor() {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) {
        const settings = JSON.parse(saved);
        this.customPartsSkipCollision = !!settings.customPartsSkipCollision;
        if (settings.snapEnabled !== undefined) this.snapEnabled = !!settings.snapEnabled;
      }
    } catch { /* ignore */ }
  }

  setCustomPartsSkipCollision(value: boolean) {
    this.customPartsSkipCollision = value;
    this.persistSettings();
    this.notify();
  }

  setSnapEnabled(value: boolean) {
    this.snapEnabled = value;
    this.persistSettings();
    this.notify();
  }

  private persistSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        customPartsSkipCollision: this.customPartsSkipCollision,
        snapEnabled: this.snapEnabled,
      }));
    } catch { /* ignore */ }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.cachedSnapshot = {
      parts: Array.from(this.parts.values()),
      customPartsSkipCollision: this.customPartsSkipCollision,
      snapEnabled: this.snapEnabled,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  getSnapshot(): AssemblySnapshot {
    return this.cachedSnapshot;
  }

  getPartById(id: string): PlacedPart | undefined {
    return this.parts.get(id);
  }

  getAllParts(): PlacedPart[] {
    return Array.from(this.parts.values());
  }

  /** Check if a grid position is occupied (optionally: blocked for a given axis) */
  isOccupied(pos: GridPosition): boolean {
    const occupants = this.gridOccupancy.get(gridKey(pos));
    return !!occupants && occupants.length > 0;
  }

  /**
   * Check if a new occupant with the given axis can coexist with existing occupants.
   * Returns true if the cell is FREE for this axis (i.e., placement is OK).
   */
  private isCellFreeForAxis(pos: GridPosition, axis: Axis | "full", ignoreInstanceId?: string, newPullThroughAxis?: Axis): boolean {
    const occupants = this.gridOccupancy.get(gridKey(pos));
    if (!occupants || occupants.length === 0) return true;
    for (const occ of occupants) {
      if (ignoreInstanceId && occ.instanceId === ignoreInstanceId) continue;
      // When custom collision is disabled, ignore custom part occupants
      if (this.customPartsSkipCollision) {
        const part = this.parts.get(occ.instanceId);
        if (part && getPartDefinition(part.definitionId)?.category === "custom") continue;
      }

      if (occ.axis === "full" || axis === "full") {
        // Pull-through coexistence: PT connector + support on matching axis
        if (occ.axis === "full" && occ.pullThroughAxis && axis !== "full" && occ.pullThroughAxis === axis) continue;
        if (axis === "full" && newPullThroughAxis && occ.axis !== "full" && newPullThroughAxis === occ.axis) continue;
        return false;
      }
      // Two supports on the same axis collide
      if (occ.axis === axis) return false;
    }
    return true;
  }

  /**
   * Public version: check if a cell is free for a support along the given axis.
   * Used by the snap system to know if a support can pass through a cell.
   */
  isCellFreeForSupportAxis(pos: GridPosition, axis: Axis): boolean {
    return this.isCellFreeForAxis(pos, axis);
  }

  /** Get which part occupies a position (returns first occupant) */
  getPartAt(pos: GridPosition): PlacedPart | undefined {
    const occupants = this.gridOccupancy.get(gridKey(pos));
    if (!occupants || occupants.length === 0) return undefined;
    return this.parts.get(occupants[0].instanceId);
  }

  /** Compute the world-space cells a part would occupy, accounting for rotation and orientation */
  private getRotatedWorldCells(
    def: { gridCells: GridPosition[] },
    position: GridPosition,
    rotation: Rotation3 = [0, 0, 0],
    orientation: Axis = "y",
  ): GridPosition[] {
    const rotated = rotateGridCells(def.gridCells, rotation);
    return getWorldCells(rotated, position, orientation);
  }

  /**
   * Determine the occupancy axis for a part. Supports are "sparse" — they
   * only block along their orientation axis. Connectors and other parts
   * are "full" — they block the entire cell.
   */
  private getOccupancyAxis(category: PartCategory, orientation: Axis): Axis | "full" {
    if (category === "support") return orientation;
    return "full";
  }

  /** Get the effective pull-through axis for a part, accounting for rotation. */
  private getEffectivePullThroughAxis(definitionId: string, rotation: Rotation3): Axis | undefined {
    const def = getPartDefinition(definitionId);
    if (!def?.pullThroughAxis) return undefined;
    return rotateAxis(def.pullThroughAxis, rotation);
  }

  /** Check if a part can be placed at the given position with rotation and orientation */
  canPlace(
    definitionId: string,
    position: GridPosition,
    rotation: Rotation3 = [0, 0, 0],
    orientation: Axis = "y",
  ): boolean {
    const def = getPartDefinition(definitionId);
    if (!def) return false;

    // Custom parts skip all collision checks when the setting is enabled
    if (this.customPartsSkipCollision && def.category === "custom") return true;

    // Connectors have physical arm geometry that extends into neighbor cells;
    // reject if any arm would poke below ground.
    if (def.category === "connector" && hasArmBelowGround(def, position, rotation, orientation)) return false;

    const occAxis = this.getOccupancyAxis(def.category, orientation);
    const ptAxis = this.getEffectivePullThroughAxis(definitionId, rotation);
    const worldCells = this.getRotatedWorldCells(def, position, rotation, orientation);
    for (const worldCell of worldCells) {
      if (worldCell[1] < 0) return false;
      if (!this.isCellFreeForAxis(worldCell, occAxis, undefined, ptAxis)) return false;
    }
    return true;
  }

  /** Like canPlace but ignores cells owned by a specific instance (for drag-to-move) */
  canPlaceIgnoring(
    definitionId: string,
    position: GridPosition,
    rotation: Rotation3 = [0, 0, 0],
    ignoreInstanceId: string,
    orientation: Axis = "y",
  ): boolean {
    const def = getPartDefinition(definitionId);
    if (!def) return false;

    // Custom parts skip all collision checks when the setting is enabled
    if (this.customPartsSkipCollision && def.category === "custom") return true;

    if (def.category === "connector" && hasArmBelowGround(def, position, rotation, orientation)) return false;

    const occAxis = this.getOccupancyAxis(def.category, orientation);
    const ptAxis = this.getEffectivePullThroughAxis(definitionId, rotation);
    const worldCells = this.getRotatedWorldCells(def, position, rotation, orientation);
    for (const worldCell of worldCells) {
      if (worldCell[1] < 0) return false;
      if (!this.isCellFreeForAxis(worldCell, occAxis, ignoreInstanceId, ptAxis)) return false;
    }
    return true;
  }

  /** Add a part to the assembly. Returns the instance ID. */
  addPart(
    definitionId: string,
    position: GridPosition,
    rotation: PlacedPart["rotation"] = [0, 0, 0],
    orientation?: PlacedPart["orientation"]
  ): string | null {
    const effectiveOrientation = orientation ?? "y";
    if (!this.canPlace(definitionId, position, rotation, effectiveOrientation)) return null;

    const def = getPartDefinition(definitionId);
    if (!def) return null;

    const instanceId = generateId();
    const part: PlacedPart = {
      instanceId,
      definitionId,
      position,
      rotation,
      orientation,
    };

    this.parts.set(instanceId, part);

    // Mark grid cells as occupied (rotation + orientation aware)
    const occAxis = this.getOccupancyAxis(def.category, effectiveOrientation);
    const ptAxis = this.getEffectivePullThroughAxis(definitionId, rotation);
    const worldCells = this.getRotatedWorldCells(def, position, rotation, effectiveOrientation);
    for (const worldCell of worldCells) {
      const key = gridKey(worldCell);
      const occupants = this.gridOccupancy.get(key) || [];
      occupants.push({ instanceId, axis: occAxis, pullThroughAxis: ptAxis });
      this.gridOccupancy.set(key, occupants);
    }

    this.notify();
    return instanceId;
  }

  /** Remove a part from the assembly */
  removePart(instanceId: string): PlacedPart | null {
    const part = this.parts.get(instanceId);
    if (!part) return null;

    const def = getPartDefinition(part.definitionId);
    if (def) {
      const effectiveOrientation = part.orientation ?? "y";
      const worldCells = this.getRotatedWorldCells(def, part.position, part.rotation, effectiveOrientation);
      for (const worldCell of worldCells) {
        const key = gridKey(worldCell);
        const occupants = this.gridOccupancy.get(key);
        if (occupants) {
          const filtered = occupants.filter((o) => o.instanceId !== instanceId);
          if (filtered.length === 0) {
            this.gridOccupancy.delete(key);
          } else {
            this.gridOccupancy.set(key, filtered);
          }
        }
      }
    }

    this.parts.delete(instanceId);
    this.notify();
    return part;
  }

  /** Clear all parts */
  clear() {
    this.parts.clear();
    this.gridOccupancy.clear();
    this.notify();
  }

  /** Generate bill of materials */
  getBOM(): BOMEntry[] {
    const counts = new Map<string, number>();
    for (const part of this.parts.values()) {
      counts.set(part.definitionId, (counts.get(part.definitionId) || 0) + 1);
    }

    const entries: BOMEntry[] = [];
    for (const [defId, quantity] of counts) {
      const def = getPartDefinition(defId);
      if (def) {
        entries.push({
          definitionId: defId,
          name: def.name,
          category: def.category,
          quantity,
        });
      }
    }

    // Auto-calculate lock pins needed
    // Each connector arm that has an adjacent support = 1 lock pin
    let lockPinsNeeded = 0;
    for (const part of this.parts.values()) {
      const def = getPartDefinition(part.definitionId);
      if (def?.category === "connector") {
        for (const cp of def.connectionPoints) {
          const orientedDir = transformDirection(cp.direction as any, part.orientation);
          const rotatedDir = rotateDirection(orientedDir, part.rotation);
          const adjacentPos = getAdjacentPosition(part.position, rotatedDir);
          const adjacent = this.getPartAt(adjacentPos);
          if (adjacent) {
            const adjacentDef = getPartDefinition(adjacent.definitionId);
            if (adjacentDef?.category === "support") {
              lockPinsNeeded++;
            }
          }
        }
      }
    }

    if (lockPinsNeeded > 0) {
      // Add auto-calculated lock pins (with 10% spare)
      const withSpare = Math.ceil(lockPinsNeeded * 1.1);
      entries.push({
        definitionId: "lockpin-standard",
        name: `Lock Pin (auto: ${lockPinsNeeded} + spare)`,
        category: "lockpin",
        quantity: withSpare,
      });
    }

    return entries.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  /** Serialize to JSON file format */
  serialize(name: string = "My Rack"): AssemblyFile {
    return {
      version: "1.0",
      name,
      parts: Array.from(this.parts.values()).map((p) => ({
        type: p.definitionId,
        position: p.position,
        rotation: p.rotation,
        orientation: p.orientation,
      })),
    };
  }

  /** Load from JSON file format */
  deserialize(data: AssemblyFile) {
    this.clear();
    for (const p of data.parts) {
      // Backward compat: old saves stored rotation as a single number (Y-axis only)
      const rot: PlacedPart["rotation"] = Array.isArray(p.rotation)
        ? (p.rotation as PlacedPart["rotation"])
        : [0, (p.rotation || 0) as any, 0];
      this.addPart(p.type, p.position, rot, p.orientation);
    }
  }
}
