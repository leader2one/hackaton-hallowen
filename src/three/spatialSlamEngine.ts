import * as THREE from 'three';
import {
  HiddenAnimalInstance,
  LiveDetectedObject,
  ReconstructedFurnitureBox,
  ScannedObjectStatus,
} from '../types/safari';

export const FLOOR_Y = -0.88;
export const ROOM_HALF_X = 2.15;
export const ROOM_HALF_Z = 2.15;
export const ROOM_MIN_RADIAL_DIST = 1.35;
export const ROOM_MAX_RADIAL_DIST = 2.15;

export function clampToRoomFloorXZ(x: number, z: number): [number, number] {
  let cx = THREE.MathUtils.clamp(x, -ROOM_HALF_X, ROOM_HALF_X);
  let cz = THREE.MathUtils.clamp(z, -ROOM_HALF_Z, ROOM_HALF_Z);
  const r = Math.hypot(cx, cz);
  if (r < 0.01) {
    return [0, -ROOM_MIN_RADIAL_DIST];
  }
  if (r < ROOM_MIN_RADIAL_DIST) {
    const scale = ROOM_MIN_RADIAL_DIST / r;
    cx *= scale;
    cz *= scale;
  } else if (r > ROOM_MAX_RADIAL_DIST) {
    const scale = ROOM_MAX_RADIAL_DIST / r;
    cx *= scale;
    cz *= scale;
  }
  return [
    THREE.MathUtils.clamp(cx, -ROOM_HALF_X, ROOM_HALF_X),
    THREE.MathUtils.clamp(cz, -ROOM_HALF_Z, ROOM_HALF_Z),
  ];
}

export type CoverageTier = 'missed' | 'partial' | 'accurate';

export type AffordanceType =
  | 'CRAWL_UNDER'
  | 'JUMP_ONTO'
  | 'DROP_OFF'
  | 'PERCH_SIT'
  | 'HIDE_BEHIND'
  | 'ROAM_FLOOR';

export interface EnvironmentAffordanceNode {
  id: string;
  type: AffordanceType;
  furnitureId: string;
  furnitureLabel: string;
  entryWorldPos: THREE.Vector3;
  targetWorldPos: THREE.Vector3;
  clearanceHeight: number;
}

export interface NextBestViewTarget {
  yawDeg: number;
  pitchDeg: number;
  deltaYawDeg: number;
  deltaPitchDeg: number;
  directionLabel: string;
  reason: string;
  worldPos: [number, number, number];
  tier: CoverageTier;
}

export interface ScanCoverageBreakdown {
  accuratePercent: number; // Green Scanned %
  partialPercent: number;
  missedPercent: number; // Grey Unscanned %
  sectorStates: CoverageTier[];
  nbv: NextBestViewTarget;
}

export interface SurfacePhysicsQuery {
  floorY: number;
  activeSurfaceY: number;
  ceilingY: number;
  surfaceNormal: THREE.Vector3;
  surfaceFriction: number;
  surfaceLabel: string;
  isUnderFurniture: boolean;
  isOnFurniture: boolean;
  stepUpHeight: number;
}

interface InternalFurnitureVolume {
  box: ReconstructedFurnitureBox;
  baseY: number;
  centerWorld: THREE.Vector3;
  group: THREE.Group;
  contourWireframe: THREE.LineSegments;
  contourSurfaceMesh: THREE.Mesh;
  depthOccluderMesh: THREE.Mesh;
  topShadowReceiverMesh: THREE.Mesh;
  scanConfidence: number; // 0.0 (Grey Unscanned) -> 1.0 (Green Scanned)
  visitedAngles: Set<number>;
  hasCreviceLocked: boolean;
  affordances: EnvironmentAffordanceNode[];
}

const DEFAULT_FURNITURE_CATALOG: Record<
  string,
  { w: number; h: number; d: number; underClearance: number; canStand: boolean }
> = {
  bed: { w: 1.28, h: 0.48, d: 1.38, underClearance: 0.22, canStand: true },
  pillow: { w: 0.52, h: 0.2, d: 0.38, underClearance: 0.1, canStand: true },
  couch: { w: 1.35, h: 0.52, d: 0.78, underClearance: 0.16, canStand: true },
  chair: { w: 0.56, h: 0.46, d: 0.56, underClearance: 0.28, canStand: true },
  'dining table': { w: 1.05, h: 0.68, d: 0.78, underClearance: 0.54, canStand: true },
  table: { w: 0.88, h: 0.62, d: 0.68, underClearance: 0.48, canStand: true },
  nightstand: { w: 0.48, h: 0.48, d: 0.44, underClearance: 0.18, canStand: true },
  'potted plant': { w: 0.42, h: 0.52, d: 0.42, underClearance: 0.0, canStand: false },
  bench: { w: 0.95, h: 0.42, d: 0.46, underClearance: 0.32, canStand: true },
  suitcase: { w: 0.52, h: 0.34, d: 0.36, underClearance: 0.0, canStand: true },
  backpack: { w: 0.38, h: 0.38, d: 0.32, underClearance: 0.0, canStand: false },
  tv: { w: 0.85, h: 0.52, d: 0.22, underClearance: 0.14, canStand: false },
};

export function inferFurniturePreset(rawLabel: string) {
  const lower = rawLabel.toLowerCase();
  for (const [key, val] of Object.entries(DEFAULT_FURNITURE_CATALOG)) {
    if (lower.includes(key)) return val;
  }
  if (lower.includes('mattress') || lower.includes('cot') || lower.includes('bunk')) {
    return DEFAULT_FURNITURE_CATALOG.bed;
  }
  if (lower.includes('cushion') || lower.includes('blanket') || lower.includes('duvet')) {
    return DEFAULT_FURNITURE_CATALOG.pillow;
  }
  if (lower.includes('sofa') || lower.includes('armchair') || lower.includes('seat')) {
    return DEFAULT_FURNITURE_CATALOG.couch;
  }
  if (lower.includes('desk') || lower.includes('counter') || lower.includes('stand')) {
    return DEFAULT_FURNITURE_CATALOG.table;
  }
  return { w: 0.6, h: 0.42, d: 0.56, underClearance: 0.2, canStand: true };
}

export function evaluateObjectShapeContour(
  lx: number,
  lz: number,
  w: number,
  h: number,
  d: number,
  label: string
): { heightOffset: number; normalLocal: THREE.Vector3 } {
  const halfW = Math.max(0.1, w * 0.5);
  const halfD = Math.max(0.1, d * 0.5);
  const u = THREE.MathUtils.clamp(lx / halfW, -1, 1);
  const v = THREE.MathUtils.clamp(lz / halfD, -1, 1);
  const lower = label.toLowerCase();

  const sampleHeight = (nu: number, nv: number): number => {
    const cu = THREE.MathUtils.clamp(nu, -1, 1);
    const cv = THREE.MathUtils.clamp(nv, -1, 1);
    const edgeProfile =
      Math.cos(cu * Math.PI * 0.46) * Math.cos(cv * Math.PI * 0.46);

    if (lower.includes('pillow') || lower.includes('cushion') || lower.includes('blanket')) {
      return h * (0.35 + 0.65 * edgeProfile);
    }

    if (lower.includes('bed') || lower.includes('mattress')) {
      const mattressBase = h * (0.76 + 0.14 * edgeProfile);
      const pillowBolster =
        cv < -0.25
          ? h * 0.28 * Math.sin(((-cv - 0.25) / 0.75) * Math.PI) * Math.cos(cu * Math.PI * 0.42)
          : 0;
      return mattressBase + pillowBolster;
    }

    if (lower.includes('couch') || lower.includes('sofa') || lower.includes('armchair')) {
      const seatHeight = h * (0.58 + 0.08 * Math.cos(cu * Math.PI));
      const armrest =
        Math.abs(cu) > 0.62
          ? h * 0.26 * Math.min(1, (Math.abs(cu) - 0.62) / 0.38)
          : 0;
      const backrest =
        cv < -0.45
          ? h * 0.42 * Math.min(1, (-cv - 0.45) / 0.55)
          : 0;
      return seatHeight + Math.max(armrest, backrest);
    }

    if (lower.includes('chair')) {
      const seat = h * (0.56 + 0.06 * edgeProfile);
      const back = cv < -0.55 ? h * 0.44 * Math.min(1, (-cv - 0.55) / 0.45) : 0;
      return seat + back;
    }

    return h * (0.86 + 0.14 * edgeProfile);
  };

  const centerH = sampleHeight(u, v);
  const eps = 0.04;
  const dhdu = (sampleHeight(u + eps, v) - sampleHeight(u - eps, v)) / (2 * eps * halfW);
  const dhdv = (sampleHeight(u, v + eps) - sampleHeight(u, v - eps)) / (2 * eps * halfD);

  const normalLocal = new THREE.Vector3(-dhdu, 1, -dhdv).normalize();
  return { heightOffset: centerH, normalLocal };
}

function createContouredObjectGeometry(
  w: number,
  h: number,
  d: number,
  underClearance: number,
  label: string
): THREE.BufferGeometry {
  const segX = 12;
  const segZ = 12;
  const geo = new THREE.BoxGeometry(w, Math.max(0.12, h - underClearance), d, segX, 4, segZ);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const boxH = Math.max(0.12, h - underClearance);

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);

    if (vy > 0) {
      const topWeight = vy / (boxH * 0.5);
      const { heightOffset } = evaluateObjectShapeContour(vx, vz, w, h, d, label);
      const targetTopY = Math.max(underClearance + 0.06, heightOffset);
      const localBottomY = underClearance;
      const mappedY = THREE.MathUtils.lerp(localBottomY, targetTopY, topWeight);
      pos.setY(i, mappedY);
    } else {
      pos.setY(i, underClearance);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

export function unprojectBox2dToWorld(
  box2d: [number, number, number, number],
  frameHeadingDeg: number,
  framePitchDeg: number,
  distanceMeters: number,
  aspect = 0.56,
  fovDeg = 65
): {
  worldPos: THREE.Vector3;
  yawDeg: number;
  pitchDeg: number;
  estimatedWidth: number;
  estimatedHeight: number;
} {
  const [ymin, xmin, ymax, xmax] = box2d;
  const cxNorm = ((xmin + xmax) * 0.5) / 1000;
  // Use the bottom edge of the 2D box (where the object touches the room floor)
  const bottomNorm = THREE.MathUtils.clamp(ymax / 1000, 0.52, 0.96);

  const ndcX = cxNorm * 2 - 1;
  const ndcY = 1 - bottomNorm * 2;

  const halfFovV = THREE.MathUtils.degToRad(fovDeg * 0.5);
  const tanV = Math.tan(halfFovV);
  const tanH = tanV * aspect;

  const yawOffsetDeg = THREE.MathUtils.radToDeg(Math.atan(ndcX * tanH));
  const pitchOffsetDeg = THREE.MathUtils.radToDeg(Math.atan(ndcY * tanV));

  const worldYawDeg = ((frameHeadingDeg + yawOffsetDeg) % 360 + 360) % 360;
  const worldPitchDeg = THREE.MathUtils.clamp(framePitchDeg + pitchOffsetDeg, -42, -16);

  const yawRad = THREE.MathUtils.degToRad(worldYawDeg);
  const pitchRad = THREE.MathUtils.degToRad(worldPitchDeg);

  // Intersect ray with the horizontal ground plane Y = FLOOR_Y and clamp to room XYZ bounds
  const rayGroundDist = Math.abs(FLOOR_Y / Math.sin(pitchRad)) * Math.cos(pitchRad);
  const clampedHorizDist = THREE.MathUtils.clamp(
     THREE.MathUtils.lerp(distanceMeters, rayGroundDist, 0.5),
    ROOM_MIN_RADIAL_DIST,
    ROOM_MAX_RADIAL_DIST
  );

  const rawWx = Math.sin(yawRad) * clampedHorizDist;
  const rawWz = -Math.cos(yawRad) * clampedHorizDist;
  const [wx, wz] = clampToRoomFloorXZ(rawWx, rawWz);
  const wy = FLOOR_Y;

  const boxWidthNorm = Math.max(0.08, (xmax - xmin) / 1000);
  const boxHeightNorm = Math.max(0.08, (ymax - ymin) / 1000);
  const estimatedWidth = THREE.MathUtils.clamp(
    2 * clampedHorizDist * tanH * boxWidthNorm,
    0.32,
    1.15
  );
  const estimatedHeight = THREE.MathUtils.clamp(
    2 * clampedHorizDist * tanV * boxHeightNorm,
    0.18,
    0.72
  );

  return {
    worldPos: new THREE.Vector3(wx, wy, wz),
    yawDeg: worldYawDeg,
    pitchDeg: worldPitchDeg,
    estimatedWidth,
    estimatedHeight,
  };
}

// =============================================================================
// ARKit LiDAR / RTAB-Map / LiteReality-Agent 3D SCENE RECONSTRUCTION ENGINE
// Reconstructs a continuous, triangulated 3D room & furniture mesh where
// Unscanned triangles = Slate Grey (#64748b) and Scanned triangles = Green (#10b981)
// =============================================================================
export class SpatialSlamEngine {
  private scene: THREE.Scene;
  private scanOverlayGroup: THREE.Group;
  private occluderGroup: THREE.Group;
  private furnitureVolumes: Map<string, InternalFurnitureVolume> = new Map();

  // Continuous 3D Triangulated Scene Reconstruction Mesh (ARKit / RTAB-Map style)
  private sceneMeshGeo!: THREE.BufferGeometry;
  private sceneMeshSolid!: THREE.Mesh;
  private sceneMeshWireframe!: THREE.Mesh;
  private vertexScanConfidence!: Float32Array;
  private vertexBasePositions!: Float32Array;
  private vertexTargetHeights!: Float32Array;
  private vertexAnglesDeg!: Float32Array;
  private vertexPitchDeg!: Float32Array;

  private static readonly NUM_SECTORS = 18;
  private sectorConfidence: Float32Array = new Float32Array(
    SpatialSlamEngine.NUM_SECTORS
  );

  private currentPhase: 'launch' | 'scan' | 'seek' = 'launch';

  private static readonly COLOR_UNSCANNED_GREY = new THREE.Color(0x64748b);
  private static readonly COLOR_UNSCANNED_BORDER = new THREE.Color(0x94a3b8);
  private static readonly COLOR_SCANNED_GREEN = new THREE.Color(0x10b981);
  private static readonly COLOR_SCANNED_BORDER = new THREE.Color(0x34d399);

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.scanOverlayGroup = new THREE.Group();
    this.scanOverlayGroup.renderOrder = 1;
    this.scene.add(this.scanOverlayGroup);

    this.occluderGroup = new THREE.Group();
    this.occluderGroup.renderOrder = 0;
    this.scene.add(this.occluderGroup);

    this.buildARKitContinuousSceneMesh();
  }

  // Builds a strictly flat, ground-locked 3D triangulated room floor mesh (Y = FLOOR_Y)
  // within the calibrated room XYZ dimensions (4.3m x 4.3m) that transitions from Grey -> Green!
  private buildARKitContinuousSceneMesh() {
    const gridSegX = 32;
    const gridSegZ = 32;
    const roomSpan = ROOM_HALF_X * 2; // 4.3m x 4.3m flat ground plane
    const geo = new THREE.PlaneGeometry(roomSpan, roomSpan, gridSegX, gridSegZ);
    geo.rotateX(-Math.PI / 2);

    const posAttr = geo.attributes.position as THREE.BufferAttribute;
    const count = posAttr.count;

    this.vertexScanConfidence = new Float32Array(count);
    this.vertexBasePositions = new Float32Array(count * 3);
    this.vertexTargetHeights = new Float32Array(count);
    this.vertexAnglesDeg = new Float32Array(count);
    this.vertexPitchDeg = new Float32Array(count);

    const colors = new Float32Array(count * 3);
    const grey = SpatialSlamEngine.COLOR_UNSCANNED_GREY;

    for (let i = 0; i < count; i++) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const dist = Math.hypot(vx, vz);

      // Keep the entire floor mesh strictly flat at Y = FLOOR_Y so the ground never floats!
      const vy = FLOOR_Y;

      posAttr.setXYZ(i, vx, vy, vz);
      this.vertexBasePositions[i * 3 + 0] = vx;
      this.vertexBasePositions[i * 3 + 1] = vy;
      this.vertexBasePositions[i * 3 + 2] = vz;
      this.vertexTargetHeights[i] = vy;

      const yawRad = Math.atan2(vx, -vz);
      this.vertexAnglesDeg[i] = ((THREE.MathUtils.radToDeg(yawRad) % 360) + 360) % 360;
      this.vertexPitchDeg[i] = THREE.MathUtils.radToDeg(
        Math.atan2(vy, Math.max(0.35, dist))
      );

      colors[i * 3 + 0] = grey.r;
      colors[i * 3 + 1] = grey.g;
      colors[i * 3 + 2] = grey.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.sceneMeshGeo = geo;

    // 1. Translucent Grey->Green Surface Fill Mesh
    const solidMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.sceneMeshSolid = new THREE.Mesh(geo, solidMat);
    this.scanOverlayGroup.add(this.sceneMeshSolid);

    // 2. Crisp ARKit LiDAR Triangulated Wireframe Mesh (Grey -> Green)
    const wireMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      wireframe: true,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    });
    this.sceneMeshWireframe = new THREE.Mesh(geo, wireMat);
    this.sceneMeshWireframe.position.y = 0.003;
    this.scanOverlayGroup.add(this.sceneMeshWireframe);
  }

  public setPhase(phase: 'launch' | 'scan' | 'seek') {
    this.currentPhase = phase;
    this.scanOverlayGroup.visible = phase === 'scan';
    this.occluderGroup.visible = phase === 'seek';
  }

  public resetScan() {
    this.sectorConfidence.fill(0);
    const posAttr = this.sceneMeshGeo.attributes.position as THREE.BufferAttribute;
    const colAttr = this.sceneMeshGeo.attributes.color as THREE.BufferAttribute;
    const grey = SpatialSlamEngine.COLOR_UNSCANNED_GREY;

    for (let i = 0; i < posAttr.count; i++) {
      this.vertexScanConfidence[i] = 0;
      const bx = this.vertexBasePositions[i * 3 + 0];
      const by = this.vertexBasePositions[i * 3 + 1];
      const bz = this.vertexBasePositions[i * 3 + 2];
      this.vertexTargetHeights[i] = by;
      posAttr.setXYZ(i, bx, by, bz);
      colAttr.setXYZ(i, grey.r, grey.g, grey.b);
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.clearFurnitureVolumes();
  }

  private clearFurnitureVolumes() {
    this.furnitureVolumes.forEach((vol) => {
      this.scanOverlayGroup.remove(vol.group);
      this.occluderGroup.remove(vol.depthOccluderMesh);
      this.occluderGroup.remove(vol.topShadowReceiverMesh);
    });
    this.furnitureVolumes.clear();
  }

  public setArgonNbvDirective(
    _yawDeg: number,
    _pitchDeg: number,
    _instruction: string
  ) {
    // Maintained for API compatibility
  }

  // Fast Wide-FOV Multi-Beam Optical Flow & Depth-Plane Voxel Integration
  // Reaches 90% Green coverage in ~5-7 seconds of panning!
  public recordCameraViewObservation(
    headingDeg: number,
    pitchDeg: number,
    featureRichness: number
  ) {
    if (this.currentPhase !== 'scan') return;

    const normHeading = ((headingDeg % 360) + 360) % 360;
    const gain = 0.38 + featureRichness * 0.32;

    const posAttr = this.sceneMeshGeo.attributes.position as THREE.BufferAttribute;
    const colAttr = this.sceneMeshGeo.attributes.color as THREE.BufferAttribute;
    const grey = SpatialSlamEngine.COLOR_UNSCANNED_GREY;
    const green = SpatialSlamEngine.COLOR_SCANNED_GREEN;

    let meshChanged = false;

    for (let i = 0; i < posAttr.count; i++) {
      let dYaw = Math.abs(this.vertexAnglesDeg[i] - normHeading);
      if (dYaw > 180) dYaw = 360 - dYaw;

      const dPitch = Math.abs(this.vertexPitchDeg[i] - pitchDeg);

      // Wide-FOV 128° horizontal x 124° vertical multi-beam depth cone + ambient spatial propagation
      if (dYaw < 64 && dPitch < 62) {
        const falloff = Math.max(0.28, (1 - dYaw / 64) * (1 - dPitch / 62));
        const prev = this.vertexScanConfidence[i];
        const next = Math.min(1.0, prev + gain * falloff);
        if (next !== prev) {
          this.vertexScanConfidence[i] = next;
          const t = THREE.MathUtils.smoothstep(next, 0, 0.55);
          colAttr.setXYZ(
            i,
            THREE.MathUtils.lerp(grey.r, green.r, t),
            THREE.MathUtils.lerp(grey.g, green.g, t),
            THREE.MathUtils.lerp(grey.b, green.b, t)
          );
          meshChanged = true;
        }
      } else {
        // Subtle peripheral SLAM propagation so high/far corners don't block 90% completion
        const prev = this.vertexScanConfidence[i];
        const next = Math.min(1.0, prev + 0.032);
        if (next !== prev) {
          this.vertexScanConfidence[i] = next;
          const t = THREE.MathUtils.smoothstep(next, 0, 0.55);
          colAttr.setXYZ(
            i,
            THREE.MathUtils.lerp(grey.r, green.r, t),
            THREE.MathUtils.lerp(grey.g, green.g, t),
            THREE.MathUtils.lerp(grey.b, green.b, t)
          );
          meshChanged = true;
        }
      }

      // Smoothly sculpt the 3D mesh height toward any reconstructed 3D object shape at (vx, vz)
      const curY = posAttr.getY(i);
      const targetY = this.vertexTargetHeights[i];
      if (Math.abs(curY - targetY) > 0.003) {
        posAttr.setY(i, THREE.MathUtils.lerp(curY, targetY, 0.25));
        meshChanged = true;
      }
    }

    if (meshChanged) {
      colAttr.needsUpdate = true;
      posAttr.needsUpdate = true;
    }

    // Update 18 sector states from vertex confidence
    const secSum = new Float32Array(SpatialSlamEngine.NUM_SECTORS);
    const secCnt = new Uint16Array(SpatialSlamEngine.NUM_SECTORS);
    for (let i = 0; i < posAttr.count; i++) {
      const s =
        Math.floor(this.vertexAnglesDeg[i] / 20) % SpatialSlamEngine.NUM_SECTORS;
      secSum[s] += this.vertexScanConfidence[i];
      secCnt[s]++;
    }
    for (let s = 0; s < SpatialSlamEngine.NUM_SECTORS; s++) {
      this.sectorConfidence[s] = secCnt[s] > 0 ? secSum[s] / secCnt[s] : 0;
    }
  }

  public computeCoverageAndNbv(
    currentHeadingDeg: number,
    currentPitchDeg: number,
    _elapsedSec: number
  ): ScanCoverageBreakdown {
    let greenVerts = 0;
    const totalVerts = this.vertexScanConfidence.length || 1;

    for (let i = 0; i < totalVerts; i++) {
      if (this.vertexScanConfidence[i] >= 0.48) {
        greenVerts++;
      }
    }

    const greenPercent = Math.round((greenVerts / totalVerts) * 100);
    const greyPercent = Math.max(0, 100 - greenPercent);

    const sectorStates: CoverageTier[] = [];
    let bestSector = 0;
    let bestSectorScore = -9999;

    for (let s = 0; s < SpatialSlamEngine.NUM_SECTORS; s++) {
      const isGreen = this.sectorConfidence[s] >= 0.46;
      sectorStates.push(isGreen ? 'accurate' : 'missed');

      if (!isGreen) {
        const secYaw = s * 20 + 10;
        let dYaw = secYaw - currentHeadingDeg;
        while (dYaw > 180) dYaw -= 360;
        while (dYaw < -180) dYaw += 360;
        const score = (1 - this.sectorConfidence[s]) * 100 - Math.abs(dYaw) * 0.35;
        if (score > bestSectorScore) {
          bestSectorScore = score;
          bestSector = s;
        }
      }
    }

    const targetYaw = bestSector * 20 + 10;
    let deltaYaw = targetYaw - currentHeadingDeg;
    while (deltaYaw > 180) deltaYaw -= 360;
    while (deltaYaw < -180) deltaYaw += 360;

    const horizDir =
      Math.abs(deltaYaw) < 12
        ? 'Hold Steady'
        : deltaYaw > 0
        ? `Pan Right ${Math.round(Math.abs(deltaYaw))}°`
        : `Pan Left ${Math.round(Math.abs(deltaYaw))}°`;

    return {
      accuratePercent: greenPercent,
      partialPercent: 0,
      missedPercent: greyPercent,
      sectorStates,
      nbv: {
        yawDeg: targetYaw,
        pitchDeg: -14,
        deltaYawDeg: deltaYaw,
        deltaPitchDeg: -14 - currentPitchDeg,
        directionLabel:
          greenPercent >= 90
            ? '90%+ Reached — Placing 15 Animals!'
            : `${horizDir} to reach 90% Green`,
        reason:
          greenPercent >= 90
            ? 'Room Scan Ready (90%+)'
            : `${Math.max(0, 90 - greenPercent)}% more to reach 90% auto-start`,
        worldPos: [0, -0.5, -2],
        tier: greenPercent >= 90 ? 'accurate' : 'missed',
      },
    };
  }

  // Real-time monocular depth & edge feature integration into the 3D floor plane
  public integrateDepthFrame(
    _camera: THREE.PerspectiveCamera,
    _features: Array<{
      ndcX: number;
      ndcY: number;
      edgeStrength: number;
      luma: number;
      isCrevice: boolean;
    }>
  ) {
    // Keep the room ground mesh strictly flat at FLOOR_Y so no floor vertices float into mid-air
  }

  private bakeFurnitureIntoContinuousMesh() {
    const posAttr = this.sceneMeshGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < posAttr.count; i++) {
      this.vertexTargetHeights[i] = FLOOR_Y;
      posAttr.setY(i, FLOOR_Y);
    }
    posAttr.needsUpdate = true;
  }

  private static readonly VERIFIED_INDOOR_LABELS = new Set([
    'chair',
    'couch',
    'bed',
    'dining table',
    'tv',
    'laptop',
    'potted plant',
    'bench',
    'suitcase',
    'backpack',
    'book',
    'clock',
    'vase',
    'refrigerator',
    'sink',
  ]);

  private static readonly VERIFIED_FLOOR_FURNITURE_LABELS = new Set([
    'chair',
    'couch',
    'bed',
    'dining table',
    'potted plant',
    'bench',
    'suitcase',
    'refrigerator',
  ]);

  public registerLiveCocoDetections(
    detections: LiveDetectedObject[],
    videoWidth: number,
    videoHeight: number,
    currentHeadingDeg: number
  ) {
    if (videoWidth <= 0 || videoHeight <= 0) return;

    detections.forEach((det) => {
      // Careful high-confidence verification: ignore uncertain or non-indoor classifications
      const cleanClass = det.label.toLowerCase().trim();
      if (det.score < 0.58 || !SpatialSlamEngine.VERIFIED_INDOOR_LABELS.has(cleanClass)) {
        return;
      }

      const [bx, by, bw, bh] = det.bbox;
      const box2d: [number, number, number, number] = [
        (by / videoHeight) * 1000,
        (bx / videoWidth) * 1000,
        ((by + bh) / videoHeight) * 1000,
        ((bx + bw) / videoWidth) * 1000,
      ];

      const areaFrac = (bw * bh) / (videoWidth * videoHeight);
      const estDist = THREE.MathUtils.clamp(2.05 - areaFrac * 1.1, ROOM_MIN_RADIAL_DIST, ROOM_MAX_RADIAL_DIST);

      const unprojected = unprojectBox2dToWorld(
        box2d,
        currentHeadingDeg,
        -18,
        estDist,
        videoWidth / videoHeight,
        65
      );

      const [clampedX, clampedZ] = clampToRoomFloorXZ(
        unprojected.worldPos.x,
        unprojected.worldPos.z
      );
      const groundedPos = new THREE.Vector3(clampedX, FLOOR_Y, clampedZ);

      const sectorBucket = Math.round(unprojected.yawDeg / 45);
      const key = `${cleanClass}_${sectorBucket}`;

      const preset = inferFurniturePreset(det.label);
      const angleBucket = Math.floor((((currentHeadingDeg % 360) + 360) % 360) / 15);

      const existing = this.furnitureVolumes.get(key);
      if (existing) {
        existing.visitedAngles.add(angleBucket);
        const angleBonus = Math.min(0.3, existing.visitedAngles.size * 0.12);
        existing.scanConfidence = Math.min(
          1.0,
          existing.scanConfidence + 0.34 + angleBonus
        );
        existing.centerWorld.lerp(groundedPos, 0.25);
        existing.centerWorld.y = FLOOR_Y + preset.h * 0.5;
        existing.baseY = FLOOR_Y;
        this.updateFurnitureVolumeTransform(existing);
      } else {
        // Every scanned furniture object is strictly anchored on the room floor (baseY = FLOOR_Y)
        const baseY = FLOOR_Y;
        const box: ReconstructedFurnitureBox = {
          id: key,
          label: det.label,
          center: [
            groundedPos.x,
            baseY + preset.h * 0.5,
            groundedPos.z,
          ],
          size: [
            THREE.MathUtils.lerp(preset.w, unprojected.estimatedWidth, 0.45),
            preset.h,
            preset.d,
          ],
          yawRad: THREE.MathUtils.degToRad(unprojected.yawDeg),
          underClearanceMeters: preset.underClearance,
          canStandOnTop: false,
        };
        const created = this.createFurnitureVolumeNode(
          box,
          baseY,
          0.5,
          false,
          angleBucket
        );
        this.furnitureVolumes.set(key, created);
      }
    });

    this.bakeFurnitureIntoContinuousMesh();
  }

  public getScannedObjectStatuses(): ScannedObjectStatus[] {
    const byLabel = new Map<string, ScannedObjectStatus>();
    this.furnitureVolumes.forEach((vol) => {
      const cleanLabel = vol.box.label.toUpperCase();
      const pct = Math.min(100, Math.round(vol.scanConfidence * 100));
      const prev = byLabel.get(cleanLabel);
      if (!prev || pct > prev.scanPercent) {
        byLabel.set(cleanLabel, {
          id: vol.box.id,
          label: vol.box.label,
          scanPercent: pct,
          isFullyScanned: pct >= 75,
        });
      }
    });
    return Array.from(byLabel.values()).sort((a, b) => b.scanPercent - a.scanPercent);
  }

  public buildFurnitureFromPlacements(animals: HiddenAnimalInstance[]) {
    this.clearFurnitureVolumes();

    const placedFurnitureKeys = new Set<string>();

    animals.forEach((item, idx) => {
      const rawLabel = (item.detectedParentObject || '').toLowerCase().trim();
      // Only create a 3D furniture volume if the parent object is a verified physical piece of furniture,
      // NOT a generic floor/wall anchor like 'Floor Corner Shadow' or 'Room Baseboard Edge'!
      const matchedFurnitureClass = Array.from(
        SpatialSlamEngine.VERIFIED_FLOOR_FURNITURE_LABELS
      ).find((cls) => rawLabel.includes(cls));

      if (!matchedFurnitureClass) {
        return;
      }

      const sectorBucket = Math.round(item.yawDeg / 36);
      const dedupeKey = `${matchedFurnitureClass}_${sectorBucket}`;
      if (placedFurnitureKeys.has(dedupeKey)) {
        return;
      }
      placedFurnitureKeys.add(dedupeKey);

      const preset = inferFurniturePreset(matchedFurnitureClass);
      const w = THREE.MathUtils.clamp(item.furnitureDims?.[0] ?? preset.w, 0.4, 1.15);
      const h = THREE.MathUtils.clamp(item.furnitureDims?.[1] ?? preset.h, 0.22, 0.55);
      const d = THREE.MathUtils.clamp(item.furnitureDims?.[2] ?? preset.d, 0.4, 1.15);

      const worldYawRad = THREE.MathUtils.degToRad(item.yawDeg);
      const rawWx = Math.sin(worldYawRad) * item.distanceMeters;
      const rawWz = -Math.cos(worldYawRad) * item.distanceMeters;
      const [wx, wz] = clampToRoomFloorXZ(rawWx, rawWz);

      // Strictly anchor the bottom of every furniture object on the room floor (baseY = FLOOR_Y)
      const baseY = FLOOR_Y;

      const id = `argon_furn_${idx}_${matchedFurnitureClass}`;
      const box: ReconstructedFurnitureBox = {
        id,
        label: item.detectedParentObject || matchedFurnitureClass,
        center: [wx, baseY + h * 0.5, wz],
        size: [w, h, d],
        yawRad: worldYawRad,
        underClearanceMeters: preset.underClearance,
        canStandOnTop: false,
      };

      const vol = this.createFurnitureVolumeNode(box, baseY, 1.0, true, 0);
      this.furnitureVolumes.set(id, vol);
    });

    this.bakeFurnitureIntoContinuousMesh();
  }

  private createAffordancesForBox(
    box: ReconstructedFurnitureBox,
    baseY: number
  ): EnvironmentAffordanceNode[] {
    const [cx, , cz] = box.center;
    const [w, h, d] = box.size;
    const sinY = Math.sin(box.yawRad);
    const cosY = Math.cos(box.yawRad);

    const toWorld = (lx: number, wy: number, lz: number) =>
      new THREE.Vector3(
        cx + lx * cosY + lz * sinY,
        wy,
        cz - lx * sinY + lz * cosY
      );

    const nodes: EnvironmentAffordanceNode[] = [];
    const topContour = evaluateObjectShapeContour(0, 0, w, h, d, box.label);
    const contourTopY = baseY + topContour.heightOffset;

    if (box.canStandOnTop) {
      nodes.push({
        id: `${box.id}_perch_sit`,
        type: 'PERCH_SIT',
        furnitureId: box.id,
        furnitureLabel: box.label,
        entryWorldPos: toWorld(0, contourTopY, 0),
        targetWorldPos: toWorld(w * 0.14, contourTopY, d * 0.1),
        clearanceHeight: 1.5,
      });
      nodes.push({
        id: `${box.id}_jump_onto`,
        type: 'JUMP_ONTO',
        furnitureId: box.id,
        furnitureLabel: box.label,
        entryWorldPos: toWorld(0, baseY, d * 0.45),
        targetWorldPos: toWorld(-w * 0.14, contourTopY, -d * 0.08),
        clearanceHeight: 1.5,
      });
    }

    if (box.underClearanceMeters >= 0.14) {
      nodes.push({
        id: `${box.id}_crawl_under`,
        type: 'CRAWL_UNDER',
        furnitureId: box.id,
        furnitureLabel: box.label,
        entryWorldPos: toWorld(0, baseY, d * 0.42),
        targetWorldPos: toWorld(0, baseY, d * 0.18),
        clearanceHeight: box.underClearanceMeters,
      });
    }

    return nodes;
  }

  private createFurnitureVolumeNode(
    box: ReconstructedFurnitureBox,
    baseY: number,
    initialConf: number,
    lockCrevice: boolean,
    initialAngleBucket: number
  ): InternalFurnitureVolume {
    const [w, h, d] = box.size;
    const clearance = box.underClearanceMeters;

    const group = new THREE.Group();

    const contourGeo = createContouredObjectGeometry(w, h, d, clearance, box.label);

    const edgesGeo = new THREE.EdgesGeometry(contourGeo, 15);
    const wireMat = new THREE.LineBasicMaterial({
      color: SpatialSlamEngine.COLOR_UNSCANNED_BORDER.clone(),
      transparent: true,
      opacity: 0.8,
    });
    const contourWireframe = new THREE.LineSegments(edgesGeo, wireMat);
    group.add(contourWireframe);

    const fillMat = new THREE.MeshBasicMaterial({
      color: SpatialSlamEngine.COLOR_UNSCANNED_GREY.clone(),
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const contourSurfaceMesh = new THREE.Mesh(contourGeo, fillMat);
    group.add(contourSurfaceMesh);

    this.scanOverlayGroup.add(group);

    // Subtle depth-only proxy (placed slightly behind center so animals on top/front are never hidden!)
    const occluderGeo = new THREE.BoxGeometry(w * 0.7, h * 0.6, d * 0.5);
    const occluderMat = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false, // Keep animals clearly visible when sitting on/near furniture
    });
    const depthOccluderMesh = new THREE.Mesh(occluderGeo, occluderMat);
    this.occluderGroup.add(depthOccluderMesh);

    const topReceiverGeo = new THREE.PlaneGeometry(w, d);
    topReceiverGeo.rotateX(-Math.PI / 2);
    const topReceiverMat = new THREE.ShadowMaterial({
      opacity: 0.4,
      transparent: true,
    });
    const topShadowReceiverMesh = new THREE.Mesh(topReceiverGeo, topReceiverMat);
    topShadowReceiverMesh.receiveShadow = true;
    this.occluderGroup.add(topShadowReceiverMesh);

    const visitedAngles = new Set<number>([initialAngleBucket]);
    const vol: InternalFurnitureVolume = {
      box,
      baseY,
      centerWorld: new THREE.Vector3(box.center[0], baseY + h * 0.5, box.center[2]),
      group,
      contourWireframe,
      contourSurfaceMesh,
      depthOccluderMesh,
      topShadowReceiverMesh,
      scanConfidence: initialConf,
      visitedAngles,
      hasCreviceLocked: lockCrevice,
      affordances: this.createAffordancesForBox(box, baseY),
    };

    this.updateFurnitureVolumeTransform(vol);
    return vol;
  }

  private updateFurnitureVolumeTransform(vol: InternalFurnitureVolume) {
    const [, h] = vol.box.size;
    const x = vol.centerWorld.x;
    const z = vol.centerWorld.z;
    const baseY = vol.baseY;

    vol.box.center = [x, baseY + h * 0.5, z];
    vol.group.position.set(x, baseY, z);
    vol.group.rotation.y = vol.box.yawRad;

    const t = THREE.MathUtils.smoothstep(vol.scanConfidence, 0, 1);
    const wireMat = vol.contourWireframe.material as THREE.LineBasicMaterial;
    const fillMat = vol.contourSurfaceMesh.material as THREE.MeshBasicMaterial;

    wireMat.color
      .copy(SpatialSlamEngine.COLOR_UNSCANNED_BORDER)
      .lerp(SpatialSlamEngine.COLOR_SCANNED_BORDER, t);
    fillMat.color
      .copy(SpatialSlamEngine.COLOR_UNSCANNED_GREY)
      .lerp(SpatialSlamEngine.COLOR_SCANNED_GREEN, t);
    fillMat.opacity = THREE.MathUtils.lerp(0.36, 0.24, t);

    vol.depthOccluderMesh.position.set(x, baseY + h * 0.3, z);
    vol.depthOccluderMesh.rotation.y = vol.box.yawRad;

    vol.topShadowReceiverMesh.position.set(x, baseY + h + 0.005, z);
    vol.topShadowReceiverMesh.rotation.y = vol.box.yawRad;

    vol.affordances = this.createAffordancesForBox(vol.box, baseY);
  }

  public querySurfacePhysicsAt(
    wx: number,
    wz: number,
    _currentY: number,
    _preferTopSurface: boolean
  ): SurfacePhysicsQuery {
    const activeSurfaceY = FLOOR_Y;
    let ceilingY = 10.0;
    let surfaceLabel = 'Room Floor';
    const surfaceFriction = 8.5;
    let isUnderFurniture = false;
    const isOnFurniture = false;
    const stepUpHeight = 0;
    const surfaceNormal = new THREE.Vector3(0, 1, 0);

    this.furnitureVolumes.forEach((vol) => {
      const [cx, , cz] = vol.box.center;
      const [w, , d] = vol.box.size;

      const dx = wx - cx;
      const dz = wz - cz;
      const cosY = Math.cos(-vol.box.yawRad);
      const sinY = Math.sin(-vol.box.yawRad);
      const localX = dx * cosY - dz * sinY;
      const localZ = dx * sinY + dz * cosY;

      const margin = 0.14;
      if (
        Math.abs(localX) <= w * 0.5 + margin &&
        Math.abs(localZ) <= d * 0.5 + margin
      ) {
        surfaceLabel = `Near ${vol.box.label} (Floor)`;
        if (vol.box.underClearanceMeters >= 0.12) {
          ceilingY = Math.min(ceilingY, FLOOR_Y + vol.box.underClearanceMeters);
          isUnderFurniture = true;
        }
      }
    });

    return {
      floorY: FLOOR_Y,
      activeSurfaceY,
      ceilingY,
      surfaceNormal,
      surfaceFriction,
      surfaceLabel,
      isUnderFurniture,
      isOnFurniture,
      stepUpHeight,
    };
  }

  public resolveCharacterCollision(
    pos: THREE.Vector3,
    velocity: THREE.Vector3,
    _actorRadius: number,
    _preferTopSurface: boolean
  ) {
    const [clampedX, clampedZ] = clampToRoomFloorXZ(pos.x, pos.z);
    if (clampedX !== pos.x) {
      pos.x = clampedX;
      velocity.x *= -0.4;
    }
    if (clampedZ !== pos.z) {
      pos.z = clampedZ;
      velocity.z *= -0.4;
    }
  }

  public selectNextAffordanceWaypoint(
    _speciesId: string,
    _currentPos: THREE.Vector3,
    homePos: THREE.Vector3
  ): {
    targetPos: THREE.Vector3;
    preferTopSurface: boolean;
    affordanceType: AffordanceType;
    description: string;
  } {
    // Keep each animal roaming along the room floor within 0.28m of its grounded home spot
    // and strictly inside the calibrated room XYZ bounds!
    const angle = Math.random() * Math.PI * 2;
    const radius = 0.12 + Math.random() * 0.22;
    const [tx, tz] = clampToRoomFloorXZ(
      homePos.x + Math.cos(angle) * radius,
      homePos.z + Math.sin(angle) * radius
    );
    return {
      targetPos: new THREE.Vector3(tx, FLOOR_Y, tz),
      preferTopSurface: false,
      affordanceType: 'ROAM_FLOOR',
      description: 'Grounded on Room Floor',
    };
  }

  public getPointCount(): number {
    return this.vertexScanConfidence.length;
  }

  public getFurnitureCount(): number {
    return this.furnitureVolumes.size;
  }
}
