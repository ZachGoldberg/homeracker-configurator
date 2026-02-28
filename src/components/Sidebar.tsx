import { useState, useSyncExternalStore, useCallback } from "react";
import { PART_CATALOG } from "../data/catalog";
import { PART_COLORS } from "../constants";
import { subscribeCustomParts, getCustomPartsSnapshot, importSTL } from "../data/custom-parts";
import { useThumbnail } from "../thumbnails/useThumbnail";
import type { InteractionMode, PartCategory, PartDefinition } from "../types";

interface SidebarProps {
  onSelectPart: (definitionId: string) => void;
  activeMode: InteractionMode;
}

const SECTIONS: { key: string; label: string; filter: (p: PartDefinition) => boolean }[] = [
  { key: "connector", label: "Connectors", filter: (p) => p.category === "connector" && !p.id.includes("-pt-") && !p.id.includes("-foot") },
  { key: "connector-pt", label: "Pull-Through", filter: (p) => p.category === "connector" && p.id.includes("-pt-") },
  { key: "support", label: "Supports", filter: (p) => p.category === "support" },
  { key: "connector-foot", label: "Feet", filter: (p) => p.category === "connector" && p.id.includes("-foot") && !p.id.includes("-pt-") },
  { key: "lockpin", label: "Lock Pins", filter: (p) => p.category === "lockpin" },
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
  const thumbnail = useThumbnail(part);
  return (
    <button
      className={`catalog-item ${isActive ? "active" : ""}`}
      onClick={onSelect}
      title={part.description}
    >
      <div
        className="catalog-item-preview"
        style={{
          backgroundColor: thumbnail ? "#d0d0d0" : color + "55",
          borderColor: color,
        }}
      >
        {thumbnail ? (
          <img src={thumbnail} alt={part.name} className="catalog-item-thumbnail" />
        ) : (
          <div className="catalog-item-icon" style={{ color }}>
            {getCategoryIcon(part.category)}
          </div>
        )}
      </div>
      <span className="catalog-item-name">{part.name}</span>
    </button>
  );
}

export function Sidebar({ onSelectPart, activeMode }: SidebarProps) {
  const activePlaceId =
    activeMode.type === "place" ? activeMode.definitionId : null;

  const [searchQuery, setSearchQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("homeracker-collapsed");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

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

  const toggleCategory = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try { localStorage.setItem("homeracker-collapsed", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const query = searchQuery.toLowerCase().trim();
  const isSearching = query.length > 0;

  const filterParts = (parts: PartDefinition[]) =>
    isSearching ? parts.filter((p) => p.name.toLowerCase().includes(query)) : parts;

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h1>HomeRacker</h1>
        <p className="sidebar-subtitle">Configurator</p>
      </div>

      <div className="sidebar-search-container">
        <input
          className="sidebar-search"
          type="text"
          placeholder="Filter parts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setSearchQuery(""); }}
        />
      </div>

      {SECTIONS.map(({ key, label, filter }) => {
        const parts = filterParts(PART_CATALOG.filter(filter));
        if (parts.length === 0) return null;

        const isCollapsed = !isSearching && collapsed.has(key);

        return (
          <div key={key} className="catalog-section">
            <h2
              className="catalog-section-title"
              onClick={() => toggleCategory(key)}
            >
              <span className="catalog-section-toggle">{isCollapsed ? "\u25b8" : "\u25be"}</span>
              {label}
              <span className="catalog-section-count">{parts.length}</span>
            </h2>
            {!isCollapsed && (
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
            )}
          </div>
        );
      })}

      {/* Custom / Imported section */}
      {(() => {
        const customParts = filterParts(customSnapshot.definitions);
        const isCustomCollapsed = !isSearching && collapsed.has("custom");
        if (isSearching && customParts.length === 0) return null;

        return (
          <div className="catalog-section">
            <h2
              className="catalog-section-title"
              onClick={() => toggleCategory("custom")}
            >
              <span className="catalog-section-toggle">{isCustomCollapsed ? "\u25b8" : "\u25be"}</span>
              Custom
              {customParts.length > 0 && (
                <span className="catalog-section-count">{customParts.length}</span>
              )}
            </h2>
            {!isCustomCollapsed && (
              <>
                {customParts.length > 0 && (
                  <div className="catalog-grid" style={{ marginBottom: 8 }}>
                    {customParts.map((part) => (
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
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}
