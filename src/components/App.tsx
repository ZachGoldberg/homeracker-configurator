import { useState, useCallback, useEffect, useSyncExternalStore } from "react";
import { ViewportCanvas } from "./ViewportCanvas";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { BOMPanel } from "./BOMPanel";
import { AssemblyState } from "../assembly/AssemblyState";
import { HistoryManager, type Command } from "../assembly/HistoryManager";
import type { InteractionMode, GridPosition, PlacedPart, Axis, Rotation3 } from "../types";
import { getPartDefinition } from "../data/catalog";
import { findBestSnap, findSnapPoints, findBestConnectorSnap, findConnectorSnapPoints } from "../assembly/snap";
import { restoreCustomParts, importSTL } from "../data/custom-parts";

// Global singleton instances
const assembly = new AssemblyState();
const history = new HistoryManager();

const STORAGE_KEY = "homeracker-scene";

// Restore custom parts (IndexedDB) THEN assembly (localStorage).
// Custom part definitions must exist before deserialize() resolves their IDs.
const initPromise = restoreCustomParts()
  .catch(() => {}) // IndexedDB may be unavailable
  .then(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) assembly.deserialize(JSON.parse(saved));
    } catch {
      // Ignore corrupt/missing data
    }
  });

// Auto-persist scene to localStorage on every change
assembly.subscribe(() => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(assembly.serialize()));
  } catch {
    // Ignore quota errors
  }
});

// Expose for e2e testing
(window as any).__assembly = assembly;
(window as any).__snap = { findBestSnap, findSnapPoints, findBestConnectorSnap, findConnectorSnapPoints };
(window as any).__importSTL = importSTL;

export function App() {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<InteractionMode>({ type: "select" });
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);

  // Wait for custom parts + assembly restore before rendering
  useEffect(() => {
    initPromise.then(() => setReady(true));
  }, []);

  // Subscribe to assembly changes for re-renders
  const snapshot = useSyncExternalStore(
    (cb) => assembly.subscribe(cb),
    () => assembly.getSnapshot()
  );

  const handleSelectPart = useCallback((definitionId: string) => {
    setMode({ type: "place", definitionId });
    setSelectedPartId(null);
  }, []);

  const handlePlacePart = useCallback(
    (definitionId: string, position: GridPosition, rotation: PlacedPart["rotation"] = [0, 0, 0], orientation?: Axis) => {
      const cmd: Command = {
        description: `Place ${definitionId}`,
        execute() {
          assembly.addPart(definitionId, position, rotation, orientation);
        },
        undo() {
          // Find the most recently added part with this definition at this position
          const parts = assembly.getAllParts();
          const match = parts.find(
            (p) =>
              p.definitionId === definitionId &&
              p.position[0] === position[0] &&
              p.position[1] === position[1] &&
              p.position[2] === position[2]
          );
          if (match) assembly.removePart(match.instanceId);
        },
      };
      history.execute(cmd);
    },
    []
  );

  const handleDeletePart = useCallback(
    (instanceId: string) => {
      const part = assembly.getPartById(instanceId);
      if (!part) return;
      const saved = { ...part };
      const cmd: Command = {
        description: `Delete ${part.definitionId}`,
        execute() {
          assembly.removePart(instanceId);
        },
        undo() {
          assembly.addPart(
            saved.definitionId,
            saved.position,
            saved.rotation,
            saved.orientation
          );
        },
      };
      history.execute(cmd);
      if (selectedPartId === instanceId) setSelectedPartId(null);
    },
    [selectedPartId]
  );

  const handleMovePart = useCallback(
    (instanceId: string, newPosition: GridPosition, newRotation?: PlacedPart["rotation"], newOrientation?: Axis) => {
      const part = assembly.getPartById(instanceId);
      if (!part) return;

      const rotation = newRotation ?? part.rotation;
      const orientation = newOrientation ?? part.orientation;
      const samePosition =
        part.position[0] === newPosition[0] &&
        part.position[1] === newPosition[1] &&
        part.position[2] === newPosition[2];
      const sameRotation =
        part.rotation[0] === rotation[0] &&
        part.rotation[1] === rotation[1] &&
        part.rotation[2] === rotation[2];
      const sameOrientation = part.orientation === orientation;
      if (samePosition && sameRotation && sameOrientation) return; // No-op

      const oldPosition = part.position;
      const oldRotation = part.rotation;
      const oldOrientation = part.orientation;
      const definitionId = part.definitionId;

      const cmd: Command = {
        description: `Move ${definitionId}`,
        execute() {
          assembly.removePart(instanceId);
          assembly.addPart(definitionId, newPosition, rotation, orientation);
        },
        undo() {
          // Find the part at the new position and move it back
          const parts = assembly.getAllParts();
          const match = parts.find(
            (p) =>
              p.definitionId === definitionId &&
              p.position[0] === newPosition[0] &&
              p.position[1] === newPosition[1] &&
              p.position[2] === newPosition[2]
          );
          if (match) {
            assembly.removePart(match.instanceId);
            assembly.addPart(definitionId, oldPosition, oldRotation, oldOrientation);
          }
        },
      };
      history.execute(cmd);
    },
    []
  );

  const handleClickPart = useCallback(
    (instanceId: string) => {
      if (mode.type === "select") {
        setSelectedPartId(instanceId === selectedPartId ? null : instanceId);
      }
    },
    [mode, selectedPartId]
  );

  const handleClickEmpty = useCallback(() => {
    if (mode.type === "select") {
      setSelectedPartId(null);
    }
  }, [mode]);

  const handleEscape = useCallback(() => {
    setMode({ type: "select" });
    setSelectedPartId(null);
  }, []);

  const handleUndo = useCallback(() => history.undo(), []);
  const handleRedo = useCallback(() => history.redo(), []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (
        (e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))
      ) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo]);

  const handleClear = useCallback(() => {
    assembly.clear();
    history.clear();
    setSelectedPartId(null);
  }, []);

  const handleSave = useCallback(() => {
    const data = assembly.serialize();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.name.replace(/\s+/g, "-").toLowerCase()}.homeracker.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleLoad = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.homeracker.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const data = JSON.parse(text);
        assembly.deserialize(data);
        history.clear();
        setSelectedPartId(null);
      } catch (e) {
        console.error("Failed to load assembly:", e);
      }
    };
    input.click();
  }, []);

  const bom = assembly.getBOM();

  if (!ready) return null;

  return (
    <div className="app">
      <Sidebar onSelectPart={handleSelectPart} activeMode={mode} />
      <div className="main-area">
        <Toolbar
          onUndo={handleUndo}
          onRedo={handleRedo}
          onDelete={
            selectedPartId ? () => handleDeletePart(selectedPartId) : undefined
          }
          onClear={handleClear}
          onSave={handleSave}
          onLoad={handleLoad}
          onEscape={handleEscape}
          mode={mode}
        />
        <ViewportCanvas
          parts={snapshot.parts}
          mode={mode}
          selectedPartId={selectedPartId}
          assembly={assembly}
          onPlacePart={handlePlacePart}
          onMovePart={handleMovePart}
          onClickPart={handleClickPart}
          onClickEmpty={handleClickEmpty}
          onDeletePart={handleDeletePart}
          onEscape={handleEscape}
        />
      </div>
      <BOMPanel entries={bom} />
    </div>
  );
}
