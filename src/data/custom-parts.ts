import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { PartDefinition, GridPosition } from "../types";
import { BASE_UNIT } from "../constants";
import {
  saveSTLBuffer,
  saveCustomPartsMeta,
  loadCustomPartsMeta,
  loadAllSTLBuffers,
  type CustomPartMeta,
} from "./custom-parts-storage";

const stlLoader = new STLLoader();

/** Runtime store for imported STL geometries, keyed by definition ID */
const geometryStore = new Map<string, THREE.BufferGeometry>();

/** Runtime store for custom part definitions */
const customDefinitions: PartDefinition[] = [];

/** Subscribers for React reactivity */
const listeners = new Set<() => void>();
let snapshot = { definitions: [] as PartDefinition[] };

function notify() {
  snapshot = { definitions: [...customDefinitions] };
  listeners.forEach((cb) => cb());
}

/** Persist current custom parts metadata to localStorage */
function persistMeta() {
  const meta: CustomPartMeta[] = customDefinitions.map((d) => ({
    id: d.id,
    name: d.name,
    gridCells: d.gridCells,
  }));
  saveCustomPartsMeta(meta);
}

export function subscribeCustomParts(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getCustomPartsSnapshot() {
  return snapshot;
}

/** Get all custom part definitions */
export function getCustomParts(): PartDefinition[] {
  return customDefinitions;
}

/** Look up a custom part definition by ID */
export function getCustomPartDefinition(id: string): PartDefinition | undefined {
  return customDefinitions.find((d) => d.id === id);
}

/** Get stored geometry for a custom part */
export function getCustomPartGeometry(defId: string): THREE.BufferGeometry | undefined {
  return geometryStore.get(defId);
}

/** Check if a definition ID is a custom imported part */
export function isCustomPart(defId: string): boolean {
  return geometryStore.has(defId);
}

let nextId = 1;

/**
 * Voxelize a geometry: find which grid cells actually contain mesh triangles.
 * Only cells with geometry are returned, so hollow interiors remain free.
 */
function voxelizeGeometry(geometry: THREE.BufferGeometry): {
  gridCells: GridPosition[];
  cellsX: number;
  cellsY: number;
  cellsZ: number;
} {
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const cellsX = Math.max(1, Math.ceil(size.x / BASE_UNIT));
  const cellsY = Math.max(1, Math.ceil(size.y / BASE_UNIT));
  const cellsZ = Math.max(1, Math.ceil(size.z / BASE_UNIT));

  const positions = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : positions.count / 3;

  const occupiedCells = new Set<string>();

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

    // Triangle vertex positions
    const xs = [positions.getX(i0), positions.getX(i1), positions.getX(i2)];
    const ys = [positions.getY(i0), positions.getY(i1), positions.getY(i2)];
    const zs = [positions.getZ(i0), positions.getZ(i1), positions.getZ(i2)];

    // Triangle AABB → grid cell range
    const cMinX = Math.max(0, Math.floor((Math.min(...xs) - bbox.min.x) / BASE_UNIT));
    const cMinY = Math.max(0, Math.floor((Math.min(...ys) - bbox.min.y) / BASE_UNIT));
    const cMinZ = Math.max(0, Math.floor((Math.min(...zs) - bbox.min.z) / BASE_UNIT));
    const cMaxX = Math.min(cellsX - 1, Math.floor((Math.max(...xs) - bbox.min.x) / BASE_UNIT));
    const cMaxY = Math.min(cellsY - 1, Math.floor((Math.max(...ys) - bbox.min.y) / BASE_UNIT));
    const cMaxZ = Math.min(cellsZ - 1, Math.floor((Math.max(...zs) - bbox.min.z) / BASE_UNIT));

    for (let cx = cMinX; cx <= cMaxX; cx++) {
      for (let cy = cMinY; cy <= cMaxY; cy++) {
        for (let cz = cMinZ; cz <= cMaxZ; cz++) {
          occupiedCells.add(`${cx},${cy},${cz}`);
        }
      }
    }
  }

  const gridCells: GridPosition[] = [];
  for (const key of occupiedCells) {
    const [x, y, z] = key.split(",").map(Number);
    gridCells.push([x, y, z] as GridPosition);
  }

  return { gridCells, cellsX, cellsY, cellsZ };
}

/**
 * Import an STL file and register it as a custom catalog part.
 * Returns the new PartDefinition.
 */
export function importSTL(file: File): Promise<PartDefinition> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const buffer = reader.result as ArrayBuffer;
        const geometry = stlLoader.parse(buffer);

        // Voxelize: only include cells with actual geometry
        const { gridCells, cellsX, cellsY, cellsZ } = voxelizeGeometry(geometry);

        // Center geometry at origin for consistent rendering
        geometry.center();

        const name = file.name.replace(/\.stl$/i, "");
        const id = `custom-stl-${nextId++}`;

        const def: PartDefinition = {
          id,
          category: "custom",
          name,
          description: `Imported STL (${cellsX}x${cellsY}x${cellsZ} units)`,
          modelPath: "", // Not used — geometry is in the store
          connectionPoints: [],
          gridCells,
        };

        geometryStore.set(id, geometry);
        customDefinitions.push(def);
        notify();

        // Persist to IndexedDB + localStorage
        await saveSTLBuffer(id, buffer);
        persistMeta();

        resolve(def);
      } catch (err) {
        reject(new Error(`Failed to parse STL: ${err}`));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Restore custom parts from IndexedDB + localStorage.
 * Must be called before assembly.deserialize() so custom part IDs resolve.
 */
export async function restoreCustomParts(): Promise<void> {
  const meta = loadCustomPartsMeta();
  if (meta.length === 0) return;

  let buffers: Map<string, ArrayBuffer>;
  try {
    buffers = await loadAllSTLBuffers();
  } catch {
    return; // IndexedDB unavailable
  }

  for (const entry of meta) {
    const buffer = buffers.get(entry.id);
    if (!buffer) continue; // Binary lost — skip this part

    try {
      const geometry = stlLoader.parse(buffer);

      // Re-voxelize from actual geometry (fixes stale bounding-box cells from old saves)
      const { gridCells } = voxelizeGeometry(geometry);

      geometry.center();

      const def: PartDefinition = {
        id: entry.id,
        category: "custom",
        name: entry.name,
        description: `Imported STL (${gridCells.length} cells)`,
        modelPath: "",
        connectionPoints: [],
        gridCells,
      };

      geometryStore.set(entry.id, geometry);
      customDefinitions.push(def);
    } catch {
      // Skip corrupt entries
    }
  }

  // Set nextId past any restored IDs to avoid collisions
  for (const entry of meta) {
    const match = entry.id.match(/^custom-stl-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= nextId) nextId = num + 1;
    }
  }

  notify();
}
