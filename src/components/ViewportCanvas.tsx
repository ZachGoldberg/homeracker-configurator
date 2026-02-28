import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, useGLTF } from "@react-three/drei";
import { useCallback, useRef, useState, useEffect, useMemo, Suspense } from "react";
import * as THREE from "three";
import { BASE_UNIT, PART_COLORS, GRID_EXTENT } from "../constants";
import type { PlacedPart, InteractionMode, GridPosition, Rotation3, RotationStep, Axis, DragState, ClipboardData } from "../types";
import { getPartDefinition } from "../data/catalog";
import { isCustomPart, getCustomPartGeometry } from "../data/custom-parts";
import { AssemblyState } from "../assembly/AssemblyState";
import { nextOrientation, orientationToRotation, transformCell, rotateGridCells, computeGroundLift } from "../assembly/grid-utils";
import { findBestSnap, findBestConnectorSnap, type GridRay } from "../assembly/snap";

/**
 * Create a MeshStandardMaterial with a custom color, preserving surface detail
 * (normal maps, roughness maps, AO) from the original GLB material when available.
 */
function makeColorMaterial(
  color: string,
  original?: THREE.Material | null,
  overrides?: { transparent?: boolean; opacity?: number; emissive?: THREE.Color; emissiveIntensity?: number },
): THREE.MeshStandardMaterial {
  const src = original instanceof THREE.MeshStandardMaterial ? original : null;
  return new THREE.MeshStandardMaterial({
    ...src as THREE.MeshStandardMaterialParameters,
    color: new THREE.Color(color),
    vertexColors: false,
    ...overrides,
  });
}

interface ViewportProps {
  parts: PlacedPart[];
  mode: InteractionMode;
  selectedPartIds: Set<string>;
  assembly: AssemblyState;
  onPlacePart: (definitionId: string, position: GridPosition, rotation: PlacedPart["rotation"], orientation?: Axis) => void;
  onMovePart: (instanceId: string, newPosition: GridPosition, rotation?: Rotation3, orientation?: Axis) => void;
  onMoveSelectedParts: (primaryId: string, newPosition: GridPosition, rotation?: Rotation3, orientation?: Axis) => void;
  onClickPart: (instanceId: string, shiftKey: boolean) => void;
  onClickEmpty: () => void;
  onDeleteSelected: () => void;
  onPasteParts: (clipboard: ClipboardData, targetPosition: GridPosition) => void;
  onBoxSelect: (ids: string[]) => void;
  onNudgeParts: (dx: number, dy: number, dz: number) => void;
  onEscape: () => void;
  flashPartId: string | null;
  snapEnabled: boolean;
}

/** Convert grid coordinates to world position (mm).
 *  Y is offset by half a cell so that grid Y=0 sits ON the ground (bottom at world Y=0). */
function gridToWorld(pos: GridPosition): [number, number, number] {
  return [pos[0] * BASE_UNIT, pos[1] * BASE_UNIT + BASE_UNIT / 2, pos[2] * BASE_UNIT];
}

/** Snap a world position to the nearest grid point (inverse of gridToWorld) */
function snapToGrid(worldPos: THREE.Vector3): GridPosition {
  return [
    Math.round(worldPos.x / BASE_UNIT),
    Math.round((worldPos.y - BASE_UNIT / 2) / BASE_UNIT),
    Math.round(worldPos.z / BASE_UNIT),
  ];
}

/**
 * Compute the offset to center a GLB model over its grid cells.
 * GLB models are centered at origin; this shifts them so the model
 * spans all occupied cells correctly.
 *
 * Grid cells are center-based: gridToWorld maps index → cell center.
 * The offset is the average of cell center positions (in oriented space).
 *
 * When an orientation is provided, cells are first transformed to the
 * oriented space. The offset is computed in world space (OUTSIDE the
 * orientation rotation group).
 */
function modelCenterOffset(def: { gridCells: GridPosition[] }, orientation: Axis = "y"): [number, number, number] {
  const cells = def.gridCells.map((c) => transformCell(c, orientation));
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const maxZ = Math.max(...cells.map((c) => c[2]));
  return [
    ((minX + maxX) / 2) * BASE_UNIT,
    ((minY + maxY) / 2) * BASE_UNIT,
    ((minZ + maxZ) / 2) * BASE_UNIT,
  ];
}

/** A placed part rendered with its actual GLB model (or custom STL geometry) */
function PartMesh({
  part,
  isSelected,
  isDragging,
  isPlacing,
  isFlashing,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  isFlashing: boolean;
  onPointerDown: (e: any) => void;
}) {
  const def = getPartDefinition(part.definitionId);
  if (!def) return null;

  if (isCustomPart(part.definitionId)) {
    return <CustomPartMesh part={part} isSelected={isSelected} isDragging={isDragging} isPlacing={isPlacing} isFlashing={isFlashing} onPointerDown={onPointerDown} />;
  }

  return (
    <Suspense fallback={<PartMeshFallback part={part} isSelected={isSelected} onClick={() => { }} />}>
      <PartMeshLoaded part={part} isSelected={isSelected} isDragging={isDragging} isPlacing={isPlacing} isFlashing={isFlashing} onPointerDown={onPointerDown} />
    </Suspense>
  );
}

/** Rendered mesh for a custom STL-imported part */
function CustomPartMesh({
  part,
  isSelected,
  isDragging,
  isPlacing,
  isFlashing,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  isFlashing: boolean;
  onPointerDown: (e: any) => void;
}) {
  const def = getPartDefinition(part.definitionId)!;
  const geometry = getCustomPartGeometry(part.definitionId);
  if (!geometry) return null;

  const worldPos = gridToWorld(part.position);
  const partEuler = degreesToEuler(part.rotation);
  // Compute offset from ROTATED cells so it stays correct after rotation
  const rotatedCells = rotateGridCells(def.gridCells, part.rotation);
  const offset = modelCenterOffset({ gridCells: rotatedCells });
  const flashRef = useRef<THREE.MeshStandardMaterial>(null);
  const flashStart = useRef(0);

  useFrame(({ clock }) => {
    if (!flashRef.current) return;
    if (isFlashing) {
      if (flashStart.current === 0) flashStart.current = clock.elapsedTime;
      const t = clock.elapsedTime - flashStart.current;
      const pulse = Math.sin(t * 10) * 0.5 + 0.5; // fast oscillation
      flashRef.current.emissiveIntensity = pulse * 0.8;
      flashRef.current.emissive = new THREE.Color(0xffffff);
    } else {
      flashStart.current = 0;
      flashRef.current.emissiveIntensity = 0;
    }
  });

  const categoryColor = part.color ?? PART_COLORS.custom;
  const color = isSelected ? PART_COLORS.selected : categoryColor;
  const opacity = isDragging ? 0.3 : 1;

  return (
    <group
      name={`placed-${part.instanceId}`}
      position={worldPos}
      onPointerDown={(e) => {
        if (!isPlacing) e.stopPropagation();
        onPointerDown(e);
      }}
      onClick={(e) => { if (!isPlacing) e.stopPropagation(); }}
    >
      <group position={offset}>
        <group rotation={partEuler}>
          <mesh geometry={geometry}>
            <meshStandardMaterial ref={flashRef} color={color} roughness={1} metalness={0} transparent={isDragging} opacity={opacity} />
          </mesh>
        </group>
      </group>
      {isSelected && !isDragging && (
        <mesh position={offset}>
          <boxGeometry args={[BASE_UNIT * 1.1, BASE_UNIT * 1.1, BASE_UNIT * 1.1]} />
          <meshBasicMaterial color={PART_COLORS.selected} wireframe transparent opacity={0.3} />
        </mesh>
      )}
    </group>
  );
}

/** GLB-loaded part mesh */
function PartMeshLoaded({
  part,
  isSelected,
  isDragging,
  isPlacing,
  isFlashing,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  isFlashing: boolean;
  onPointerDown: (e: any) => void;
}) {
  const def = getPartDefinition(part.definitionId)!;
  const { scene } = useGLTF(def.modelPath);
  const cloned = useMemo(() => scene.clone(), [scene]);
  const worldPos = gridToWorld(part.position);
  const groupRef = useRef<THREE.Group>(null);

  // Store original materials so we can restore them on deselect
  const originalMaterials = useRef<WeakMap<THREE.Mesh, THREE.Material>>(new WeakMap());

  // Apply selection highlight, drag dimming, or custom color (skip while flashing — useFrame handles that)
  useEffect(() => {
    if (!groupRef.current || isFlashing) return;
    groupRef.current.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        // Save original material on first encounter
        if (!originalMaterials.current.has(child)) {
          originalMaterials.current.set(child, child.material);
        }
        const orig = originalMaterials.current.get(child) ?? child.material;
        if (isDragging) {
          if (part.color) {
            child.material = makeColorMaterial(part.color, orig, { transparent: true, opacity: 0.3 });
          } else {
            const mat = orig.clone();
            mat.transparent = true;
            mat.opacity = 0.3;
            child.material = mat;
          }
        } else if (isSelected) {
          if (part.color) {
            child.material = makeColorMaterial(part.color, orig, {
              emissive: new THREE.Color(PART_COLORS.selected),
              emissiveIntensity: 0.3,
            });
          } else {
            const mat = orig.clone();
            mat.emissive = new THREE.Color(PART_COLORS.selected);
            mat.emissiveIntensity = 0.3;
            child.material = mat;
          }
        } else if (part.color) {
          child.material = makeColorMaterial(part.color, orig);
        } else {
          // Restore original material
          const orig = originalMaterials.current.get(child);
          if (orig) child.material = orig;
        }
      }
    });
  }, [isSelected, isDragging, isFlashing, part.color]);

  // Flash animation for "find part" from selection panel
  const flashStart = useRef(0);
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    if (isFlashing) {
      if (flashStart.current === 0) flashStart.current = clock.elapsedTime;
      const t = clock.elapsedTime - flashStart.current;
      const pulse = Math.sin(t * 10) * 0.5 + 0.5;
      groupRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material?.emissive) {
          child.material.emissive = new THREE.Color(0xffffff);
          child.material.emissiveIntensity = pulse * 0.8;
        }
      });
    } else if (flashStart.current !== 0) {
      flashStart.current = 0;
      // Restore after flash: if custom color is set, re-apply it; otherwise restore original
      groupRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (part.color) {
            const orig = originalMaterials.current.get(child) ?? child.material;
            child.material = makeColorMaterial(part.color, orig);
          } else {
            const orig = originalMaterials.current.get(child);
            if (orig) child.material = orig;
          }
        }
      });
    }
  });

  const partEuler = degreesToEuler(part.rotation);
  const orientEuler = degreesToEuler(orientationToRotation(part.orientation ?? "y"));
  // Compute offset from oriented THEN rotated cells — placed outside both rotation groups
  const orient = part.orientation ?? "y";
  const orientedCells = def.gridCells.map((c) => transformCell(c, orient));
  const rotatedCells = rotateGridCells(orientedCells, part.rotation);
  const offset = modelCenterOffset({ gridCells: rotatedCells });

  return (
    <group
      name={`placed-${part.instanceId}`}
      position={worldPos}
      onPointerDown={(e) => {
        if (!isPlacing) e.stopPropagation();
        onPointerDown(e);
      }}
      onClick={(e) => { if (!isPlacing) e.stopPropagation(); }}
    >
      <group position={offset}>
        <group rotation={partEuler}>
          <group rotation={orientEuler}>
            <primitive
              ref={groupRef}
              object={cloned}
            />
          </group>
        </group>
      </group>
      {isSelected && !isDragging && (
        <mesh position={offset}>
          <boxGeometry args={[BASE_UNIT * 1.1, BASE_UNIT * 1.1, BASE_UNIT * 1.1]} />
          <meshBasicMaterial
            color={PART_COLORS.selected}
            wireframe
            transparent
            opacity={0.3}
          />
        </mesh>
      )}
    </group>
  );
}

/** Fallback box while GLB is loading */
function PartMeshFallback({
  part,
  isSelected,
  onClick,
}: {
  part: PlacedPart;
  isSelected: boolean;
  onClick: () => void;
}) {
  const def = getPartDefinition(part.definitionId);
  if (!def) return null;

  const worldPos = gridToWorld(part.position);
  const color = isSelected
    ? PART_COLORS.selected
    : (part.color || PART_COLORS[def.category] || "#888888");

  // Use oriented + rotated cells for correct sizing and offset
  const orient = part.orientation ?? "y";
  const orientedCells = def.gridCells.map((c) => transformCell(c, orient));
  const cells = rotateGridCells(orientedCells, part.rotation);
  const offset = modelCenterOffset({ gridCells: cells });

  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const maxZ = Math.max(...cells.map((c) => c[2]));

  const sizeX = (maxX - minX + 1) * BASE_UNIT;
  const sizeY = (maxY - minY + 1) * BASE_UNIT;
  const sizeZ = (maxZ - minZ + 1) * BASE_UNIT;

  // Box dimensions already reflect orientation + rotation — no rotation group needed
  return (
    <group position={worldPos}>
      <mesh
        position={offset}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        <boxGeometry args={[sizeX * 0.9, sizeY * 0.9, sizeZ * 0.9]} />
        <meshStandardMaterial color={color} transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

/** Convert a Rotation3 (degrees) to a radians Euler tuple for Three.js */
function degreesToEuler(rot: Rotation3): [number, number, number] {
  return [
    (rot[0] * Math.PI) / 180,
    (rot[1] * Math.PI) / 180,
    (rot[2] * Math.PI) / 180,
  ];
}

/** Cycle a single rotation step: 0 -> 90 -> 180 -> 270 -> 0 */
function nextStep(step: RotationStep): RotationStep {
  const steps: RotationStep[] = [0, 90, 180, 270];
  return steps[(steps.indexOf(step) + 1) % 4];
}

/** Ghost preview model — loads the actual GLB with a transparent tint */
function GhostModel({
  definitionId,
  rotation,
  orientation,
  isSnapped,
}: {
  definitionId: string;
  rotation: Rotation3;
  orientation?: Axis;
  isSnapped?: boolean;
}) {
  if (isCustomPart(definitionId)) {
    return <CustomGhostModel definitionId={definitionId} rotation={rotation} isSnapped={isSnapped} />;
  }

  return <GLBGhostModel definitionId={definitionId} rotation={rotation} orientation={orientation} isSnapped={isSnapped} />;
}

/** Ghost preview for GLB-based parts */
function GLBGhostModel({
  definitionId,
  rotation,
  orientation,
  isSnapped,
}: {
  definitionId: string;
  rotation: Rotation3;
  orientation?: Axis;
  isSnapped?: boolean;
}) {
  const def = getPartDefinition(definitionId)!;
  const { scene } = useGLTF(def.modelPath);
  const cloned = useMemo(() => scene.clone(), [scene]);
  const groupRef = useRef<THREE.Group>(null);
  const color = isSnapped ? PART_COLORS.ghost_snapped : PART_COLORS.ghost_valid;

  useEffect(() => {
    if (!groupRef.current) return;
    groupRef.current.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.material = new THREE.MeshStandardMaterial({
          color,
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
        });
      }
    });
  }, [color]);

  const euler = degreesToEuler(rotation);
  const orient = orientation ?? "y";
  const orientEuler = degreesToEuler(orientationToRotation(orient));
  // Compute offset from oriented THEN rotated cells — placed outside both rotation groups
  const orientedCells = def.gridCells.map((c) => transformCell(c, orient));
  const rotatedCells = rotateGridCells(orientedCells, rotation);
  const offset = modelCenterOffset({ gridCells: rotatedCells });

  return (
    <group position={offset}>
      <group rotation={euler}>
        <group rotation={orientEuler}>
          <primitive
            ref={groupRef}
            object={cloned}
          />
        </group>
      </group>
    </group>
  );
}

/** Ghost preview for custom STL-imported parts */
function CustomGhostModel({
  definitionId,
  rotation,
  isSnapped,
}: {
  definitionId: string;
  rotation: Rotation3;
  isSnapped?: boolean;
}) {
  const def = getPartDefinition(definitionId)!;
  const geometry = getCustomPartGeometry(definitionId);
  if (!geometry) return null;

  const color = isSnapped ? PART_COLORS.ghost_snapped : PART_COLORS.ghost_valid;

  const euler = degreesToEuler(rotation);
  // Compute offset from rotated cells — placed outside rotation
  const rotatedCells = rotateGridCells(def.gridCells, rotation);
  const offset = modelCenterOffset({ gridCells: rotatedCells });

  return (
    <group position={offset}>
      <group rotation={euler}>
        <mesh geometry={geometry}>
          <meshStandardMaterial color={color} transparent opacity={0.4} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
}

/** Fallback box while ghost GLB is loading */
function GhostFallback({ definitionId, orientation }: { definitionId: string; orientation?: Axis }) {
  const def = getPartDefinition(definitionId);
  if (!def) return null;

  const orient = orientation ?? "y";
  const cells = def.gridCells.map((c) => transformCell(c, orient));
  const offset = modelCenterOffset({ gridCells: cells });

  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const maxZ = Math.max(...cells.map((c) => c[2]));

  const sizeX = (maxX - minX + 1) * BASE_UNIT;
  const sizeY = (maxY - minY + 1) * BASE_UNIT;
  const sizeZ = (maxZ - minZ + 1) * BASE_UNIT;

  // No rotation needed — box dimensions already reflect oriented space
  return (
    <mesh position={offset}>
      <boxGeometry args={[sizeX * 0.95, sizeY * 0.95, sizeZ * 0.95]} />
      <meshStandardMaterial
        color={PART_COLORS.ghost_valid}
        transparent
        opacity={0.4}
        depthWrite={false}
      />
    </mesh>
  );
}

/** Shared ghost placement state — written by GhostPreview each frame, read by Scene on click */
interface GhostState {
  position: GridPosition;
  orientation: Axis;
  rotation: Rotation3;
  isSnapped: boolean;
}

/** Ghost preview for placement mode */
function GhostPreview({
  definitionId,
  assembly,
  ghostOrientation,
  ghostRotation,
  ghostStateRef,
  yLift,
  snapEnabled,
}: {
  definitionId: string;
  assembly: AssemblyState;
  ghostOrientation: Axis;
  ghostRotation: Rotation3;
  ghostStateRef: React.MutableRefObject<GhostState>;
  yLift: number;
  snapEnabled: boolean;
}) {
  const { camera, raycaster, pointer } = useThree();
  const [gridPos, setGridPos] = useState<GridPosition>([0, 0, 0]);
  const [effectiveOrientation, setEffectiveOrientation] = useState<Axis>("y");
  const [effectiveRotation, setEffectiveRotation] = useState<Rotation3>([0, 0, 0]);
  const [isSnapped, setIsSnapped] = useState(false);
  const groundPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const intersectPoint = useMemo(() => new THREE.Vector3(), []);

  const def = getPartDefinition(definitionId);
  const isSupport = def?.category === "support";

  useFrame(() => {
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, intersectPoint)) return;

    const cursorGrid = snapToGrid(intersectPoint);
    cursorGrid[1] = 0; // cursor is on ground plane

    const gridRay: GridRay = {
      origin: [
        raycaster.ray.origin.x / BASE_UNIT,
        raycaster.ray.origin.y / BASE_UNIT,
        raycaster.ray.origin.z / BASE_UNIT,
      ],
      direction: [
        raycaster.ray.direction.x,
        raycaster.ray.direction.y,
        raycaster.ray.direction.z,
      ],
    };

    // Try snapping: supports snap to connector sockets, connectors snap to support endpoints
    const snap = snapEnabled
      ? (isSupport
        ? findBestSnap(assembly, definitionId, cursorGrid, 3, gridRay)
        : findBestConnectorSnap(assembly, definitionId, cursorGrid, 3, gridRay, ghostRotation))
      : null;

    if (snap) {
      const orient = isSupport ? snap.orientation : ghostOrientation;
      const snapRotation: Rotation3 = isSupport ? [0, 0, 0] : (snap.autoRotation ?? ghostRotation);
      // Snap position Y is already correct (adjacent to support endpoint); don't add yLift
      const liftedSnapPos: GridPosition = [snap.position[0], snap.position[1], snap.position[2]];
      // Debug: expose ghost snap state for e2e tests
      (window as any).__ghostDebug = {
        snapPos: snap.position,
        yLift,
        liftedSnapPos,
        orient,
        snapRotation,
        cursorGrid: [...cursorGrid],
        worldPos: gridToWorld(liftedSnapPos),
      };
      setGridPos(liftedSnapPos);
      setEffectiveOrientation(orient);
      setEffectiveRotation(snapRotation);
      setIsSnapped(true);
      ghostStateRef.current = {
        position: liftedSnapPos,
        orientation: orient,
        rotation: snapRotation,
        isSnapped: true,
      };
      return;
    }

    // No snap — use free placement with current orientation/rotation
    const orient = isSupport ? ghostOrientation : "y";
    const lift = def ? computeGroundLift(def, ghostRotation, orient) : 0;
    cursorGrid[1] = lift + yLift;

    setEffectiveOrientation(orient);
    setEffectiveRotation(ghostRotation);
    setGridPos(cursorGrid);
    setIsSnapped(false);
    ghostStateRef.current = {
      position: cursorGrid,
      orientation: orient,
      rotation: ghostRotation,
      isSnapped: false,
    };
  });

  if (!def) return null;

  const worldPos = gridToWorld(gridPos);
  const displayRotation = effectiveRotation;

  // Expose rendered state for e2e debugging
  (window as any).__ghostRender = {
    gridPos: [...gridPos],
    worldPos: [...worldPos],
    rotation: [...displayRotation],
    orientation: effectiveOrientation,
    isSnapped,
  };

  return (
    <group name="ghost-preview" position={worldPos}>
      <Suspense fallback={<GhostFallback definitionId={definitionId} orientation={effectiveOrientation} />}>
        <GhostModel definitionId={definitionId} rotation={displayRotation} orientation={effectiveOrientation} isSnapped={isSnapped} />
      </Suspense>
    </group>
  );
}

/** Drag preview — follows cursor on ground plane, snaps to connectors/supports */
function DragPreview({
  dragState,
  assembly,
  dropTargetRef,
  yLift,
  snapEnabled,
  selectedPartIds,
  parts,
}: {
  dragState: DragState;
  assembly: AssemblyState;
  dropTargetRef: React.MutableRefObject<{ position: GridPosition; orientation?: Axis; rotation?: Rotation3 }>;
  yLift: number;
  snapEnabled: boolean;
  selectedPartIds: Set<string>;
  parts: PlacedPart[];
}) {
  const { camera, raycaster, pointer } = useThree();
  const [gridPos, setGridPos] = useState<GridPosition>(dragState.originalPosition);
  const [effectiveOrientation, setEffectiveOrientation] = useState<Axis>(dragState.orientation ?? "y");
  const [isSnapped, setIsSnapped] = useState(false);
  const intersectPoint = useMemo(() => new THREE.Vector3(), []);

  // Raycast against a plane at the part's world Y so cursor-to-world mapping
  // matches the visual height (avoids perspective-induced speed mismatch).
  const partWorldY = gridToWorld(dragState.originalPosition)[1];
  const dragPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), -partWorldY), [partWorldY]);

  // Track the continuous (non-snapped) XZ offset between the cursor hit and
  // the part origin so the part stays anchored to the grab point.
  const grabOffsetRef = useRef<[number, number] | null>(null);

  const def = getPartDefinition(dragState.definitionId);
  const isSupport = def?.category === "support";

  useFrame(() => {
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(dragPlane, intersectPoint)) return;

    // On the first frame, compute grab offset in world coords for sub-cell accuracy
    if (grabOffsetRef.current === null) {
      const partWorldPos = gridToWorld(dragState.originalPosition);
      grabOffsetRef.current = [
        intersectPoint.x - partWorldPos[0],
        intersectPoint.z - partWorldPos[2],
      ];
    }

    // Subtract grab offset in world space, then snap to grid
    const offset = grabOffsetRef.current;
    intersectPoint.x -= offset[0];
    intersectPoint.z -= offset[1];

    const cursorGrid = snapToGrid(intersectPoint);
    cursorGrid[1] = 0;

    // Build grid-space ray for proximity-based snap
    const gridRay: GridRay = {
      origin: [
        raycaster.ray.origin.x / BASE_UNIT,
        raycaster.ray.origin.y / BASE_UNIT,
        raycaster.ray.origin.z / BASE_UNIT,
      ],
      direction: [
        raycaster.ray.direction.x,
        raycaster.ray.direction.y,
        raycaster.ray.direction.z,
      ],
    };

    // Try snap: supports → connector sockets, connectors → support endpoints
    const snap = snapEnabled
      ? (isSupport
        ? findBestSnap(assembly, dragState.definitionId, cursorGrid, 3, gridRay)
        : findBestConnectorSnap(assembly, dragState.definitionId, cursorGrid, 3, gridRay))
      : null;

    if (snap) {
      const orient = isSupport ? snap.orientation : (dragState.orientation ?? "y");
      // Snap position Y is already correct (adjacent to support endpoint); don't add yLift
      const liftedSnapPos: GridPosition = [snap.position[0], snap.position[1], snap.position[2]];
      setGridPos(liftedSnapPos);
      setEffectiveOrientation(orient);
      setIsSnapped(true);
      dropTargetRef.current = { position: liftedSnapPos, orientation: orient, rotation: dragState.rotation };
      return;
    }

    // No snap — free placement on ground plane
    const orient = dragState.orientation ?? "y";
    // Auto-lift if rotation pushes geometry below ground
    const dragLift = def ? computeGroundLift(def, dragState.rotation, orient) : 0;
    cursorGrid[1] = dragLift + yLift;
    setGridPos(cursorGrid);
    setEffectiveOrientation(orient);
    setIsSnapped(false);
    dropTargetRef.current = { position: cursorGrid, orientation: orient, rotation: dragState.rotation };
  });

  if (!def) return null;

  const worldPos = gridToWorld(gridPos);

  // Compute delta for multi-drag ghost rendering
  const isMultiDrag = selectedPartIds.size > 1 && selectedPartIds.has(dragState.instanceId);
  const delta: GridPosition = [
    gridPos[0] - dragState.originalPosition[0],
    gridPos[1] - dragState.originalPosition[1],
    gridPos[2] - dragState.originalPosition[2],
  ];

  return (
    <>
      <group name="drag-preview" position={worldPos}>
        <Suspense fallback={<GhostFallback definitionId={dragState.definitionId} orientation={effectiveOrientation} />}>
          <GhostModel definitionId={dragState.definitionId} rotation={dragState.rotation} orientation={effectiveOrientation} isSnapped={isSnapped} />
        </Suspense>
      </group>
      {isMultiDrag && parts.filter((p) => selectedPartIds.has(p.instanceId) && p.instanceId !== dragState.instanceId).map((p) => {
        const offsetPos: GridPosition = [p.position[0] + delta[0], p.position[1] + delta[1], p.position[2] + delta[2]];
        const wp = gridToWorld(offsetPos);
        return (
          <group key={p.instanceId} name={`drag-preview-${p.instanceId}`} position={wp}>
            <Suspense fallback={<GhostFallback definitionId={p.definitionId} orientation={p.orientation ?? "y"} />}>
              <GhostModel definitionId={p.definitionId} rotation={p.rotation} orientation={p.orientation ?? "y"} isSnapped={isSnapped} />
            </Suspense>
          </group>
        );
      })}
    </>
  );
}

/** Expose the R3F scene, camera, and controls on window for e2e testing */
function ExposeScene() {
  const { scene, camera, controls } = useThree();
  useEffect(() => {
    (window as any).__scene = scene;
    (window as any).__camera = camera;
    (window as any).__controls = controls;
  }, [scene, camera, controls]);
  return null;
}

/** On first render with parts, fit camera to show all placed parts */
function FitCamera({ parts }: { parts: PlacedPart[] }) {
  const { camera, controls } = useThree();
  const fitted = useRef(false);

  useEffect(() => {
    if (fitted.current || parts.length === 0) return;
    // Wait for OrbitControls to register via makeDefault
    const orbitControls = controls as any;
    if (!orbitControls?.target) return;

    fitted.current = true;

    // Compute bounding box of all part world positions
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const part of parts) {
      const def = getPartDefinition(part.definitionId);
      if (!def) continue;
      const orient = part.orientation ?? "y";
      const orientedCells = def.gridCells.map((c) => transformCell(c, orient));
      const cells = rotateGridCells(orientedCells, part.rotation);
      for (const cell of cells) {
        const wx = (part.position[0] + cell[0]) * BASE_UNIT;
        const wy = (part.position[1] + cell[1]) * BASE_UNIT + BASE_UNIT / 2;
        const wz = (part.position[2] + cell[2]) * BASE_UNIT;
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx + BASE_UNIT);
        minY = Math.min(minY, wy); maxY = Math.max(maxY, wy + BASE_UNIT);
        minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz + BASE_UNIT);
      }
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;

    // Position camera so the bounding sphere fits in view
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
    const dist = Math.max(radius / Math.tan((fov / 2) * Math.PI / 180), 100);

    camera.position.set(cx + dist * 0.6, cy + dist * 0.7, cz + dist * 0.6);
    camera.lookAt(cx, cy, cz);
    camera.updateProjectionMatrix();

    orbitControls.target.set(cx, cy, cz);
    orbitControls.update();
  }, [parts, camera, controls]);

  return null;
}

/** Shared paste ghost state — written by PasteGhostPreview each frame, read by Scene on click */
interface PasteGhostState {
  position: GridPosition;
}

/** Ghost preview for paste mode — renders all clipboard parts at cursor position */
function PasteGhostPreview({
  clipboard,
  pasteStateRef,
}: {
  clipboard: ClipboardData;
  pasteStateRef: React.MutableRefObject<PasteGhostState>;
}) {
  const { camera, raycaster, pointer } = useThree();
  const [gridPos, setGridPos] = useState<GridPosition>([0, 0, 0]);
  const groundPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const intersectPoint = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, intersectPoint)) return;

    const cursorGrid = snapToGrid(intersectPoint);
    cursorGrid[1] = 0;

    setGridPos(cursorGrid);
    pasteStateRef.current = { position: cursorGrid };
  });

  return (
    <group name="paste-preview">
      {clipboard.parts.map((cp, i) => {
        const pos: GridPosition = [
          gridPos[0] + cp.offset[0],
          gridPos[1] + cp.offset[1],
          gridPos[2] + cp.offset[2],
        ];
        const worldPos = gridToWorld(pos);
        return (
          <group key={i} position={worldPos}>
            <Suspense fallback={<GhostFallback definitionId={cp.definitionId} orientation={cp.orientation} />}>
              <GhostModel definitionId={cp.definitionId} rotation={cp.rotation} orientation={cp.orientation} />
            </Suspense>
          </group>
        );
      })}
    </group>
  );
}

interface SceneProps extends ViewportProps {
  ghostRotation: Rotation3;
  ghostOrientation: Axis;
  ghostStateRef: React.MutableRefObject<GhostState>;
  pasteStateRef: React.MutableRefObject<PasteGhostState>;
  dragState: DragState | null;
  dropTargetRef: React.MutableRefObject<{ position: GridPosition; orientation?: Axis; rotation?: Rotation3 }>;
  onPartPointerDown: (instanceId: string, nativeEvent: PointerEvent) => void;
  yLift: number;
  boxSelectActive: boolean;
}

/** Scene contents — lives inside the Canvas */
function Scene({
  parts,
  mode,
  selectedPartIds,
  assembly,
  onPlacePart,
  onPasteParts,
  onClickEmpty,
  ghostRotation,
  ghostOrientation,
  ghostStateRef,
  pasteStateRef,
  dragState,
  dropTargetRef,
  onPartPointerDown,
  yLift,
  flashPartId,
  snapEnabled,
  boxSelectActive,
}: SceneProps) {
  const groundRef = useRef<THREE.Mesh>(null);

  const handleGroundClick = useCallback(
    (e: any) => {
      if (dragState) return; // Don't handle ground clicks during drag
      if (mode.type === "place") {
        e.stopPropagation();
        const gs = ghostStateRef.current;
        onPlacePart(mode.definitionId, gs.position, gs.rotation, gs.orientation);
      } else if (mode.type === "paste") {
        e.stopPropagation();
        const ps = pasteStateRef.current;
        onPasteParts(mode.clipboard, ps.position);
      } else {
        onClickEmpty();
      }
    },
    [mode, onPlacePart, onPasteParts, onClickEmpty, ghostStateRef, pasteStateRef, dragState]
  );

  return (
    <>
      <ExposeScene />
      <FitCamera parts={parts} />
      {/* Lighting */}
      <ambientLight intensity={3.5} />
      <directionalLight position={[100, 200, 100]} intensity={1.8} castShadow />
      <directionalLight position={[-50, 100, -50]} intensity={1.0} />
      <directionalLight position={[0, -100, 50]} intensity={0.8} />

      {/* Camera controls — disabled during drag or box select */}
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} enabled={!dragState && !boxSelectActive} />

      {/* Grid floor */}
      <Grid
        position={[0, -0.1, 0]}
        args={[GRID_EXTENT * BASE_UNIT * 2, GRID_EXTENT * BASE_UNIT * 2]}
        cellSize={BASE_UNIT}
        cellThickness={0.5}
        cellColor="#666666"
        sectionSize={BASE_UNIT * 5}
        sectionThickness={1}
        sectionColor="#888888"
        fadeDistance={GRID_EXTENT * BASE_UNIT * 8}
        fadeStrength={1}
        infiniteGrid
      />

      {/* Invisible ground plane for raycasting */}
      <mesh
        ref={groundRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0]}
        onClick={handleGroundClick}
        visible={false}
      >
        <planeGeometry args={[GRID_EXTENT * BASE_UNIT * 4, GRID_EXTENT * BASE_UNIT * 4]} />
        <meshBasicMaterial />
      </mesh>

      {/* Axes indicator */}
      <GizmoHelper alignment="bottom-left" margin={[60, 60]}>
        <GizmoViewport labelColor="white" axisHeadScale={0.8} />
      </GizmoHelper>

      {/* Placed parts */}
      {parts.map((part) => (
        <PartMesh
          key={part.instanceId}
          part={part}
          isSelected={selectedPartIds.has(part.instanceId)}
          isDragging={dragState?.instanceId === part.instanceId}
          isPlacing={mode.type === "place"}
          isFlashing={flashPartId === part.instanceId}
          onPointerDown={(e) => onPartPointerDown(part.instanceId, e.nativeEvent)}
        />
      ))}

      {/* Ghost preview in placement mode */}
      {mode.type === "place" && (
        <GhostPreview
          definitionId={mode.definitionId}
          assembly={assembly}
          ghostOrientation={ghostOrientation}
          ghostRotation={ghostRotation}
          ghostStateRef={ghostStateRef}
          yLift={yLift}
          snapEnabled={snapEnabled}
        />
      )}

      {/* Drag preview */}
      {dragState && (
        <DragPreview
          dragState={dragState}
          assembly={assembly}
          dropTargetRef={dropTargetRef}
          yLift={yLift}
          snapEnabled={snapEnabled}
          selectedPartIds={selectedPartIds}
          parts={parts}
        />
      )}

      {/* Paste preview */}
      {mode.type === "paste" && (
        <PasteGhostPreview
          clipboard={mode.clipboard}
          pasteStateRef={pasteStateRef}
        />
      )}
    </>
  );
}

export function ViewportCanvas(props: ViewportProps) {
  const [ghostRotation, setGhostRotation] = useState<Rotation3>([0, 0, 0]);
  const [ghostOrientation, setGhostOrientation] = useState<Axis>("y");
  const ghostStateRef = useRef<GhostState>({
    position: [0, 0, 0],
    orientation: "y",
    rotation: [0, 0, 0],
    isSnapped: false,
  });

  // Paste state
  const pasteStateRef = useRef<PasteGhostState>({
    position: [0, 0, 0],
  });

  // Drag state
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dropTargetRef = useRef<{ position: GridPosition; orientation?: Axis; rotation?: Rotation3 }>({
    position: [0, 0, 0],
  });
  const pendingDragRef = useRef<{
    instanceId: string;
    startX: number;
    startY: number;
  } | null>(null);

  // Box-select (marquee) state
  const boxSelectRef = useRef<{ startX: number; startY: number } | null>(null);
  const [boxSelectRect, setBoxSelectRect] = useState<{
    x1: number; y1: number; x2: number; y2: number;
  } | null>(null);

  // Determine if we're placing a support (orientation cycling) vs connector (rotation)
  const placingId = props.mode.type === "place" ? props.mode.definitionId : null;
  const placingDef = placingId ? getPartDefinition(placingId) : null;
  const isPlacingSupport = placingDef?.category === "support";

  // Y-axis lift (W/S keys) — additive on top of auto ground lift
  const [yLift, setYLift] = useState(0);

  // Reset rotation, orientation, and lift when switching parts
  useEffect(() => {
    setGhostRotation([0, 0, 0]);
    setGhostOrientation("y");
    setYLift(0);
  }, [placingId]);

  const rotateAxis = useCallback((axis: 0 | 1 | 2) => {
    setGhostRotation((prev) => {
      const next: Rotation3 = [...prev];
      next[axis] = nextStep(next[axis]);
      return next;
    });
  }, []);

  // Handle pointer down on a part — records pending drag start
  const handlePartPointerDown = useCallback(
    (instanceId: string, nativeEvent: PointerEvent) => {
      if (props.mode.type !== "select") return;
      pendingDragRef.current = {
        instanceId,
        startX: nativeEvent.clientX,
        startY: nativeEvent.clientY,
      };
    },
    [props.mode]
  );

  // Window-level pointer move/up for drag detection and box-select
  useEffect(() => {
    const DRAG_THRESHOLD = 5;

    const handlePointerMove = (e: PointerEvent) => {
      // Box-select tracking
      const boxStart = boxSelectRef.current;
      if (boxStart) {
        const dx = e.clientX - boxStart.startX;
        const dy = e.clientY - boxStart.startY;
        if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) {
          setBoxSelectRect({
            x1: boxStart.startX,
            y1: boxStart.startY,
            x2: e.clientX,
            y2: e.clientY,
          });
        }
        return;
      }

      // Part drag tracking
      const pending = pendingDragRef.current;
      if (!pending) return;
      if (dragState) return; // Already dragging

      const dx = e.clientX - pending.startX;
      const dy = e.clientY - pending.startY;
      if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) {
        const part = props.assembly.getPartById(pending.instanceId);
        if (part) {
          // Preserve current Y elevation: yLift = currentY - autoGroundLift
          const def = getPartDefinition(part.definitionId);
          const groundLift = def ? computeGroundLift(def, part.rotation, part.orientation ?? "y") : 0;
          setYLift(Math.max(0, part.position[1] - groundLift));
          setDragState({
            instanceId: part.instanceId,
            definitionId: part.definitionId,
            originalPosition: part.position,
            rotation: part.rotation,
            orientation: part.orientation,
          });
        }
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      // Box-select finalize
      if (boxSelectRef.current) {
        if (boxSelectRect) {
          // Project each part to screen space and check if inside the rect
          const camera = (window as any).__camera as THREE.Camera | undefined;
          const canvas = document.querySelector(".viewport canvas") as HTMLCanvasElement | null;
          if (camera && canvas) {
            const rect = canvas.getBoundingClientRect();
            const minX = Math.min(boxSelectRect.x1, boxSelectRect.x2);
            const maxX = Math.max(boxSelectRect.x1, boxSelectRect.x2);
            const minY = Math.min(boxSelectRect.y1, boxSelectRect.y2);
            const maxY = Math.max(boxSelectRect.y1, boxSelectRect.y2);

            const matched: string[] = [];
            for (const part of props.parts) {
              const worldPos = new THREE.Vector3(
                part.position[0] * BASE_UNIT,
                part.position[1] * BASE_UNIT + BASE_UNIT / 2,
                part.position[2] * BASE_UNIT,
              );
              worldPos.project(camera);
              const sx = (worldPos.x * 0.5 + 0.5) * rect.width + rect.left;
              const sy = (-worldPos.y * 0.5 + 0.5) * rect.height + rect.top;
              if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
                matched.push(part.instanceId);
              }
            }
            if (matched.length > 0) {
              props.onBoxSelect(matched);
            }
          }
        }
        boxSelectRef.current = null;
        setBoxSelectRect(null);
        return;
      }

      // Part drag/click finalize
      const pending = pendingDragRef.current;
      if (!pending) return;

      if (dragState) {
        const target = dropTargetRef.current;
        // If dragging a part from a multi-selection, move all selected parts by the same delta
        if (props.selectedPartIds.size > 1 && props.selectedPartIds.has(dragState.instanceId)) {
          props.onMoveSelectedParts(dragState.instanceId, target.position, target.rotation, target.orientation);
        } else {
          props.onMovePart(dragState.instanceId, target.position, target.rotation, target.orientation);
        }
        setDragState(null);
      } else {
        props.onClickPart(pending.instanceId, e.shiftKey);
      }
      pendingDragRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, boxSelectRect, props.parts, props.assembly, props.onMovePart, props.onClickPart, props.onBoxSelect]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dragState) {
          setDragState(null);
          pendingDragRef.current = null;
          return;
        }
        props.onEscape();
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        props.selectedPartIds.size > 0
      ) {
        props.onDeleteSelected();
      } else if (dragState) {
        const rotateDrag = (axis: 0 | 1 | 2) => {
          const next: Rotation3 = [...dragState.rotation];
          next[axis] = nextStep(next[axis]);
          setDragState({ ...dragState, rotation: next });
        };
        switch (e.key.toLowerCase()) {
          case "r": rotateDrag(1); break;
          case "f": rotateDrag(2); break;
          case "t": rotateDrag(0); break;
          case "o": {
            const def = getPartDefinition(dragState.definitionId);
            if (def?.category === "support") {
              const newOrient = nextOrientation(dragState.orientation ?? "y");
              setDragState({ ...dragState, orientation: newOrient });
            }
            break;
          }
          case "w": setYLift((prev) => prev + 1); break;
          case "s": setYLift((prev) => Math.max(0, prev - 1)); break;
        }
      } else if (props.mode.type === "select" && props.selectedPartIds.size > 0) {
        // Arrow key nudge and W/S lift for selected parts
        const fine = e.shiftKey ? 0.1 : 1;
        switch (e.key) {
          case "ArrowLeft":  e.preventDefault(); props.onNudgeParts(-fine, 0, 0); break;
          case "ArrowRight": e.preventDefault(); props.onNudgeParts(fine, 0, 0); break;
          case "ArrowUp":    e.preventDefault(); props.onNudgeParts(0, 0, -fine); break;
          case "ArrowDown":  e.preventDefault(); props.onNudgeParts(0, 0, fine); break;
          case "w": case "W": props.onNudgeParts(0, fine, 0); break;
          case "s": case "S": props.onNudgeParts(0, -fine, 0); break;
        }
      } else if (props.mode.type === "place") {
        switch (e.key.toLowerCase()) {
          case "r": rotateAxis(1); break;
          case "f": rotateAxis(2); break;
          case "t": rotateAxis(0); break;
          case "o":
            if (isPlacingSupport) {
              setGhostOrientation((prev) => nextOrientation(prev));
            }
            break;
          case "w": setYLift((prev) => prev + 1); break;
          case "s": setYLift((prev) => Math.max(0, prev - 1)); break;
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.onEscape, props.onDeleteSelected, props.onNudgeParts, props.selectedPartIds, props.mode, isPlacingSupport, rotateAxis, dragState]);

  // Start box-select on shift+pointerdown on empty space
  const handleViewportPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (props.mode.type !== "select") return;
      if (!e.shiftKey) return;
      // If a part was clicked, pendingDragRef is already set — don't start box select
      if (pendingDragRef.current) return;
      boxSelectRef.current = { startX: e.clientX, startY: e.clientY };
    },
    [props.mode]
  );

  // Hint text
  let hintText: string | null = null;
  if (dragState) {
    const dragDef = getPartDefinition(dragState.definitionId);
    hintText = dragDef?.category === "support"
      ? "T(X) R(Y) F(Z) rotate · O orientation · W/S raise/lower · Release to place · Esc cancel"
      : "T(X) R(Y) F(Z) rotate · W/S raise/lower · Release to place · Esc cancel";
  } else if (props.mode.type === "place") {
    hintText = isPlacingSupport
      ? "Click to place · T(X) R(Y) F(Z) rotate · O orientation · W/S raise/lower · Esc cancel"
      : "Click to place · T(X) R(Y) F(Z) rotate · W/S raise/lower · Esc cancel";
  } else if (props.mode.type === "select" && props.selectedPartIds.size > 0) {
    hintText = "Arrow keys nudge · Shift+arrow fine nudge · ctrl-c/v copy/paste - Del delete · Esc deselect";
  } else if (props.mode.type === "paste") {
    hintText = `Click to paste ${props.mode.clipboard.parts.length} part(s) · Esc cancel`;
  }

  return (
    <div
      className="viewport"
      data-placing={props.mode.type === "place" ? props.mode.definitionId : undefined}
      onPointerDown={handleViewportPointerDown}
    >
      <Canvas
        camera={{ position: [150, 200, 150], fov: 50, near: 1, far: 10000 }}
        gl={{ antialias: true }}
        scene={{ background: new THREE.Color("#3d3d5c") }}
      >
        <Scene
          {...props}
          ghostRotation={ghostRotation}
          ghostOrientation={ghostOrientation}
          ghostStateRef={ghostStateRef}
          pasteStateRef={pasteStateRef}
          dragState={dragState}
          dropTargetRef={dropTargetRef}
          onPartPointerDown={handlePartPointerDown}
          yLift={yLift}
          boxSelectActive={!!boxSelectRect}
        />
      </Canvas>
      {boxSelectRect && (
        <div
          className="box-select-overlay"
          style={{
            left: Math.min(boxSelectRect.x1, boxSelectRect.x2),
            top: Math.min(boxSelectRect.y1, boxSelectRect.y2),
            width: Math.abs(boxSelectRect.x2 - boxSelectRect.x1),
            height: Math.abs(boxSelectRect.y2 - boxSelectRect.y1),
          }}
        />
      )}
      {hintText && (
        <div className="viewport-hint">
          {hintText}
        </div>
      )}
    </div>
  );
}
