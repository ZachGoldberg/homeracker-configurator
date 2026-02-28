import { useState, useCallback, useEffect, useSyncExternalStore } from "react";
import { ViewportCanvas } from "./ViewportCanvas";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { BOMPanel } from "./BOMPanel";
import { AssemblyState } from "../assembly/AssemblyState";
import { HistoryManager, type Command } from "../assembly/HistoryManager";
import type { InteractionMode, GridPosition, PlacedPart, Axis, Rotation3, ClipboardData } from "../types";
import { getPartDefinition } from "../data/catalog";
import { findBestSnap, findSnapPoints, findBestConnectorSnap, findConnectorSnapPoints } from "../assembly/snap";
import { computeGroundLift } from "../assembly/grid-utils";
import { restoreCustomParts, importSTL, isCustomPart } from "../data/custom-parts";
import { encodeAssemblyToHash, decodeAssemblyFromHash, hasCustomParts } from "../sharing/url-sharing";

// Global singleton instances
const assembly = new AssemblyState();
const history = new HistoryManager();

const STORAGE_KEY = "homeracker-scene";

// Restore custom parts (IndexedDB) THEN assembly (localStorage or URL hash).
// Custom part definitions must exist before deserialize() resolves their IDs.
const initPromise = restoreCustomParts()
  .catch(() => {}) // IndexedDB may be unavailable
  .then(async () => {
    // URL hash takes priority over localStorage
    if (location.hash.startsWith("#scene=")) {
      const data = await decodeAssemblyFromHash(location.hash);
      if (data) {
        assembly.deserialize(data);
        window.history.replaceState(null, "", location.pathname + location.search);
        return;
      }
    }
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
(window as any).__computeGroundLift = computeGroundLift;

export function App() {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<InteractionMode>({ type: "select" });
  const [selectedPartIds, setSelectedPartIds] = useState<Set<string>>(new Set());
  const [flashPartId, setFlashPartId] = useState<string | null>(null);

  const handleFlashPart = useCallback((instanceId: string) => {
    setFlashPartId(instanceId);
    setTimeout(() => setFlashPartId(null), 600);
  }, []);

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
    setSelectedPartIds(new Set());
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

  const handleDeleteSelected = useCallback(() => {
    if (selectedPartIds.size === 0) return;
    const partsToDelete = [...selectedPartIds]
      .map((id) => assembly.getPartById(id))
      .filter((p): p is PlacedPart => !!p)
      .map((p) => ({ ...p }));
    if (partsToDelete.length === 0) return;

    const cmd: Command = {
      description: `Delete ${partsToDelete.length} part(s)`,
      execute() {
        for (const p of partsToDelete) assembly.removePart(p.instanceId);
      },
      undo() {
        for (const p of partsToDelete) {
          assembly.addPart(p.definitionId, p.position, p.rotation, p.orientation);
        }
      },
    };
    history.execute(cmd);
    setSelectedPartIds(new Set());
  }, [selectedPartIds]);

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
    (instanceId: string, shiftKey: boolean) => {
      if (mode.type === "select") {
        setSelectedPartIds((prev) => {
          if (shiftKey) {
            const next = new Set(prev);
            if (next.has(instanceId)) next.delete(instanceId);
            else next.add(instanceId);
            return next;
          }
          // Toggle single selection
          if (prev.size === 1 && prev.has(instanceId)) return new Set();
          return new Set([instanceId]);
        });
      }
    },
    [mode]
  );

  const handleClickEmpty = useCallback(() => {
    setSelectedPartIds(new Set());
  }, []);

  const handleEscape = useCallback(() => {
    setMode({ type: "select" });
    setSelectedPartIds(new Set());
  }, []);

  const handleUndo = useCallback(() => { history.undo(); setSelectedPartIds(new Set()); }, []);
  const handleRedo = useCallback(() => { history.redo(); setSelectedPartIds(new Set()); }, []);

  const handleCopy = useCallback(() => {
    if (selectedPartIds.size === 0) return;
    const parts = [...selectedPartIds]
      .map((id) => assembly.getPartById(id))
      .filter((p): p is PlacedPart => !!p);
    if (parts.length === 0) return;

    const cx = parts.reduce((s, p) => s + p.position[0], 0) / parts.length;
    const cy = parts.reduce((s, p) => s + p.position[1], 0) / parts.length;
    const cz = parts.reduce((s, p) => s + p.position[2], 0) / parts.length;
    const centerX = Math.round(cx);
    const centerY = Math.round(cy);
    const centerZ = Math.round(cz);

    const clipboard: ClipboardData = {
      parts: parts.map((p) => ({
        definitionId: p.definitionId,
        offset: [
          p.position[0] - centerX,
          p.position[1] - centerY,
          p.position[2] - centerZ,
        ] as GridPosition,
        rotation: p.rotation,
        orientation: p.orientation,
      })),
    };
    navigator.clipboard.writeText(JSON.stringify({ homeracker: "clipboard", ...clipboard })).catch(() => {});
    setToast(`Copied ${parts.length} part(s)`);
    setTimeout(() => setToast(null), 2000);
  }, [selectedPartIds]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      const data = JSON.parse(text);
      if (data?.homeracker !== "clipboard" || !Array.isArray(data.parts)) return;
      const clipboard: ClipboardData = { parts: data.parts };
      setMode({ type: "paste", clipboard });
      setSelectedPartIds(new Set());
    } catch {
      // Not valid clipboard data — ignore
    }
  }, []);

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
      } else if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.preventDefault();
        handleCopy();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        e.preventDefault();
        handlePaste();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo, handleCopy, handlePaste]);

  const handleClear = useCallback(() => {
    assembly.clear();
    history.clear();
    setSelectedPartIds(new Set());
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
        setSelectedPartIds(new Set());
      } catch (e) {
        console.error("Failed to load assembly:", e);
      }
    };
    input.click();
  }, []);

  const handleToggleCustomCollision = useCallback(() => {
    assembly.setCustomPartsSkipCollision(!assembly.customPartsSkipCollision);
  }, []);

  const [toast, setToast] = useState<string | null>(null);

  const handleShare = useCallback(async () => {
    const data = assembly.serialize();
    if (hasCustomParts(data)) {
      data.parts = data.parts.filter((p) => !isCustomPart(p.type));
      if (data.parts.length === 0) {
        setToast("Nothing to share — custom STL parts can't be included in links");
        setTimeout(() => setToast(null), 3000);
        return;
      }
      setToast("Custom STL parts excluded from shared link");
      setTimeout(() => setToast(null), 3000);
    }
    const hash = await encodeAssemblyToHash(data);
    const url = location.origin + location.pathname + hash;
    await navigator.clipboard.writeText(url);
    setToast((prev) => prev ?? "Link copied to clipboard!");
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handlePasteParts = useCallback(
    (clipboard: ClipboardData, targetPosition: GridPosition) => {
      const addedParts: { definitionId: string; position: GridPosition; rotation: Rotation3; orientation?: Axis }[] = [];
      for (const cp of clipboard.parts) {
        const pos: GridPosition = [
          targetPosition[0] + cp.offset[0],
          targetPosition[1] + cp.offset[1],
          targetPosition[2] + cp.offset[2],
        ];
        if (assembly.canPlace(cp.definitionId, pos, cp.rotation, cp.orientation ?? "y")) {
          addedParts.push({ definitionId: cp.definitionId, position: pos, rotation: cp.rotation, orientation: cp.orientation });
        }
      }
      if (addedParts.length === 0) return;

      const cmd: Command = {
        description: `Paste ${addedParts.length} part(s)`,
        execute() {
          for (const p of addedParts) {
            assembly.addPart(p.definitionId, p.position, p.rotation, p.orientation);
          }
        },
        undo() {
          // Remove in reverse order
          for (let i = addedParts.length - 1; i >= 0; i--) {
            const p = addedParts[i];
            const parts = assembly.getAllParts();
            const match = parts.find(
              (pp) =>
                pp.definitionId === p.definitionId &&
                pp.position[0] === p.position[0] &&
                pp.position[1] === p.position[1] &&
                pp.position[2] === p.position[2]
            );
            if (match) assembly.removePart(match.instanceId);
          }
        },
      };
      history.execute(cmd);
      setMode({ type: "select" });
    },
    []
  );

  const bom = assembly.getBOM();

  if (!ready) return null;

  return (
    <div className="app">
      <Sidebar onSelectPart={handleSelectPart} activeMode={mode} />
      <div className="main-area">
        <Toolbar
          onUndo={handleUndo}
          onRedo={handleRedo}
          onDelete={selectedPartIds.size > 0 ? handleDeleteSelected : undefined}
          selectedCount={selectedPartIds.size}
          onClear={handleClear}
          onSave={handleSave}
          onLoad={handleLoad}
          onShare={handleShare}
          onEscape={handleEscape}
          mode={mode}
          customCollisionOff={snapshot.customPartsSkipCollision}
          onToggleCustomCollision={handleToggleCustomCollision}
        />
        <ViewportCanvas
          parts={snapshot.parts}
          mode={mode}
          selectedPartIds={selectedPartIds}
          assembly={assembly}
          onPlacePart={handlePlacePart}
          onMovePart={handleMovePart}
          onClickPart={handleClickPart}
          onClickEmpty={handleClickEmpty}
          onDeleteSelected={handleDeleteSelected}
          onPasteParts={handlePasteParts}
          onEscape={handleEscape}
          flashPartId={flashPartId}
        />
      </div>
      <BOMPanel entries={bom} selectedPartIds={selectedPartIds} parts={snapshot.parts} onFlashPart={handleFlashPart} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
