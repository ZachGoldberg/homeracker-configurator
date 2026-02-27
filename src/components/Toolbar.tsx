import type { InteractionMode } from "../types";

interface ToolbarProps {
  onUndo: () => void;
  onRedo: () => void;
  onDelete?: () => void;
  onClear: () => void;
  onSave: () => void;
  onLoad: () => void;
  onEscape: () => void;
  mode: InteractionMode;
}

export function Toolbar({
  onUndo,
  onRedo,
  onDelete,
  onClear,
  onSave,
  onLoad,
  onEscape,
  mode,
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
            Delete
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
    </div>
  );
}
