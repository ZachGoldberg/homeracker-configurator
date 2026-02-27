import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, useGLTF } from "@react-three/drei";
import { useCallback, useRef, useState, useEffect, useMemo, Suspense } from "react";
import * as THREE from "three";
import { BASE_UNIT, PART_COLORS, GRID_EXTENT } from "../constants";
import type { PlacedPart, InteractionMode, GridPosition, Rotation3, RotationStep, Axis, DragState } from "../types";
import { getPartDefinition } from "../data/catalog";
import { AssemblyState } from "../assembly/AssemblyState";
import { orientationToRotation, nextOrientation } from "../assembly/grid-utils";
import { findBestSnap } from "../assembly/snap";

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

/** A placed part rendered with its actual GLB model */
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

  return (
    <Suspense fallback={<PartMeshFallback part={part} isSelected={isSelected} onClick={() => {}} />}>
      <PartMeshLoaded part={part} isSelected={isSelected} isDragging={isDragging} onPointerDown={onPointerDown} />
    </Suspense>
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

  // OpenSCAD Z-up to Three.js Y-up: rotate -90 degrees around X
  return (
    <group
      name={`placed-${part.instanceId}`}
      position={worldPos}
      rotation={partEuler}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown(e);
      }}
    >
      <primitive
        ref={groupRef}
        object={cloned}
        rotation={[-Math.PI / 2, 0, 0]}
      />
      {isSelected && !isDragging && (
        <mesh>
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

  const cells = def.gridCells;
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0])) + 1;
  const maxY = Math.max(...cells.map((c) => c[1])) + 1;
  const maxZ = Math.max(...cells.map((c) => c[2])) + 1;

  const sizeX = (maxX - minX) * BASE_UNIT;
  const sizeY = (maxY - minY) * BASE_UNIT;
  const sizeZ = (maxZ - minZ) * BASE_UNIT;

  const centerOffset: [number, number, number] = [
    ((minX + maxX) / 2) * BASE_UNIT,
    ((minY + maxY) / 2) * BASE_UNIT,
    ((minZ + maxZ) / 2) * BASE_UNIT,
  ];

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
  isSnapped,
}: {
  definitionId: string;
  valid: boolean;
  rotation: Rotation3;
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

  return (
    <group rotation={euler}>
      <primitive
        ref={groupRef}
        object={cloned}
        rotation={[-Math.PI / 2, 0, 0]}
      />
    </group>
  );
}

/** Fallback box while ghost GLB is loading */
function GhostFallback({ definitionId, valid }: { definitionId: string; valid: boolean }) {
  const def = getPartDefinition(definitionId);
  if (!def) return null;

  const cells = def.gridCells;
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0])) + 1;
  const maxY = Math.max(...cells.map((c) => c[1])) + 1;
  const maxZ = Math.max(...cells.map((c) => c[2])) + 1;

  const sizeX = (maxX - minX) * BASE_UNIT;
  const sizeY = (maxY - minY) * BASE_UNIT;
  const sizeZ = (maxZ - minZ) * BASE_UNIT;

  const centerOffset: [number, number, number] = [
    ((minX + maxX) / 2) * BASE_UNIT,
    ((minY + maxY) / 2) * BASE_UNIT,
    ((minZ + maxZ) / 2) * BASE_UNIT,
  ];

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

    if (isSupport) {
      // Try to find a snap point near a connector socket
      const snap = findBestSnap(assembly, definitionId, cursorGrid, 3);
      if (snap) {
        const rot = orientationToRotation(snap.orientation);
        setGridPos(snap.position);
        setEffectiveOrientation(snap.orientation);
        setValid(true); // snap candidates are pre-validated
        setIsSnapped(true);
        ghostStateRef.current = {
          position: snap.position,
          orientation: snap.orientation,
          valid: true,
          rotation: rot,
          isSnapped: true,
        };
        return;
      }
    }

    // No snap — use free placement with current orientation/rotation
    const orient = isSupport ? ghostOrientation : "y";
    const rot = isSupport ? orientationToRotation(orient) : ghostRotation;
    const canPlace = assembly.canPlace(definitionId, cursorGrid, rot, orient);

    setEffectiveOrientation(orient);
    setGridPos(cursorGrid);
    setValid(canPlace);
    setIsSnapped(false);
    ghostStateRef.current = {
      position: cursorGrid,
      orientation: orient,
      valid: canPlace,
      rotation: rot,
      isSnapped: false,
    };
  });

  if (!def) return null;

  const worldPos = gridToWorld(gridPos);
  const displayRotation = isSupport
    ? orientationToRotation(effectiveOrientation)
    : ghostRotation;

  return (
    <group name="ghost-preview" position={worldPos}>
      <Suspense fallback={<GhostFallback definitionId={definitionId} valid={valid} />}>
        <GhostModel definitionId={definitionId} valid={valid} rotation={displayRotation} isSnapped={isSnapped} />
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
      <Suspense fallback={<GhostFallback definitionId={dragState.definitionId} valid={valid} />}>
        <GhostModel definitionId={dragState.definitionId} valid={valid} rotation={dragState.rotation} />
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
}

/** Scene contents — lives inside the Canvas */
function Scene({
  parts,
  mode,
  selectedPartId,
  assembly,
  onPlacePart,
  onClickPart,
  onClickEmpty,
  ghostRotation,
  ghostOrientation,
  ghostStateRef,
}: SceneProps) {
  const groundRef = useRef<THREE.Mesh>(null);

  const handleGroundClick = useCallback(
    (e: any) => {
      if (mode.type === "place") {
        e.stopPropagation();
        // Read the ghost state (written each frame by GhostPreview)
        const gs = ghostStateRef.current;
        if (gs.valid) {
          onPlacePart(mode.definitionId, gs.position, gs.rotation, gs.orientation);
        }
      } else {
        onClickEmpty();
      }
    },
    [mode, onPlacePart, onClickEmpty, ghostStateRef]
  );

  return (
    <>
      <ExposeScene />
      {/* Lighting */}
      <ambientLight intensity={0.6} />
      <directionalLight position={[100, 200, 100]} intensity={0.8} castShadow />
      <directionalLight position={[-50, 100, -50]} intensity={0.3} />

      {/* Camera controls */}
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} />

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
          onClick={() => onClickPart(part.instanceId)}
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

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onEscape();
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        props.selectedPartId
      ) {
        props.onDeletePart(props.selectedPartId);
      } else if (props.mode.type === "place") {
        if (isPlacingSupport) {
          // For supports: R cycles orientation (y → x → z → y)
          if (e.key.toLowerCase() === "r") {
            setGhostOrientation((prev) => nextOrientation(prev));
          }
        } else {
          // For connectors: R/F/T rotate on Y/Z/X axes
          switch (e.key.toLowerCase()) {
            case "r": rotateAxis(1); break;
            case "f": rotateAxis(2); break;
            case "t": rotateAxis(0); break;
          }
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.onEscape, props.onDeletePart, props.selectedPartId, props.mode, isPlacingSupport, rotateAxis]);

  const hintText = isPlacingSupport
    ? "Click to place · R cycle orientation · Esc cancel"
    : "Click to place · R rotate Y · F rotate Z · T rotate X · Esc cancel";

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
        />
      </Canvas>
      {props.mode.type === "place" && (
        <div className="viewport-hint">
          {hintText}
        </div>
      )}
    </div>
  );
}
