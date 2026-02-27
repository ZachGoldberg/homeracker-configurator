import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, useGLTF } from "@react-three/drei";
import { useCallback, useRef, useState, useEffect, useMemo, Suspense } from "react";
import * as THREE from "three";
import { BASE_UNIT, PART_COLORS, GRID_EXTENT } from "../constants";
import type { PlacedPart, InteractionMode, GridPosition, Rotation3, RotationStep, Axis, DragState } from "../types";
import { getPartDefinition } from "../data/catalog";
import { isCustomPart, getCustomPartGeometry } from "../data/custom-parts";
import { AssemblyState } from "../assembly/AssemblyState";
import { nextOrientation, orientationToRotation, transformCell, rotateGridCells, computeGroundLift } from "../assembly/grid-utils";
import { findBestSnap, findBestConnectorSnap, type GridRay } from "../assembly/snap";

interface ViewportProps {
  parts: PlacedPart[];
  mode: InteractionMode;
  selectedPartId: string | null;
  assembly: AssemblyState;
  onPlacePart: (definitionId: string, position: GridPosition, rotation: PlacedPart["rotation"], orientation?: Axis) => void;
  onMovePart: (instanceId: string, newPosition: GridPosition, rotation?: Rotation3, orientation?: Axis) => void;
  onClickPart: (instanceId: string) => void;
  onClickEmpty: () => void;
  onDeletePart: (instanceId: string) => void;
  onEscape: () => void;
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
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  onPointerDown: (e: any) => void;
}) {
  const def = getPartDefinition(part.definitionId);
  if (!def) return null;

  if (isCustomPart(part.definitionId)) {
    return <CustomPartMesh part={part} isSelected={isSelected} isDragging={isDragging} isPlacing={isPlacing} onPointerDown={onPointerDown} />;
  }

  return (
    <Suspense fallback={<PartMeshFallback part={part} isSelected={isSelected} onClick={() => { }} />}>
      <PartMeshLoaded part={part} isSelected={isSelected} isDragging={isDragging} isPlacing={isPlacing} onPointerDown={onPointerDown} />
    </Suspense>
  );
}

/** Rendered mesh for a custom STL-imported part */
function CustomPartMesh({
  part,
  isSelected,
  isDragging,
  isPlacing,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
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
  const color = isSelected ? PART_COLORS.selected : PART_COLORS.custom;
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
            <meshStandardMaterial color={color} roughness={1} metalness={0} transparent={isDragging} opacity={opacity} />
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
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  onPointerDown: (e: any) => void;
}) {
  const def = getPartDefinition(part.definitionId)!;
  const { scene } = useGLTF(def.modelPath);
  const cloned = useMemo(() => scene.clone(), [scene]);
  const worldPos = gridToWorld(part.position);
  const groupRef = useRef<THREE.Group>(null);

  // Apply selection highlight or drag dimming
  useEffect(() => {
    if (!groupRef.current) return;
    groupRef.current.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        if (isDragging) {
          child.material = child.material.clone();
          child.material.transparent = true;
          child.material.opacity = 0.3;
        } else if (isSelected) {
          child.material = child.material.clone();
          child.material.emissive = new THREE.Color(PART_COLORS.selected);
          child.material.emissiveIntensity = 0.3;
        }
      }
    });
  }, [isSelected, isDragging]);

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
    : PART_COLORS[def.category] || "#888888";

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
  valid,
  rotation,
  orientation,
  isSnapped,
}: {
  definitionId: string;
  valid: boolean;
  rotation: Rotation3;
  orientation?: Axis;
  isSnapped?: boolean;
}) {
  if (isCustomPart(definitionId)) {
    return <CustomGhostModel definitionId={definitionId} valid={valid} rotation={rotation} isSnapped={isSnapped} />;
  }

  return <GLBGhostModel definitionId={definitionId} valid={valid} rotation={rotation} orientation={orientation} isSnapped={isSnapped} />;
}

/** Ghost preview for GLB-based parts */
function GLBGhostModel({
  definitionId,
  valid,
  rotation,
  orientation,
  isSnapped,
}: {
  definitionId: string;
  valid: boolean;
  rotation: Rotation3;
  orientation?: Axis;
  isSnapped?: boolean;
}) {
  const def = getPartDefinition(definitionId)!;
  const { scene } = useGLTF(def.modelPath);
  const cloned = useMemo(() => scene.clone(), [scene]);
  const groupRef = useRef<THREE.Group>(null);
  const color = !valid
    ? PART_COLORS.ghost_invalid
    : isSnapped
      ? PART_COLORS.ghost_snapped
      : PART_COLORS.ghost_valid;

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
  valid,
  rotation,
  isSnapped,
}: {
  definitionId: string;
  valid: boolean;
  rotation: Rotation3;
  isSnapped?: boolean;
}) {
  const def = getPartDefinition(definitionId)!;
  const geometry = getCustomPartGeometry(definitionId);
  if (!geometry) return null;

  const color = !valid
    ? PART_COLORS.ghost_invalid
    : isSnapped
      ? PART_COLORS.ghost_snapped
      : PART_COLORS.ghost_valid;

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
function GhostFallback({ definitionId, valid, orientation }: { definitionId: string; valid: boolean; orientation?: Axis }) {
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
        color={valid ? PART_COLORS.ghost_valid : PART_COLORS.ghost_invalid}
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
  valid: boolean;
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
}: {
  definitionId: string;
  assembly: AssemblyState;
  ghostOrientation: Axis;
  ghostRotation: Rotation3;
  ghostStateRef: React.MutableRefObject<GhostState>;
  yLift: number;
}) {
  const { camera, raycaster, pointer } = useThree();
  const [gridPos, setGridPos] = useState<GridPosition>([0, 0, 0]);
  const [valid, setValid] = useState(true);
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

    // Build grid-space ray for proximity-based snap filtering.
    // When looking at elevated snap points (e.g. support top), the ground-plane
    // cursor is displaced in XZ due to camera angle — the ray catches these cases.
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
    const snap = isSupport
      ? findBestSnap(assembly, definitionId, cursorGrid, 3, gridRay)
      : findBestConnectorSnap(assembly, definitionId, cursorGrid, 3, gridRay);

    if (snap) {
      const orient = isSupport ? snap.orientation : ghostOrientation;
      // When snapping a support, the snap engine provides position + orientation.
      // User rotation (R/T/F) would conflict, so override to identity for supports.
      const snapRotation: Rotation3 = isSupport ? [0, 0, 0] : ghostRotation;
      // Auto-lift snapped position if rotation pushes geometry below ground
      const snapLift = def ? computeGroundLift(def, snapRotation, orient) : 0;
      const liftedSnapPos: GridPosition = [snap.position[0], Math.max(snap.position[1], snapLift) + yLift, snap.position[2]];
      const canPlaceSnapped = assembly.canPlace(definitionId, liftedSnapPos, snapRotation, orient);
      setGridPos(liftedSnapPos);
      setEffectiveOrientation(orient);
      setEffectiveRotation(snapRotation);
      setValid(canPlaceSnapped);
      setIsSnapped(true);
      ghostStateRef.current = {
        position: liftedSnapPos,
        orientation: orient,
        valid: canPlaceSnapped,
        rotation: snapRotation,
        isSnapped: true,
      };
      return;
    }

    // No snap — use free placement with current orientation/rotation
    const orient = isSupport ? ghostOrientation : "y";
    // Auto-lift if rotation pushes geometry below ground
    const lift = def ? computeGroundLift(def, ghostRotation, orient) : 0;
    cursorGrid[1] = lift + yLift;
    const canPlace = assembly.canPlace(definitionId, cursorGrid, ghostRotation, orient);

    setEffectiveOrientation(orient);
    setEffectiveRotation(ghostRotation);
    setGridPos(cursorGrid);
    setValid(canPlace);
    setIsSnapped(false);
    ghostStateRef.current = {
      position: cursorGrid,
      orientation: orient,
      valid: canPlace,
      rotation: ghostRotation,
      isSnapped: false,
    };
  });

  if (!def) return null;

  const worldPos = gridToWorld(gridPos);
  const displayRotation = effectiveRotation;

  return (
    <group name="ghost-preview" position={worldPos}>
      <Suspense fallback={<GhostFallback definitionId={definitionId} valid={valid} orientation={effectiveOrientation} />}>
        <GhostModel definitionId={definitionId} valid={valid} rotation={displayRotation} orientation={effectiveOrientation} isSnapped={isSnapped} />
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
}: {
  dragState: DragState;
  assembly: AssemblyState;
  dropTargetRef: React.MutableRefObject<{ position: GridPosition; valid: boolean; orientation?: Axis; rotation?: Rotation3 }>;
  yLift: number;
}) {
  const { camera, raycaster, pointer } = useThree();
  const [gridPos, setGridPos] = useState<GridPosition>(dragState.originalPosition);
  const [valid, setValid] = useState(true);
  const [effectiveOrientation, setEffectiveOrientation] = useState<Axis>(dragState.orientation ?? "y");
  const [isSnapped, setIsSnapped] = useState(false);
  const groundPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const intersectPoint = useMemo(() => new THREE.Vector3(), []);

  const def = getPartDefinition(dragState.definitionId);
  const isSupport = def?.category === "support";

  useFrame(() => {
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, intersectPoint)) return;

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
    const snap = isSupport
      ? findBestSnap(assembly, dragState.definitionId, cursorGrid, 3, gridRay)
      : findBestConnectorSnap(assembly, dragState.definitionId, cursorGrid, 3, gridRay);

    if (snap) {
      const orient = isSupport ? snap.orientation : (dragState.orientation ?? "y");
      // Auto-lift snapped position if rotation pushes geometry below ground
      const snapLift = def ? computeGroundLift(def, dragState.rotation, orient) : 0;
      const liftedSnapPos: GridPosition = [snap.position[0], Math.max(snap.position[1], snapLift) + yLift, snap.position[2]];
      const canPlace = assembly.canPlaceIgnoring(
        dragState.definitionId,
        liftedSnapPos,
        dragState.rotation,
        dragState.instanceId,
        orient,
      );
      setGridPos(liftedSnapPos);
      setEffectiveOrientation(orient);
      setValid(canPlace);
      setIsSnapped(true);
      dropTargetRef.current = { position: liftedSnapPos, valid: canPlace, orientation: orient, rotation: dragState.rotation };
      return;
    }

    // No snap — free placement on ground plane
    const orient = dragState.orientation ?? "y";
    // Auto-lift if rotation pushes geometry below ground
    const dragLift = def ? computeGroundLift(def, dragState.rotation, orient) : 0;
    cursorGrid[1] = dragLift + yLift;
    const canPlace = assembly.canPlaceIgnoring(
      dragState.definitionId,
      cursorGrid,
      dragState.rotation,
      dragState.instanceId,
      orient,
    );
    setGridPos(cursorGrid);
    setEffectiveOrientation(orient);
    setValid(canPlace);
    setIsSnapped(false);
    dropTargetRef.current = { position: cursorGrid, valid: canPlace, orientation: orient, rotation: dragState.rotation };
  });

  if (!def) return null;

  const worldPos = gridToWorld(gridPos);

  return (
    <group name="drag-preview" position={worldPos}>
      <Suspense fallback={<GhostFallback definitionId={dragState.definitionId} valid={valid} orientation={effectiveOrientation} />}>
        <GhostModel definitionId={dragState.definitionId} valid={valid} rotation={dragState.rotation} orientation={effectiveOrientation} isSnapped={isSnapped} />
      </Suspense>
    </group>
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

interface SceneProps extends ViewportProps {
  ghostRotation: Rotation3;
  ghostOrientation: Axis;
  ghostStateRef: React.MutableRefObject<GhostState>;
  dragState: DragState | null;
  dropTargetRef: React.MutableRefObject<{ position: GridPosition; valid: boolean; orientation?: Axis; rotation?: Rotation3 }>;
  onPartPointerDown: (instanceId: string, nativeEvent: PointerEvent) => void;
  yLift: number;
}

/** Scene contents — lives inside the Canvas */
function Scene({
  parts,
  mode,
  selectedPartId,
  assembly,
  onPlacePart,
  onClickEmpty,
  ghostRotation,
  ghostOrientation,
  ghostStateRef,
  dragState,
  dropTargetRef,
  onPartPointerDown,
  yLift,
}: SceneProps) {
  const groundRef = useRef<THREE.Mesh>(null);

  const handleGroundClick = useCallback(
    (e: any) => {
      if (dragState) return; // Don't handle ground clicks during drag
      if (mode.type === "place") {
        e.stopPropagation();
        const gs = ghostStateRef.current;
        if (gs.valid) {
          onPlacePart(mode.definitionId, gs.position, gs.rotation, gs.orientation);
        }
      } else {
        onClickEmpty();
      }
    },
    [mode, onPlacePart, onClickEmpty, ghostStateRef, dragState]
  );

  return (
    <>
      <ExposeScene />
      <FitCamera parts={parts} />
      {/* Lighting */}
      <ambientLight intensity={2.5} />
      <directionalLight position={[100, 200, 100]} intensity={1.5} castShadow />
      <directionalLight position={[-50, 100, -50]} intensity={0.8} />

      {/* Camera controls — disabled during drag */}
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} enabled={!dragState} />

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
          isSelected={part.instanceId === selectedPartId}
          isDragging={dragState?.instanceId === part.instanceId}
          isPlacing={mode.type === "place"}
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
        />
      )}

      {/* Drag preview */}
      {dragState && (
        <DragPreview
          dragState={dragState}
          assembly={assembly}
          dropTargetRef={dropTargetRef}
          yLift={yLift}
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
    valid: false,
    rotation: [0, 0, 0],
    isSnapped: false,
  });

  // Drag state
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dropTargetRef = useRef<{ position: GridPosition; valid: boolean; orientation?: Axis; rotation?: Rotation3 }>({
    position: [0, 0, 0],
    valid: false,
  });
  const pendingDragRef = useRef<{
    instanceId: string;
    startX: number;
    startY: number;
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
      if (props.mode.type === "place") return;
      pendingDragRef.current = {
        instanceId,
        startX: nativeEvent.clientX,
        startY: nativeEvent.clientY,
      };
    },
    [props.mode]
  );

  // Window-level pointer move/up for drag detection
  useEffect(() => {
    const DRAG_THRESHOLD = 5;

    const handlePointerMove = (e: PointerEvent) => {
      const pending = pendingDragRef.current;
      if (!pending) return;
      if (dragState) return; // Already dragging

      const dx = e.clientX - pending.startX;
      const dy = e.clientY - pending.startY;
      if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) {
        const part = props.assembly.getPartById(pending.instanceId);
        if (part) {
          setYLift(0);
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

    const handlePointerUp = () => {
      const pending = pendingDragRef.current;
      if (!pending) return;

      if (dragState) {
        const target = dropTargetRef.current;
        if (target.valid) {
          props.onMovePart(dragState.instanceId, target.position, target.rotation, target.orientation);
        }
        setDragState(null);
      } else {
        props.onClickPart(pending.instanceId);
      }
      pendingDragRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, props.assembly, props.onMovePart, props.onClickPart]);

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
        props.selectedPartId
      ) {
        props.onDeletePart(props.selectedPartId);
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
  }, [props.onEscape, props.onDeletePart, props.selectedPartId, props.mode, isPlacingSupport, rotateAxis, dragState]);

  // Hint text
  let hintText: string | null = null;
  if (dragState) {
    const dragDef = getPartDefinition(dragState.definitionId);
    hintText = dragDef?.category === "support"
      ? "R/F/T rotate · O orientation · W/S raise/lower · Release to place · Esc cancel"
      : "R/F/T rotate · W/S raise/lower · Release to place · Esc cancel";
  } else if (props.mode.type === "place") {
    hintText = isPlacingSupport
      ? "Click to place · R/F/T rotate · O orientation · W/S raise/lower · Esc cancel"
      : "Click to place · R/F/T rotate · W/S raise/lower · Esc cancel";
  }

  return (
    <div
      className="viewport"
      data-placing={props.mode.type === "place" ? props.mode.definitionId : undefined}
    >
      <Canvas
        camera={{ position: [150, 200, 150], fov: 50, near: 1, far: 10000 }}
        gl={{ antialias: true }}
        scene={{ background: new THREE.Color("#2a2a4a") }}
      >
        <Scene
          {...props}
          ghostRotation={ghostRotation}
          ghostOrientation={ghostOrientation}
          ghostStateRef={ghostStateRef}
          dragState={dragState}
          dropTargetRef={dropTargetRef}
          onPartPointerDown={handlePartPointerDown}
          yLift={yLift}
        />
      </Canvas>
      {hintText && (
        <div className="viewport-hint">
          {hintText}
        </div>
      )}
    </div>
  );
}
