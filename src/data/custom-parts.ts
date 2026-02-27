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
        geometry.computeBoundingBox();

        const bbox = geometry.boundingBox!;
        const size = new THREE.Vector3();
        bbox.getSize(size);

        // Compute grid cells from bounding box (assuming STL units = mm)
        const cellsX = Math.max(1, Math.ceil(size.x / BASE_UNIT));
        const cellsY = Math.max(1, Math.ceil(size.y / BASE_UNIT));
        const cellsZ = Math.max(1, Math.ceil(size.z / BASE_UNIT));

        const gridCells: GridPosition[] = [];
        for (let x = 0; x < cellsX; x++) {
          for (let y = 0; y < cellsY; y++) {
            for (let z = 0; z < cellsZ; z++) {
              gridCells.push([x, y, z]);
            }
          }
        }

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
      geometry.center();

      const def: PartDefinition = {
        id: entry.id,
        category: "custom",
        name: entry.name,
        description: `Imported STL (${entry.gridCells.length} cells)`,
        modelPath: "",
        connectionPoints: [],
        gridCells: entry.gridCells,
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
