import { useSyncExternalStore, useCallback } from "react";
import { PART_CATALOG } from "../data/catalog";
import { PART_COLORS } from "../constants";
import { subscribeCustomParts, getCustomPartsSnapshot, importSTL } from "../data/custom-parts";
import type { InteractionMode, PartCategory, PartDefinition } from "../types";

interface SidebarProps {
  onSelectPart: (definitionId: string) => void;
  activeMode: InteractionMode;
}

const CATEGORIES: { key: PartCategory; label: string }[] = [
  { key: "connector", label: "Connectors" },
  { key: "support", label: "Supports" },
  { key: "lockpin", label: "Lock Pins" },
];

function getCategoryIcon(category: PartCategory): string {
  switch (category) {
    case "connector": return "+";
    case "support": return "||";
    case "custom": return "STL";
    default: return ".";
  }
}

function PartButton({ part, isActive, onSelect }: { part: PartDefinition; isActive: boolean; onSelect: () => void }) {
  const color = PART_COLORS[part.category] || PART_COLORS.custom;
  return (
    <button
      className={`catalog-item ${isActive ? "active" : ""}`}
      onClick={onSelect}
      title={part.description}
    >
      <div
        className="catalog-item-preview"
        style={{
          backgroundColor: color + "33",
          borderColor: color,
        }}
      >
        <div className="catalog-item-icon" style={{ color }}>
          {getCategoryIcon(part.category)}
        </div>
      </div>
      <span className="catalog-item-name">{part.name}</span>
    </button>
  );
}

export function Sidebar({ onSelectPart, activeMode }: SidebarProps) {
  const activePlaceId =
    activeMode.type === "place" ? activeMode.definitionId : null;

  // Subscribe to custom parts changes
  const customSnapshot = useSyncExternalStore(
    subscribeCustomParts,
    getCustomPartsSnapshot,
  );

  const handleImportSTL = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".stl";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const def = await importSTL(file);
        onSelectPart(def.id);
      } catch (err) {
        console.error("STL import failed:", err);
      }
    };
    input.click();
  }, [onSelectPart]);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h1>HomeRacker</h1>
        <p className="sidebar-subtitle">Configurator</p>
      </div>

      {CATEGORIES.map(({ key, label }) => {
        const parts = PART_CATALOG.filter((p) => p.category === key);
        if (parts.length === 0) return null;

        return (
          <div key={key} className="catalog-section">
            <h2 className="catalog-section-title">{label}</h2>
            <div className="catalog-grid">
              {parts.map((part) => (
                <PartButton
                  key={part.id}
                  part={part}
                  isActive={activePlaceId === part.id}
                  onSelect={() => onSelectPart(part.id)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Custom / Imported section */}
      <div className="catalog-section">
        <h2 className="catalog-section-title">Custom</h2>
        {customSnapshot.definitions.length > 0 && (
          <div className="catalog-grid" style={{ marginBottom: 8 }}>
            {customSnapshot.definitions.map((part) => (
              <PartButton
                key={part.id}
                part={part}
                isActive={activePlaceId === part.id}
                onSelect={() => onSelectPart(part.id)}
              />
            ))}
          </div>
        )}
        <button className="catalog-import-btn" onClick={handleImportSTL}>
          Import STL
        </button>
      </div>
    </div>
  );
}
