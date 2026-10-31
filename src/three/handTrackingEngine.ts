import * as THREE from 'three';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

export type HandGestureState = 'NONE' | 'OPEN_HAND' | 'GRABBING';

export interface TrackedHandTelemetry {
  handDetected: boolean;
  gesture: HandGestureState;
  isGrabbing: boolean;
  pinchStrength: number; // 0.0 (wide open) -> 1.0 (tightly pinched/grabbed)
  normX: number; // [0..1] screen X
  normY: number; // [0..1] screen Y
  ndcX: number; // [-1..1] Three.js NDC X
  ndcY: number; // [-1..1] Three.js NDC Y
  estimatedDepthMeters: number;
  landmarks2D: Array<{ x: number; y: number; z: number }>;
  hoveredAnimalId: string | null;
  carriedAnimalId: string | null;
  isOverBasketZone: boolean;
}

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4], // Thumb
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8], // Index
  [0, 9],
  [9, 10],
  [10, 11],
  [11, 12], // Middle
  [0, 13],
  [13, 14],
  [14, 15],
  [15, 16], // Ring
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20], // Pinky
  [5, 9],
  [9, 13],
  [13, 17], // Palm knuckles
];

export class ArHandTrackingEngine {
  private landmarker: HandLandmarker | null = null;
  private isInitializing = false;
  private isReady = false;
  private lastVideoTime = -1;

  // Smoothed 3D hand state with hysteresis so carrying animals never flickers
  private smoothedNormX = 0.5;
  private smoothedNormY = 0.5;
  private smoothedDepthMeters = 1.25;
  private smoothedPinchStrength = 0;
  private grabLockedState = false;
  private lostFramesCount = 0;
  private cachedLandmarks: Array<{ x: number; y: number; z: number }> = [];

  public async initialize(): Promise<boolean> {
    if (this.isReady) return true;
    if (this.isInitializing) return false;
    this.isInitializing = true;

    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'
      );
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.42,
        minHandPresenceConfidence: 0.42,
        minTrackingConfidence: 0.42,
      });
      this.isReady = true;
      return true;
    } catch {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'
        );
        this.landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.42,
          minHandPresenceConfidence: 0.42,
          minTrackingConfidence: 0.42,
        });
        this.isReady = true;
        return true;
      } catch {
        this.isInitializing = false;
        return false;
      }
    }
  }

  public isLoaded(): boolean {
    return this.isReady;
  }

  // Runs MediaPipe HandLandmarker on the live video frame and computes
  // 21-joint pose, scale-invariant pinch/grab gesture, and 3D depth estimation
  public detectHandFrame(
    videoEl: HTMLVideoElement,
    nowMs: number,
    hoveredAnimalId: string | null,
    carriedAnimalId: string | null
  ): TrackedHandTelemetry {
    if (
      !this.isReady ||
      !this.landmarker ||
      videoEl.readyState < 2 ||
      videoEl.videoWidth === 0
    ) {
      return this.buildEmptyTelemetry(hoveredAnimalId, carriedAnimalId);
    }

    if (videoEl.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = videoEl.currentTime;
      try {
        const result = this.landmarker.detectForVideo(videoEl, nowMs);
        if (result.landmarks && result.landmarks.length > 0) {
          this.lostFramesCount = 0;
          const lm = result.landmarks[0];
          this.cachedLandmarks = lm.map((p) => ({ x: p.x, y: p.y, z: p.z }));

          // 1. Compute scale-invariant palm reference size (Wrist 0 -> Index MCP 5 + Knuckle width 5 -> 17)
          const wrist = lm[0];
          const indexMcp = lm[5];
          const middleMcp = lm[9];
          const pinkyMcp = lm[17];
          const thumbTip = lm[4];
          const indexTip = lm[8];
          const middleTip = lm[12];
          const ringTip = lm[16];
          const pinkyTip = lm[20];

          const palmLen = Math.hypot(indexMcp.x - wrist.x, indexMcp.y - wrist.y);
          const palmWidth = Math.hypot(indexMcp.x - pinkyMcp.x, indexMcp.y - pinkyMcp.y);
          const palmScale = Math.max(0.06, (palmLen + palmWidth) * 0.5);

          // 2. Pinch center: midpoint between Thumb Tip (4), Index Tip (8), and Middle MCP (9)
          const rawCenterX = thumbTip.x * 0.42 + indexTip.x * 0.42 + middleMcp.x * 0.16;
          const rawCenterY = thumbTip.y * 0.42 + indexTip.y * 0.42 + middleMcp.y * 0.16;

          this.smoothedNormX = THREE.MathUtils.lerp(this.smoothedNormX, rawCenterX, 0.45);
          this.smoothedNormY = THREE.MathUtils.lerp(this.smoothedNormY, rawCenterY, 0.45);

          // 3. Monocular 3D Hand Depth Estimation from apparent palm scale in camera FOV
          const rawDepth = THREE.MathUtils.clamp(0.24 / palmScale, 0.45, 2.05);
          this.smoothedDepthMeters = THREE.MathUtils.lerp(
            this.smoothedDepthMeters,
            rawDepth,
            0.3
          );

          // 4. Gesture Recognition: Scale-Invariant Pinch Ratio & 4-Finger Curl Ratio
          const thumbIndexDist = Math.hypot(
            thumbTip.x - indexTip.x,
            thumbTip.y - indexTip.y
          );
          const thumbMiddleDist = Math.hypot(
            thumbTip.x - middleTip.x,
            thumbTip.y - middleTip.y
          );
          const minPinchDist = Math.min(thumbIndexDist, thumbMiddleDist);
          const pinchRatio = minPinchDist / palmScale;

          // Average fingertip-to-wrist distance divided by palmScale
          const avgTipToWrist =
            (Math.hypot(indexTip.x - wrist.x, indexTip.y - wrist.y) +
              Math.hypot(middleTip.x - wrist.x, middleTip.y - wrist.y) +
              Math.hypot(ringTip.x - wrist.x, ringTip.y - wrist.y) +
              Math.hypot(pinkyTip.x - wrist.x, pinkyTip.y - wrist.y)) /
            (4 * palmScale);

          // Continuous pinch strength [0 = open palm, 1 = closed grab/pinch]
          const pinchScore = THREE.MathUtils.clamp(1.0 - (pinchRatio - 0.28) / 0.55, 0, 1);
          const curlScore = THREE.MathUtils.clamp(1.0 - (avgTipToWrist - 0.95) / 0.85, 0, 1);
          const combinedStrength = Math.max(pinchScore, curlScore);

          this.smoothedPinchStrength = THREE.MathUtils.lerp(
            this.smoothedPinchStrength,
            combinedStrength,
            0.5
          );

          // Hysteresis threshold so holding an animal feels rock-solid
          if (!this.grabLockedState && this.smoothedPinchStrength >= 0.56) {
            this.grabLockedState = true;
          } else if (this.grabLockedState && this.smoothedPinchStrength <= 0.38) {
            this.grabLockedState = false;
          }
        } else {
          this.lostFramesCount++;
          if (this.lostFramesCount > 6) {
            this.cachedLandmarks = [];
            this.grabLockedState = false;
            this.smoothedPinchStrength = 0;
          }
        }
      } catch {
        // ignore transient frame error
      }
    }

    const handDetected = this.cachedLandmarks.length === 21;
    if (!handDetected) {
      return this.buildEmptyTelemetry(hoveredAnimalId, carriedAnimalId);
    }

    return {
      handDetected: true,
      gesture: this.grabLockedState ? 'GRABBING' : 'OPEN_HAND',
      isGrabbing: this.grabLockedState,
      pinchStrength: this.smoothedPinchStrength,
      normX: this.smoothedNormX,
      normY: this.smoothedNormY,
      ndcX: this.smoothedNormX * 2 - 1,
      ndcY: -(this.smoothedNormY * 2 - 1),
      estimatedDepthMeters: this.smoothedDepthMeters,
      landmarks2D: this.cachedLandmarks,
      hoveredAnimalId,
      carriedAnimalId,
      isOverBasketZone: false,
    };
  }

  private buildEmptyTelemetry(
    hoveredAnimalId: string | null,
    carriedAnimalId: string | null
  ): TrackedHandTelemetry {
    return {
      handDetected: false,
      gesture: 'NONE',
      isGrabbing: false,
      pinchStrength: 0,
      normX: 0.5,
      normY: 0.5,
      ndcX: 0,
      ndcY: 0,
      estimatedDepthMeters: 1.25,
      landmarks2D: [],
      hoveredAnimalId,
      carriedAnimalId,
      isOverBasketZone: false,
    };
  }

  // Renders the 21-joint MediaPipe Hand Skeleton, Pinch/Grab Reticle, and
  // 3D Corner Rescue Basket Tether on the 2D AR Overlay Canvas
  public drawHandSkeletonOverlay(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    telemetry: TrackedHandTelemetry,
    carriedAnimalName?: string,
    hoveredAnimalName?: string,
    cornerBasketScreen?: {
      normX: number;
      normY: number;
      inFront: boolean;
      distMeters: number;
      angleDeltaDeg: number;
      turnDir: 'left' | 'right' | 'ahead';
      isReadyToDrop: boolean;
    }
  ) {
    // Even if hand is not currently in frame, if cornerBasketScreen is in front of camera,
    // draw a crisp 3D floor corner label above the physical corner basket!
    if (cornerBasketScreen && cornerBasketScreen.inFront) {
      const bx = cornerBasketScreen.normX * width;
      const by = cornerBasketScreen.normY * height;
      if (bx >= -40 && bx <= width + 40 && by >= -40 && by <= height + 40) {
        ctx.save();
        const tag = cornerBasketScreen.isReadyToDrop
          ? `✓ CORNER BASKET (${cornerBasketScreen.distMeters.toFixed(1)}m) · RELEASE TO DROP!`
          : `CORNER RESCUE BASKET · ${cornerBasketScreen.distMeters.toFixed(1)}m`;
        ctx.font = '700 11px "JetBrains Mono", monospace';
        const tw = ctx.measureText(tag).width + 16;
        const tx = THREE.MathUtils.clamp(bx - tw * 0.5, 8, width - tw - 8);
        const ty = THREE.MathUtils.clamp(by - 48, 65, height - 120);

        ctx.fillStyle = cornerBasketScreen.isReadyToDrop
          ? 'rgba(6, 78, 59, 0.92)'
          : 'rgba(12, 10, 9, 0.88)';
        ctx.fillRect(tx, ty, tw, 22);
        ctx.strokeStyle = cornerBasketScreen.isReadyToDrop ? '#10b981' : '#f59e0b';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(tx, ty, tw, 22);
        ctx.fillStyle = cornerBasketScreen.isReadyToDrop ? '#6ee7b7' : '#fcd34d';
        ctx.fillText(tag, tx + 8, ty + 15);
        ctx.restore();
      }
    }

    if (!telemetry.handDetected || telemetry.landmarks2D.length < 21) return;

    const lm = telemetry.landmarks2D;
    const isGrabbing = telemetry.isGrabbing;
    const isHovering = Boolean(telemetry.hoveredAnimalId);
    const isCarrying = Boolean(telemetry.carriedAnimalId);

    const primaryColor = isCarrying
      ? '#10b981' // Emerald green when carrying an animal
      : isHovering
      ? '#f59e0b' // Warm amber when hand is over an animal ready to grab
      : isGrabbing
      ? '#38bdf8' // Sky blue when pinching empty air
      : '#e2e8f0'; // Crisp slate-white when open hand

    ctx.save();

    // 1. Draw 21-Joint Hand Bones
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    for (let i = 0; i < HAND_CONNECTIONS.length; i++) {
      const [a, b] = HAND_CONNECTIONS[i];
      const pa = lm[a];
      const pb = lm[b];
      ctx.beginPath();
      ctx.moveTo(pa.x * width, pa.y * height);
      ctx.lineTo(pb.x * width, pb.y * height);
      ctx.stroke();
    }

    // 2. Draw 21 Finger Joints
    for (let i = 0; i < lm.length; i++) {
      const p = lm[i];
      const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
      ctx.beginPath();
      ctx.arc(p.x * width, p.y * height, isTip ? 5.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isTip ? primaryColor : '#0f172a';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = primaryColor;
      ctx.stroke();
    }

    // 3. Draw 3D Pinch / Grab Interaction Reticle at Hand Center
    const cx = telemetry.normX * width;
    const cy = telemetry.normY * height;
    const reticleRadius = isGrabbing ? 22 : 32 - telemetry.pinchStrength * 10;

    ctx.beginPath();
    ctx.arc(cx, cy, reticleRadius, 0, Math.PI * 2);
    ctx.fillStyle = isCarrying
      ? 'rgba(16, 185, 129, 0.28)'
      : isHovering
      ? 'rgba(245, 158, 11, 0.28)'
      : 'rgba(56, 189, 248, 0.16)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = primaryColor;
    ctx.stroke();

    // 4. If carrying an animal, draw a guiding 3D tether line to the World-Locked Corner Basket!
    if (isCarrying && cornerBasketScreen) {
      const targetX = cornerBasketScreen.inFront
        ? THREE.MathUtils.clamp(cornerBasketScreen.normX * width, 24, width - 24)
        : cornerBasketScreen.turnDir === 'left'
        ? 24
        : width - 24;
      const targetY = cornerBasketScreen.inFront
        ? THREE.MathUtils.clamp(cornerBasketScreen.normY * height, 80, height - 110)
        : height * 0.55;

      ctx.save();
      ctx.setLineDash([7, 6]);
      ctx.strokeStyle = cornerBasketScreen.isReadyToDrop ? '#10b981' : '#fbbf24';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(targetX, targetY);
      ctx.stroke();
      ctx.restore();
    }

    // 5. Floating Gesture Action Prompt above the tracked hand
    const badgeText = isCarrying
      ? cornerBasketScreen?.isReadyToDrop
        ? `OPEN HAND TO DROP ${carriedAnimalName?.toUpperCase()} IN CORNER BASKET!`
        : `WALK TO CORNER BASKET (${
            cornerBasketScreen ? `${cornerBasketScreen.distMeters.toFixed(1)}m` : ''
          }) & OPEN HAND`
      : isHovering
      ? `CLOSE HAND / PINCH TO GRAB ${hoveredAnimalName?.toUpperCase()}!`
      : isGrabbing
      ? 'GRABBING (REACH OVER AN ANIMAL)'
      : 'OPEN HAND · REACH TOWARD ANIMAL';

    ctx.font = '700 11px "JetBrains Mono", monospace';
    const textW = ctx.measureText(badgeText).width + 16;
    const bx = THREE.MathUtils.clamp(cx - textW * 0.5, 10, width - textW - 10);
    const by = Math.max(70, cy - reticleRadius - 30);

    ctx.fillStyle = 'rgba(12, 10, 9, 0.92)';
    ctx.fillRect(bx, by, textW, 24);
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, textW, 24);
    ctx.fillStyle = primaryColor;
    ctx.fillText(badgeText, bx + 8, by + 16);

    ctx.restore();
  }
}

// =============================================================================
// WORLD-LOCKED 3D FLOOR CORNER SANCTUARY RESCUE BASKET MESH
// Anchored on the physical room floor (FLOOR_Y) in a corner of the room!
// Players grab animals, walk over to this corner basket, and open their hand to drop!
// =============================================================================
export function create3DRescueBasket(): THREE.Group {
  const group = new THREE.Group();
  group.renderOrder = 7;

  // 1. Woven wicker basket wall (tapered cylinder sitting on the room floor)
  const outerGeo = new THREE.CylinderGeometry(0.32, 0.24, 0.26, 24, 1, false);
  const wickerMat = new THREE.MeshStandardMaterial({
    color: 0xb45309,
    roughness: 0.78,
    metalness: 0.05,
  });
  const outerMesh = new THREE.Mesh(outerGeo, wickerMat);
  outerMesh.position.y = 0.13;
  outerMesh.castShadow = true;
  outerMesh.receiveShadow = true;
  group.add(outerMesh);

  // 2. Soft green moss/cushion lining inside the basket
  const cushionGeo = new THREE.CylinderGeometry(0.28, 0.22, 0.05, 22);
  const cushionMat = new THREE.MeshStandardMaterial({
    color: 0x059669,
    roughness: 0.88,
  });
  const cushionMesh = new THREE.Mesh(cushionGeo, cushionMat);
  cushionMesh.position.y = 0.24;
  group.add(cushionMesh);

  // 3. Braided wicker rim torus
  const rimGeo = new THREE.TorusGeometry(0.32, 0.026, 12, 32);
  rimGeo.rotateX(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xd97706,
    roughness: 0.65,
  });
  const rimMesh = new THREE.Mesh(rimGeo, rimMat);
  rimMesh.position.y = 0.26;
  group.add(rimMesh);

  // 4. Arched wicker carry handle over the basket
  const handleGeo = new THREE.TorusGeometry(0.31, 0.018, 10, 28, Math.PI);
  const handleMesh = new THREE.Mesh(handleGeo, rimMat);
  handleMesh.position.y = 0.26;
  handleMesh.castShadow = true;
  group.add(handleMesh);

  // 5. Glowing emerald floor sanctuary ring around basket base on the floor
  const glowRingGeo = new THREE.RingGeometry(0.36, 0.48, 32);
  glowRingGeo.rotateX(-Math.PI / 2);
  const glowRingMat = new THREE.MeshBasicMaterial({
    color: 0x10b981,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const glowRing = new THREE.Mesh(glowRingGeo, glowRingMat);
  glowRing.name = 'basketFloorRing';
  glowRing.position.y = 0.008;
  group.add(glowRing);

  // 6. Subtle vertical 3D Corner Beacon Diamond floating above basket so players can locate the corner
  const beaconGeo = new THREE.OctahedronGeometry(0.08, 0);
  const beaconMat = new THREE.MeshBasicMaterial({
    color: 0x34d399,
    wireframe: false,
    transparent: true,
    opacity: 0.85,
  });
  const beaconMesh = new THREE.Mesh(beaconGeo, beaconMat);
  beaconMesh.name = 'basketCornerBeacon';
  beaconMesh.position.y = 0.76;
  group.add(beaconMesh);

  return group;
}

