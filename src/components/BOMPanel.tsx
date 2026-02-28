import type { BOMEntry, PlacedPart } from "../types";
import { getPartDefinition } from "../data/catalog";

interface BOMPanelProps {
  entries: BOMEntry[];
  selectedPartIds: Set<string>;
  parts: PlacedPart[];
  onFlashPart: (instanceId: string) => void;
}

function exportCSV(entries: BOMEntry[]) {
  const header = "Part,Category,Quantity";
  const rows = entries.map(
    (e) => `"${e.name}","${e.category}",${e.quantity}`
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "homeracker-bom.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function BOMPanel({ entries, selectedPartIds, parts, onFlashPart }: BOMPanelProps) {
  const totalParts = entries.reduce((sum, e) => sum + e.quantity, 0);

  const selectedParts = parts.filter((p) => selectedPartIds.has(p.instanceId));

  return (
    <div className="bom-panel">
      <div className="bom-header">
        <h2>Bill of Materials</h2>
        {entries.length > 0 && (
          <button
            className="bom-export-btn"
            onClick={() => exportCSV(entries)}
            title="Export as CSV"
          >
            Export CSV
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="bom-empty">
          No parts placed yet. Select a part from the catalog and click on the
          grid to place it.
        </p>
      ) : (
        <>
          <table className="bom-table">
            <thead>
              <tr>
                <th>Part</th>
                <th>Qty</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.definitionId}>
                  <td>{entry.name}</td>
                  <td className="bom-qty">{entry.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="bom-total">Total: {totalParts} parts</div>
        </>
      )}

      {selectedParts.length > 0 && (
        <div className="selection-panel">
          <h3>Selected ({selectedParts.length})</h3>
          <ul className="selection-list">
            {selectedParts.map((p) => {
              const def = getPartDefinition(p.definitionId);
              return (
                <li
                  key={p.instanceId}
                  className="selection-item"
                  onClick={() => onFlashPart(p.instanceId)}
                >
                  {def?.name ?? p.definitionId}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
