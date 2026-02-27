import type { PlacedPart, GridPosition, Axis, BOMEntry, AssemblyFile, Rotation3 } from "../types";
import { getPartDefinition, PART_CATALOG } from "../data/catalog";
import { getWorldCells, getAdjacentPosition, rotateGridCells } from "./grid-utils";

function gridKey(pos: GridPosition): string {
  return `${pos[0]},${pos[1]},${pos[2]}`;
}

let nextId = 0;
function generateId(): string {
  return `part-${++nextId}-${Date.now()}`;
}

export interface AssemblySnapshot {
  parts: PlacedPart[];
}

export class AssemblyState {
  private parts: Map<string, PlacedPart> = new Map();
  /** Maps "x,y,z" grid key to the part instance ID occupying it */
  private gridOccupancy: Map<string, string> = new Map();
  private listeners: Set<() => void> = new Set();
  /** Cached snapshot — only replaced on mutation so useSyncExternalStore stays stable */
  private cachedSnapshot: AssemblySnapshot = { parts: [] };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.cachedSnapshot = { parts: Array.from(this.parts.values()) };
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

  /** Check if a grid position is occupied */
  isOccupied(pos: GridPosition): boolean {
    return this.gridOccupancy.has(gridKey(pos));
  }

  /** Get which part occupies a position */
  getPartAt(pos: GridPosition): PlacedPart | undefined {
    const id = this.gridOccupancy.get(gridKey(pos));
    return id ? this.parts.get(id) : undefined;
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

  /** Check if a part can be placed at the given position with rotation and orientation */
  canPlace(
    definitionId: string,
    position: GridPosition,
    rotation: Rotation3 = [0, 0, 0],
    orientation: Axis = "y",
  ): boolean {
    const def = getPartDefinition(definitionId);
    if (!def) return false;

    const worldCells = this.getRotatedWorldCells(def, position, rotation, orientation);
    for (const worldCell of worldCells) {
      if (worldCell[1] < 0) return false;
      if (this.isOccupied(worldCell)) return false;
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

    const worldCells = this.getRotatedWorldCells(def, position, rotation, orientation);
    for (const worldCell of worldCells) {
      if (worldCell[1] < 0) return false;
      const key = gridKey(worldCell);
      const occupant = this.gridOccupancy.get(key);
      if (occupant && occupant !== ignoreInstanceId) return false;
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
    const worldCells = this.getRotatedWorldCells(def, position, rotation, effectiveOrientation);
    for (const worldCell of worldCells) {
      this.gridOccupancy.set(gridKey(worldCell), instanceId);
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
        this.gridOccupancy.delete(gridKey(worldCell));
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
          const adjacentPos = getAdjacentPosition(part.position, cp.direction);
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
