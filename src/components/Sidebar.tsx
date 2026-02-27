import { PART_CATALOG } from "../data/catalog";
import { PART_COLORS } from "../constants";
import type { InteractionMode, PartCategory } from "../types";

interface SidebarProps {
  onSelectPart: (definitionId: string) => void;
  activeMode: InteractionMode;
}

const CATEGORIES: { key: PartCategory; label: string }[] = [
  { key: "connector", label: "Connectors" },
  { key: "support", label: "Supports" },
  { key: "lockpin", label: "Lock Pins" },
];

export function Sidebar({ onSelectPart, activeMode }: SidebarProps) {
  const activePlaceId =
    activeMode.type === "place" ? activeMode.definitionId : null;

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
                <button
                  key={part.id}
                  className={`catalog-item ${activePlaceId === part.id ? "active" : ""}`}
                  onClick={() => onSelectPart(part.id)}
                  title={part.description}
                >
                  <div
                    className="catalog-item-preview"
                    style={{
                      backgroundColor: PART_COLORS[part.category] + "33",
                      borderColor: PART_COLORS[part.category],
                    }}
                  >
                    <div
                      className="catalog-item-icon"
                      style={{ color: PART_COLORS[part.category] }}
                    >
                      {part.category === "connector"
                        ? "+"
                        : part.category === "support"
                          ? "||"
                          : "."}
                    </div>
                  </div>
                  <span className="catalog-item-name">{part.name}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
