import type { InteractionMode } from "../types";

interface ToolbarProps {
  onUndo: () => void;
  onRedo: () => void;
  onDelete?: () => void;
  selectedCount: number;
  onClear: () => void;
  onSave: () => void;
  onLoad: () => void;
  onShare: () => void;
  onEscape: () => void;
  mode: InteractionMode;
  customCollisionOff: boolean;
  onToggleCustomCollision: () => void;
}

export function Toolbar({
  onUndo,
  onRedo,
  onDelete,
  selectedCount,
  onClear,
  onSave,
  onLoad,
  onShare,
  onEscape,
  mode,
  customCollisionOff,
  onToggleCustomCollision,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button className="toolbar-btn" onClick={onUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button
          className="toolbar-btn"
          onClick={onRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo
        </button>
      </div>

      <div className="toolbar-group">
        {onDelete && (
          <button
            className="toolbar-btn toolbar-btn-danger"
            onClick={onDelete}
            title="Delete selected (Del)"
          >
            Delete{selectedCount > 1 ? ` (${selectedCount})` : ""}
          </button>
        )}
        <button
          className="toolbar-btn toolbar-btn-danger"
          onClick={onClear}
          title="Clear all parts"
        >
          Clear All
        </button>
      </div>

      <div className="toolbar-group">
        <button className="toolbar-btn" onClick={onSave} title="Save assembly">
          Save
        </button>
        <button className="toolbar-btn" onClick={onLoad} title="Load assembly">
          Load
        </button>
        <button className="toolbar-btn" onClick={onShare} title="Copy shareable link">
          Share
        </button>
      </div>

      <div className="toolbar-group">
        <button
          className={`toolbar-btn${customCollisionOff ? " toolbar-btn-active" : ""}`}
          onClick={onToggleCustomCollision}
          title="Toggle collision detection for custom STL parts"
        >
          STL Collision: {customCollisionOff ? "Off" : "On"}
        </button>
      </div>

      {mode.type === "place" && (
        <div className="toolbar-group">
          <span className="toolbar-mode-label">
            Placing: {mode.definitionId}
          </span>
          <button className="toolbar-btn" onClick={onEscape}>
            Cancel (Esc)
          </button>
        </div>
      )}

      {mode.type === "paste" && (
        <div className="toolbar-group">
          <span className="toolbar-mode-label">
            Pasting {mode.clipboard.parts.length} part(s)
          </span>
          <button className="toolbar-btn" onClick={onEscape}>
            Cancel (Esc)
          </button>
        </div>
      )}
    </div>
  );
}
