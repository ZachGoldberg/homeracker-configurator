import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, useGLTF } from "@react-three/drei";
import { useCallback, useRef, useState, useEffect, useMemo, Suspense } from "react";
import * as THREE from "three";
import { BASE_UNIT, PART_COLORS, GRID_EXTENT } from "../constants";
import type { PlacedPart, InteractionMode, GridPosition, Rotation3, RotationStep, Axis, DragState } from "../types";
import { getPartDefinition } from "../data/catalog";
import { isCustomPart, getCustomPartGeometry } from "../data/custom-parts";
import { AssemblyState } from "../assembly/AssemblyState";
import { nextOrientation, orientationToRotation, transformCell, rotateGridCells } from "../assembly/grid-utils";
import { findBestSnap, findBestConnectorSnap, type GridRay } from "../assembly/snap";

interface ViewportProps {
  parts: PlacedPart[];
  mode: InteractionMode;
  selectedPartId: string | null;
  assembly: AssemblyState;
  onPlacePart: (definitionId: string, position: GridPosition, rotation: PlacedPart["rotation"], orientation?: Axis) => void;
  onMovePart: (instanceId: string, newPosition: GridPosition) => void;
  onClickPart: (instanceId: string) => void;
  onClickEmpty: () => void;
  onDeletePart: (instanceId: string) => void;
  onEscape: () => void;
}

/** Convert grid coordinates to world position (mm) */
function gridToWorld(pos: GridPosition): [number, number, number] {
  return [pos[0] * BASE_UNIT, pos[1] * BASE_UNIT, pos[2] * BASE_UNIT];
}

/** Snap a world position to the nearest grid point */
function snapToGrid(worldPos: THREE.Vector3): GridPosition {
  return [
    Math.round(worldPos.x / BASE_UNIT),
    Math.round(worldPos.y / BASE_UNIT),
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
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  onPointerDown: (e: any) => void;
}) {
  const def = getPartDefinition(part.definitionId);
  if (!def) return null;

  if (isCustomPart(part.definitionId)) {
    return <CustomPartMesh part={part} isSelected={isSelected} isDragging={isDragging} onPointerDown={onPointerDown} />;
  }

  return (
    <Suspense fallback={<PartMeshFallback part={part} isSelected={isSelected} onClick={() => {}} />}>
      <PartMeshLoaded part={part} isSelected={isSelected} isDragging={isDragging} onPointerDown={onPointerDown} />
    </Suspense>
  );
}

/** Rendered mesh for a custom STL-imported part */
function CustomPartMesh({
  part,
  isSelected,
  isDragging,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
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
        e.stopPropagation();
        onPointerDown(e);
      }}
    >
      <group position={offset}>
        <group rotation={partEuler}>
          <mesh geometry={geometry}>
            <meshStandardMaterial color={color} transparent={isDragging} opacity={opacity} />
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
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
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
        e.stopPropagation();
        onPointerDown(e);
      }}
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
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const maxZ = Math.max(...cells.map((c) => c[2]));

  const sizeX = (maxX - minX + 1) * BASE_UNIT;
  const sizeY = (maxY - minY + 1) * BASE_UNIT;
  const sizeZ = (maxZ - minZ + 1) * BASE_UNIT;

  const centerOffset: [number, number, number] = [
    ((minX + maxX + 1) / 2) * BASE_UNIT,
    ((minY + maxY + 1) / 2) * BASE_UNIT,
    ((minZ + maxZ + 1) / 2) * BASE_UNIT,
  ];

  // Box dimensions already reflect orientation + rotation — no rotation group needed
  return (
    <group position={worldPos}>
      <mesh
        position={centerOffset}
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
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const maxZ = Math.max(...cells.map((c) => c[2]));

  const sizeX = (maxX - minX + 1) * BASE_UNIT;
  const sizeY = (maxY - minY + 1) * BASE_UNIT;
  const sizeZ = (maxZ - minZ + 1) * BASE_UNIT;

  const centerOffset: [number, number, number] = [
    ((minX + maxX + 1) / 2) * BASE_UNIT,
    ((minY + maxY + 1) / 2) * BASE_UNIT,
    ((minZ + maxZ + 1) / 2) * BASE_UNIT,
  ];

  // No rotation needed — box dimensions already reflect oriented space
  return (
    <mesh position={centerOffset}>
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
}: {
  definitionId: string;
  assembly: AssemblyState;
  ghostOrientation: Axis;
  ghostRotation: Rotation3;
  ghostStateRef: React.MutableRefObject<GhostState>;
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
      const canPlaceSnapped = assembly.canPlace(definitionId, snap.position, snapRotation, orient);
      setGridPos(snap.position);
      setEffectiveOrientation(orient);
      setEffectiveRotation(snapRotation);
      setValid(canPlaceSnapped);
      setIsSnapped(true);
      ghostStateRef.current = {
        position: snap.position,
        orientation: orient,
        valid: canPlaceSnapped,
        rotation: snapRotation,
        isSnapped: true,
      };
      return;
    }

    // No snap — use free placement with current orientation/rotation
    const orient = isSupport ? ghostOrientation : "y";
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

/** Drag preview — follows cursor on ground plane, shows ghost at snapped grid position */
function DragPreview({
  dragState,
  assembly,
  dropTargetRef,
}: {
  dragState: DragState;
  assembly: AssemblyState;
  dropTargetRef: React.MutableRefObject<{ position: GridPosition; valid: boolean }>;
}) {
  const { camera, raycaster, pointer } = useThree();
  const [gridPos, setGridPos] = useState<GridPosition>(dragState.originalPosition);
  const [valid, setValid] = useState(true);
  const groundPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const intersectPoint = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, intersectPoint)) return;

    const snapped = snapToGrid(intersectPoint);
    snapped[1] = 0;
    const canPlace = assembly.canPlaceIgnoring(
      dragState.definitionId,
      snapped,
      dragState.rotation,
      dragState.instanceId,
      dragState.orientation,
    );
    setGridPos(snapped);
    setValid(canPlace);
    dropTargetRef.current = { position: snapped, valid: canPlace };
  });

  const def = getPartDefinition(dragState.definitionId);
  if (!def) return null;

  const worldPos = gridToWorld(gridPos);

  return (
    <group name="drag-preview" position={worldPos}>
      <Suspense fallback={<GhostFallback definitionId={dragState.definitionId} valid={valid} orientation={dragState.orientation} />}>
        <GhostModel definitionId={dragState.definitionId} valid={valid} rotation={dragState.rotation} orientation={dragState.orientation} />
      </Suspense>
    </group>
  );
}

/** Expose the R3F scene on window for e2e testing */
function ExposeScene() {
  const { scene } = useThree();
  useEffect(() => {
    (window as any).__scene = scene;
  }, [scene]);
  return null;
}

interface SceneProps extends ViewportProps {
  ghostRotation: Rotation3;
  ghostOrientation: Axis;
  ghostStateRef: React.MutableRefObject<GhostState>;
  dragState: DragState | null;
  dropTargetRef: React.MutableRefObject<{ position: GridPosition; valid: boolean }>;
  onPartPointerDown: (instanceId: string, nativeEvent: PointerEvent) => void;
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
      {/* Lighting */}
      <ambientLight intensity={0.6} />
      <directionalLight position={[100, 200, 100]} intensity={0.8} castShadow />
      <directionalLight position={[-50, 100, -50]} intensity={0.3} />

      {/* Camera controls — disabled during drag */}
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} enabled={!dragState} />

      {/* Grid floor */}
      <Grid
        position={[0, -0.1, 0]}
        args={[GRID_EXTENT * BASE_UNIT * 2, GRID_EXTENT * BASE_UNIT * 2]}
        cellSize={BASE_UNIT}
        cellThickness={0.5}
        cellColor="#444444"
        sectionSize={BASE_UNIT * 5}
        sectionThickness={1}
        sectionColor="#666666"
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
        />
      )}

      {/* Drag preview */}
      {dragState && (
        <DragPreview
          dragState={dragState}
          assembly={assembly}
          dropTargetRef={dropTargetRef}
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
  const dropTargetRef = useRef<{ position: GridPosition; valid: boolean }>({
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

  // Reset rotation and orientation when switching parts
  useEffect(() => {
    setGhostRotation([0, 0, 0]);
    setGhostOrientation("y");
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
          props.onMovePart(dragState.instanceId, target.position);
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
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.onEscape, props.onDeletePart, props.selectedPartId, props.mode, isPlacingSupport, rotateAxis, dragState]);

  // Hint text
  let hintText: string | null = null;
  if (dragState) {
    hintText = "Drag to move · Release to place · Esc cancel";
  } else if (props.mode.type === "place") {
    hintText = isPlacingSupport
      ? "Click to place · R rotate Y · F rotate Z · T rotate X · O cycle orientation · Esc cancel"
      : "Click to place · R rotate Y · F rotate Z · T rotate X · Esc cancel";
  }

  return (
    <div
      className="viewport"
      data-placing={props.mode.type === "place" ? props.mode.definitionId : undefined}
    >
      <Canvas
        camera={{ position: [150, 200, 150], fov: 50, near: 1, far: 10000 }}
        gl={{ antialias: true }}
      >
        <Scene
          {...props}
          ghostRotation={ghostRotation}
          ghostOrientation={ghostOrientation}
          ghostStateRef={ghostStateRef}
          dragState={dragState}
          dropTargetRef={dropTargetRef}
          onPartPointerDown={handlePartPointerDown}
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
