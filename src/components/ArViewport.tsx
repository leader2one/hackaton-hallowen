import React, { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import {
  CornerBasketPlacement,
  HiddenAnimalInstance,
  LiveDetectedObject,
  ScannedObjectStatus,
  SpeciesId,
} from '../types/safari';
import {
  ArticulatedAnimalRig,
  applyNanoBananaCoatTexture,
  applyRealObjectOccluderTexture,
  createProceduralAnimalCluster,
  updatePhysicsBasedAnimalLocomotion,
} from '../three/proceduralAnimals';
import {
  CoverageTier,
  FLOOR_Y,
  NextBestViewTarget,
  SpatialSlamEngine,
  clampToRoomFloorXZ,
  unprojectBox2dToWorld,
} from '../three/spatialSlamEngine';
import {
  ArHandTrackingEngine,
  TrackedHandTelemetry,
  create3DRescueBasket,
} from '../three/handTrackingEngine';
import { spatialAudio } from '../audio/spatialAudio';

const _camForward = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _toAnimal = new THREE.Vector3();
const _toBasket = new THREE.Vector3();
const _desiredDir = new THREE.Vector3();
const _projVec = new THREE.Vector3();
const _basketProjVec = new THREE.Vector3();
const _handWorldPos = new THREE.Vector3();
const _basketWorldPos = new THREE.Vector3(1.1, FLOOR_Y, -1.22);
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _zebee = new THREE.Vector3(0, 0, 1);
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

export interface SeekTelemetry {
  currentHeadingDeg: number;
  walkedDistanceMeters: number;
  targetName: string;
  targetParentObject: string;
  targetAnchor: string;
  targetClue: string;
  distanceToTargetMeters: number;
  angleToTargetDeg: number;
  turnDirection: 'left' | 'right' | 'ahead';
  behaviorState: 'HIDDEN' | 'PEEKING' | 'RUNNING';
  activeSurfaceLabel: string;
  activeAffordanceLabel: string;
  roomLightSummary: string;
  handTelemetry?: TrackedHandTelemetry;
  handModelReady?: boolean;
  carriedAnimalId?: string | null;
  basketDistanceMeters: number;
  basketAngleDeg: number;
  basketTurnDirection: 'left' | 'right' | 'ahead';
  isReadyToDropInBasket: boolean;
}

export interface ScanProgressTelemetry {
  progressPercent: number;
  accuratePercent: number;
  partialPercent: number;
  missedPercent: number;
  sectorStates: CoverageTier[];
  currentHeadingDeg: number;
  nbv: NextBestViewTarget;
  argonNbvSummary?: {
    accuratelyCaptured: string[];
    partiallyScanned: string[];
    nbvInstruction: string;
  };
  detectedObjects: LiveDetectedObject[];
  scannedObjects: ScannedObjectStatus[];
  uniqueLabels: string[];
  capturedFramesCount: number;
  crevicesCount: number;
  lockedCellsCount: number;
  lidarPointsCount: number;
  furnitureVolumesCount: number;
  modelLoaded: boolean;
}

export interface CapturedKeyframe {
  base64: string;
  headingDeg: number;
  pitchDeg: number;
}

export interface ArViewportHandle {
  captureFrameBase64: () => string | null;
  getCapturedScanData: () => {
    frames: CapturedKeyframe[];
    cocoDetectedLabels: string[];
    currentHeadingDeg: number;
    currentPitchDeg: number;
  };
  requestArgonNbvCheck: () => Promise<void>;
  resetScanProgress: () => void;
  stepForwardManual: (meters?: number) => void;
  resetWalkPosition: () => void;
  placeCornerBasketAtCurrentView: (
    presetYawDeg?: number,
    presetLabel?: string
  ) => CornerBasketPlacement;
}

interface ArViewportProps {
  phase: 'launch' | 'scan' | 'seek';
  animals: HiddenAnimalInstance[];
  activeTargetId: string;
  cornerBasket: CornerBasketPlacement;
  cameraStream: MediaStream | null;
  onAnimalFound: (animalId: string) => void;
  onTelemetryUpdate: (telemetry: SeekTelemetry) => void;
  onScanProgressUpdate: (scanTelemetry: ScanProgressTelemetry) => void;
}

interface BuiltAnimalNode {
  animalId: string;
  speciesId: SpeciesId;
  rig: ArticulatedAnimalRig;
  hitProxy: THREE.Mesh;
  homePos: THREE.Vector3;
  peekPos: THREE.Vector3;
  targetWaypoint: THREE.Vector3;
  localSurfaceY: number;
  preferTopSurface: boolean;
  visibilityAlpha: number;
  peekProgress: number;
  lockDwellSeconds: number;
  runTimer: number;
  behavior: 'HIDDEN' | 'PEEKING' | 'RUNNING';
}

function setObjectQuaternion(
  quaternion: THREE.Quaternion,
  alpha: number,
  beta: number,
  gamma: number,
  orient: number
) {
  _euler.set(beta, alpha, -gamma, 'YXZ');
  quaternion.setFromEuler(_euler);
  quaternion.multiply(_q1);
  quaternion.multiply(_q0.setFromAxisAngle(_zebee, -orient));
}

export const ArViewport = forwardRef<ArViewportHandle, ArViewportProps>(
  (
    {
      phase,
      animals,
      activeTargetId,
      cornerBasket,
      cameraStream,
      onAnimalFound,
      onTelemetryUpdate,
      onScanProgressUpdate,
    },
    ref
  ) => {
    const canvasMountRef = useRef<HTMLDivElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

    const [detectorReady, setDetectorReady] = useState<boolean>(false);
    const [handReady, setHandReady] = useState<boolean>(false);
    const cocoModelRef = useRef<cocoSsd.ObjectDetection | null>(null);
    const handEngineRef = useRef<ArHandTrackingEngine | null>(null);
    const slamEngineRef = useRef<SpatialSlamEngine | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const nanoBananaRequestedRef = useRef<Set<SpeciesId>>(new Set());

    const cornerBasketRef = useRef<CornerBasketPlacement>(cornerBasket);
    cornerBasketRef.current = cornerBasket;

    // Hand-Object Manipulation & Physics Carry State
    const grabStateRef = useRef({
      hoveredAnimalId: null as string | null,
      carriedAnimalId: null as string | null,
      pointerCarriedAnimalId: null as string | null,
      pointerNormX: 0.5,
      pointerNormY: 0.5,
      prevCarryPos: new THREE.Vector3(),
      carryVelocity: new THREE.Vector3(),
    });

    const phaseRef = useRef(phase);
    phaseRef.current = phase;

    const animalsRef = useRef<HiddenAnimalInstance[]>(animals);
    animalsRef.current = animals;

    const activeTargetIdRef = useRef<string>(activeTargetId);
    activeTargetIdRef.current = activeTargetId;

    const onAnimalFoundRef = useRef(onAnimalFound);
    onAnimalFoundRef.current = onAnimalFound;

    const onTelemetryUpdateRef = useRef(onTelemetryUpdate);
    onTelemetryUpdateRef.current = onTelemetryUpdate;

    const onScanProgressUpdateRef = useRef(onScanProgressUpdate);
    onScanProgressUpdateRef.current = onScanProgressUpdate;

    // Continuous 12-Sector 360° Keyframe Ring Buffer (never stops scanning early!)
    const scanStateRef = useRef({
      visitedSectors: new Set<number>(),
      lockedCells: new Float32Array(20 * 12),
      crevicesFound: 0,
      dwellProgress: 0,
      sectorKeyframes: new Map<number, CapturedKeyframe>(),
      lastFrameCaptureMs: 0,
      lastFrameCaptureHeading: -999,
      uniqueLabels: new Set<string>(),
      liveBoxes: [] as LiveDetectedObject[],
      argonNbvPending: false,
      lastArgonNbvTime: 0,
      argonNbvSummary: undefined as
        | {
            accuratelyCaptured: string[];
            partiallyScanned: string[];
            nbvInstruction: string;
          }
        | undefined,
    });

    const motionStateRef = useRef({
      posX: 0,
      posZ: 0,
      targetPosX: 0,
      targetPosZ: 0,
      hasDeviceOrientation: false,
      rawAlphaRad: 0,
      rawBetaRad: Math.PI / 2,
      rawGammaRad: 0,
      manualYawDeg: 0,
      manualPitchDeg: -12,
      smoothedYawDeg: 0,
      smoothedPitchDeg: -12,
      currentHeadingDeg: 0,
      currentPitchDeg: -12,
      lastStepTimeMs: 0,
      accelBaseline: 9.8,
      roomLightHex: 0xfffbeb,
      roomLightIntensity: 1.65,
      roomLightLabel: 'Warm indoor lighting',
    });

    const animalNodesRef = useRef<Map<string, BuiltAnimalNode>>(new Map());

    useEffect(() => {
      let mounted = true;
      cocoSsd
        .load({ base: 'lite_mobilenet_v2' })
        .then((model) => {
          if (!mounted) return;
          cocoModelRef.current = model;
          setDetectorReady(true);
        })
        .catch(() => {});

      const handEngine = new ArHandTrackingEngine();
      handEngineRef.current = handEngine;
      handEngine
        .initialize()
        .then((ok) => {
          if (!mounted) return;
          if (ok) setHandReady(true);
        })
        .catch(() => {});

      return () => {
        mounted = false;
      };
    }, []);

    useEffect(() => {
      const videoEl = videoRef.current;
      if (!videoEl) return;
      if (cameraStream) {
        if (videoEl.srcObject !== cameraStream) {
          videoEl.srcObject = cameraStream;
        }
        videoEl.play().catch(() => {});
      } else {
        videoEl.srcObject = null;
      }
    }, [cameraStream]);

    useEffect(() => {
      slamEngineRef.current?.setPhase(phase);
    }, [phase]);

    useEffect(() => {
      if (phase !== 'seek') return;
      const activeItem = animals.find((a) => a.id === activeTargetId) || animals[0];
      if (!activeItem) return;
      const speciesId = activeItem.species.id;
      if (nanoBananaRequestedRef.current.has(speciesId)) return;
      nanoBananaRequestedRef.current.add(speciesId);

      fetch('/api/nano-banana-coat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speciesName: activeItem.species.name,
          roomLightingDesc: motionStateRef.current.roomLightLabel,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data?.dataUrl) {
            animalNodesRef.current.forEach((node) => {
              if (node.speciesId === speciesId) {
                applyNanoBananaCoatTexture(node.rig, data.dataUrl);
              }
            });
          }
        })
        .catch(() => {});
    }, [phase, activeTargetId, animals]);

    const captureCurrentVideoFrame = (): string | null => {
      const videoEl = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.84);
      }
      ctx.fillStyle = '#1c1917';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.84);
    };

    const runArgonNbvEvaluation = async () => {
      const sc = scanStateRef.current;
      if (sc.argonNbvPending) return;
      const snap = captureCurrentVideoFrame();
      if (!snap) return;

      sc.argonNbvPending = true;
      sc.lastArgonNbvTime = performance.now();
      const heading = motionStateRef.current.currentHeadingDeg;
      const pitch = motionStateRef.current.currentPitchDeg;
      const slam = slamEngineRef.current;
      const cov = slam?.computeCoverageAndNbv(heading, pitch, performance.now() * 0.001);

      try {
        const res = await fetch('/api/nbv-evaluate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageBase64: snap,
            currentHeadingDeg: heading,
            accuratePercent: cov?.accuratePercent ?? 0,
            partialPercent: cov?.partialPercent ?? 0,
            missedPercent: cov?.missedPercent ?? 100,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.nbvInstruction) {
            sc.argonNbvSummary = {
              accuratelyCaptured: Array.isArray(data.accuratelyCaptured)
                ? data.accuratelyCaptured
                : [],
              partiallyScanned: Array.isArray(data.partiallyScanned)
                ? data.partiallyScanned
                : [],
              nbvInstruction: String(data.nbvInstruction),
            };
            const targetYaw =
              ((heading + (Number(data.recommendedYawOffsetDeg) || 35)) % 360 + 360) % 360;
            const targetPitch = Number(data.recommendedPitchDeg) || -18;
            slam?.setArgonNbvDirective(targetYaw, targetPitch, String(data.nbvInstruction));
          }
        }
      } catch {
        // ignore
      } finally {
        sc.argonNbvPending = false;
      }
    };

    useImperativeHandle(ref, () => ({
      captureFrameBase64: captureCurrentVideoFrame,
      getCapturedScanData: () => {
        const sc = scanStateRef.current;
        const currentHeadingDeg = motionStateRef.current.currentHeadingDeg;
        const currentPitchDeg = motionStateRef.current.currentPitchDeg;
        const latest = captureCurrentVideoFrame();
        if (latest) {
          const secIdx = Math.floor((((currentHeadingDeg % 360) + 360) % 360) / 30);
          sc.sectorKeyframes.set(secIdx, {
            base64: latest,
            headingDeg: currentHeadingDeg,
            pitchDeg: currentPitchDeg,
          });
        }

        // Gather up to 4 well-spaced multi-angle keyframes from the 12-sector ring buffer
        const allKeyframes = Array.from(sc.sectorKeyframes.values());
        let selectedFrames = allKeyframes;
        if (allKeyframes.length > 4) {
          selectedFrames = [];
          const step = allKeyframes.length / 4;
          for (let i = 0; i < 4; i++) {
            selectedFrames.push(allKeyframes[Math.floor(i * step)]);
          }
        }

        return {
          frames: selectedFrames,
          cocoDetectedLabels: Array.from(sc.uniqueLabels),
          currentHeadingDeg,
          currentPitchDeg,
        };
      },
      requestArgonNbvCheck: runArgonNbvEvaluation,
      resetScanProgress: () => {
        const sc = scanStateRef.current;
        sc.visitedSectors.clear();
        sc.lockedCells.fill(0);
        sc.crevicesFound = 0;
        sc.dwellProgress = 0;
        sc.sectorKeyframes.clear();
        sc.lastFrameCaptureMs = 0;
        sc.lastFrameCaptureHeading = -999;
        sc.uniqueLabels.clear();
        sc.liveBoxes = [];
        sc.argonNbvSummary = undefined;
        slamEngineRef.current?.resetScan();
      },
      stepForwardManual: (meters = 0.45) => {
        const st = motionStateRef.current;
        const horizLen = Math.hypot(_camForward.x, _camForward.z) || 1;
        // Clamp player walking position inside the room center so they never walk outside the room bounds
        st.targetPosX = THREE.MathUtils.clamp(
          st.targetPosX + (_camForward.x / horizLen) * meters,
          -0.85,
          0.85
        );
        st.targetPosZ = THREE.MathUtils.clamp(
          st.targetPosZ + (_camForward.z / horizLen) * meters,
          -0.85,
          0.85
        );
      },
      resetWalkPosition: () => {
        const st = motionStateRef.current;
        st.posX = 0;
        st.posZ = 0;
        st.targetPosX = 0;
        st.targetPosZ = 0;
      },
      placeCornerBasketAtCurrentView: (presetYawDeg?: number, presetLabel?: string) => {
        const st = motionStateRef.current;
        const headingDeg =
          typeof presetYawDeg === 'number'
            ? ((presetYawDeg % 360) + 360) % 360
            : st.currentHeadingDeg;
        const yawRad = THREE.MathUtils.degToRad(headingDeg);
        const dist = 1.4;
        const rawBx = st.posX + Math.sin(yawRad) * dist;
        const rawBz = st.posZ - Math.cos(yawRad) * dist;
        const [clampedBx, clampedBz] = clampToRoomFloorXZ(rawBx, rawBz);
        const bx = Number(clampedBx.toFixed(2));
        const bz = Number(clampedBz.toFixed(2));
        const compassDir =
          presetLabel ||
          (headingDeg >= 315 || headingDeg < 45
            ? 'Front Floor'
            : headingDeg >= 45 && headingDeg < 135
            ? 'Right Corner'
            : headingDeg >= 135 && headingDeg < 225
            ? 'Back Corner'
            : 'Left Corner');
        const placement: CornerBasketPlacement = {
          yawDeg: Math.round(headingDeg),
          distanceMeters: dist,
          worldPos: [bx, FLOOR_Y, bz],
          cornerLabel: `${compassDir} (${dist.toFixed(1)}m)`,
        };
        cornerBasketRef.current = placement;
        return placement;
      },
    }));

    // =========================================================================
    // CONTINUOUS 3D SLAM + PER-OBJECT SCAN TRACKING + COVERAGE HEATMAP LOOP
    // =========================================================================
    useEffect(() => {
      if (phase !== 'scan') {
        const overlay = overlayCanvasRef.current;
        if (overlay) {
          const ctx = overlay.getContext('2d');
          ctx?.clearRect(0, 0, overlay.width, overlay.height);
        }
        return;
      }

      let active = true;
      const cvBuffer = document.createElement('canvas');
      const cvW = 96;
      const cvH = 54;
      cvBuffer.width = cvW;
      cvBuffer.height = cvH;
      const cvCtx = cvBuffer.getContext('2d', { willReadFrequently: true });

      let tickCount = 0;

      const runSpatialSlamTick = async () => {
        if (!active || phaseRef.current !== 'scan') return;
        tickCount++;

        const videoEl = videoRef.current;
        const overlay = overlayCanvasRef.current;
        const slam = slamEngineRef.current;
        const cam = cameraRef.current;
        const sc = scanStateRef.current;
        const heading = motionStateRef.current.currentHeadingDeg;
        const pitch = motionStateRef.current.currentPitchDeg;
        const nowMs = performance.now();

        const sector = Math.floor(heading / 20);
        sc.visitedSectors.add(sector);

        // Continuously capture & update 360° keyframes across 12 sectors (30° each)
        // Never stops after 3 frames — keeps updating as user scans new objects!
        const keyframeSector = Math.floor((((heading % 360) + 360) % 360) / 30);
        const angleMoved = Math.abs(heading - sc.lastFrameCaptureHeading);
        if (
          (!sc.sectorKeyframes.has(keyframeSector) ||
            (angleMoved > 16 && nowMs - sc.lastFrameCaptureMs > 1100)) &&
          nowMs - sc.lastFrameCaptureMs > 650
        ) {
          const snap = captureCurrentVideoFrame();
          if (snap) {
            sc.sectorKeyframes.set(keyframeSector, {
              base64: snap,
              headingDeg: heading,
              pitchDeg: pitch,
            });
            sc.lastFrameCaptureHeading = heading;
            sc.lastFrameCaptureMs = nowMs;

            if (!sc.argonNbvPending && nowMs - sc.lastArgonNbvTime > 7500) {
              runArgonNbvEvaluation();
            }
          }
        }

        let featureRichness = 0.35;

        if (cvCtx && slam && cam) {
          let hasVideo = false;
          if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
            cvCtx.drawImage(videoEl, 0, 0, cvW, cvH);
            hasVideo = true;
          }

          const featureBatch: Array<{
            ndcX: number;
            ndcY: number;
            edgeStrength: number;
            luma: number;
            isCrevice: boolean;
          }> = [];

          if (hasVideo) {
            const srcData = cvCtx.getImageData(0, 0, cvW, cvH).data;
            const luma = new Float32Array(cvW * cvH);
            for (let i = 0; i < cvW * cvH; i++) {
              const p = i * 4;
              luma[i] = 0.299 * srcData[p] + 0.587 * srcData[p + 1] + 0.114 * srcData[p + 2];
            }

            let frameCrevices = 0;
            let strongEdges = 0;
            for (let y = 2; y < cvH - 2; y += 3) {
              for (let x = 2; x < cvW - 2; x += 3) {
                const idx = y * cvW + x;
                const gx = luma[idx + 1] - luma[idx - 1];
                const gy = luma[idx + cvW] - luma[idx - cvW];
                const mag = Math.hypot(gx, gy);

                const cellX = Math.min(19, Math.floor((x / cvW) * 20));
                const cellY = Math.min(11, Math.floor((y / cvH) * 12));
                const cellIdx = cellY * 20 + cellX;

                if (mag > 20 || (x + y + tickCount) % 7 === 0) {
                  if (mag > 28) strongEdges++;
                  sc.lockedCells[cellIdx] = Math.min(1.0, sc.lockedCells[cellIdx] + 0.032);
                  const isCrevice = mag > 35 && luma[idx + cvW] < 68 && y > cvH * 0.28;
                  if (isCrevice) frameCrevices++;

                  featureBatch.push({
                    ndcX: (x / cvW) * 2 - 1,
                    ndcY: -((y / cvH) * 2 - 1),
                    edgeStrength: Math.min(1, mag / 95),
                    luma: luma[idx],
                    isCrevice,
                  });
                }
              }
            }
            featureRichness = THREE.MathUtils.clamp(strongEdges / 80, 0.2, 1.0);
            sc.crevicesFound = Math.max(sc.crevicesFound, Math.min(16, frameCrevices));
          } else {
            for (let i = 0; i < 24; i++) {
              const rx = (Math.random() - 0.5) * 1.6;
              const ry = -0.15 - Math.random() * 0.75;
              const cellIdx = Math.floor(Math.random() * sc.lockedCells.length);
              sc.lockedCells[cellIdx] = Math.min(1.0, sc.lockedCells[cellIdx] + 0.04);
              featureBatch.push({
                ndcX: rx,
                ndcY: ry,
                edgeStrength: 0.5,
                luma: 120,
                isCrevice: i % 6 === 0,
              });
            }
            featureRichness = 0.55;
            sc.crevicesFound = Math.max(sc.crevicesFound, 5);
          }

          slam.recordCameraViewObservation(heading, pitch, featureRichness);
          slam.integrateDepthFrame(cam, featureBatch);
        }

        const scannedObjects = slam?.getScannedObjectStatuses() ?? [];

        if (
          tickCount % 2 === 0 &&
          cocoModelRef.current &&
          videoEl &&
          videoEl.readyState >= 2 &&
          videoEl.videoWidth > 0
        ) {
          try {
            // Careful high-confidence object detection (>= 0.58 confidence + strict indoor allowlist)
            const predictions = await cocoModelRef.current.detect(videoEl, 6, 0.58);
            const verifiedSet = new Set([
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
            const highConfPreds = predictions.filter(
              (p) => p.score >= 0.58 && verifiedSet.has(p.class.toLowerCase())
            );
            const rawBoxes: LiveDetectedObject[] = highConfPreds.map((p, idx) => {
              sc.uniqueLabels.add(p.class);
              return {
                id: `${p.class}_${idx}`,
                label: p.class,
                score: p.score,
                bbox: p.bbox as [number, number, number, number],
                headingDeg: heading,
              };
            });

            slam?.registerLiveCocoDetections(
              rawBoxes,
              videoEl.videoWidth,
              videoEl.videoHeight,
              heading
            );

            const updatedObjList = slam?.getScannedObjectStatuses() ?? [];
            sc.liveBoxes = rawBoxes.map((box) => {
              const match = updatedObjList.find(
                (o) => o.label.toLowerCase() === box.label.toLowerCase()
              );
              return {
                ...box,
                objectScanPercent: match ? match.scanPercent : 45,
              };
            });
          } catch {
            // ignore
          }
        }

        const coverage = slam?.computeCoverageAndNbv(
          heading,
          pitch,
          nowMs * 0.001
        ) ?? {
          accuratePercent: 0,
          partialPercent: 0,
          missedPercent: 100,
          sectorStates: new Array(18).fill('missed') as CoverageTier[],
          nbv: {
            yawDeg: 45,
            pitchDeg: -16,
            deltaYawDeg: 45,
            deltaPitchDeg: -4,
            directionLabel: 'Pan Right 45° & Tilt Down',
            reason: 'Unscanned floor & under-furniture zone',
            worldPos: [1.5, -1.0, -1.5] as [number, number, number],
            tier: 'missed' as CoverageTier,
          },
        };

        if (overlay) {
          const rect = overlay.getBoundingClientRect();
          if (overlay.width !== rect.width || overlay.height !== rect.height) {
            overlay.width = rect.width;
            overlay.height = rect.height;
          }
          const ctx = overlay.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, overlay.width, overlay.height);

            // Clean, zero-noise Grey (Unscanned) -> Green (Scanned) object outline
            if (videoEl && videoEl.videoWidth > 0 && sc.liveBoxes.length > 0) {
              const scaleX = overlay.width / videoEl.videoWidth;
              const scaleY = overlay.height / videoEl.videoHeight;

              sc.liveBoxes.forEach((det) => {
                const [bx, by, bw, bh] = det.bbox;
                const x = bx * scaleX;
                const y = by * scaleY;
                const w = bw * scaleX;
                const h = bh * scaleY;

                const objPct = det.objectScanPercent ?? 30;
                const isGreen = objPct >= 75;
                ctx.strokeStyle = isGreen ? '#10b981' : '#94a3b8';
                ctx.lineWidth = 2;
                ctx.strokeRect(x, y, w, h);

                const tagText = `${det.label.toUpperCase()} · ${objPct}%`;
                ctx.font = '600 11px "JetBrains Mono", monospace';
                const textW = ctx.measureText(tagText).width + 12;
                ctx.fillStyle = isGreen
                  ? 'rgba(6, 78, 59, 0.90)'
                  : 'rgba(30, 41, 59, 0.90)';
                ctx.fillRect(x, Math.max(4, y - 22), textW, 18);
                ctx.fillStyle = isGreen ? '#6ee7b7' : '#cbd5e1';
                ctx.fillText(tagText, x + 6, Math.max(17, y - 9));
              });
            }
          }
        }

        let lockedCellsCount = 0;
        for (let i = 0; i < sc.lockedCells.length; i++) {
          if (sc.lockedCells[i] > 0.45) lockedCellsCount++;
        }

        const lidarPts = slam?.getPointCount() ?? 0;
        const furnCount = slam?.getFurnitureCount() ?? 0;

        const weightedCoverage = Math.min(
          100,
          Math.round(coverage.accuratePercent + coverage.partialPercent * 0.45)
        );

        onScanProgressUpdateRef.current({
          progressPercent: weightedCoverage,
          accuratePercent: coverage.accuratePercent,
          partialPercent: coverage.partialPercent,
          missedPercent: coverage.missedPercent,
          sectorStates: coverage.sectorStates,
          currentHeadingDeg: heading,
          nbv: coverage.nbv,
          argonNbvSummary: sc.argonNbvSummary,
          detectedObjects: sc.liveBoxes,
          scannedObjects: slam?.getScannedObjectStatuses() ?? scannedObjects,
          uniqueLabels: Array.from(sc.uniqueLabels),
          capturedFramesCount: sc.sectorKeyframes.size,
          crevicesCount: sc.crevicesFound,
          lockedCellsCount,
          lidarPointsCount: lidarPts,
          furnitureVolumesCount: furnCount,
          modelLoaded: Boolean(cocoModelRef.current) || detectorReady,
        });
      };

      const timer = window.setInterval(runSpatialSlamTick, 85);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [phase, detectorReady]);

    // Sync 3D Furniture Volumes & Unproject 2D-to-3D Animal Surface Anchors
    useEffect(() => {
      const nodes = animalNodesRef.current;
      const slam = slamEngineRef.current;
      if (nodes.size === 0) return;

      slam?.buildFurnitureFromPlacements(animals);
      slam?.setPhase(phaseRef.current);

      const aspect =
        (canvasMountRef.current?.clientWidth || window.innerWidth) /
        Math.max(1, canvasMountRef.current?.clientHeight || window.innerHeight);

      animals.forEach((item) => {
        const node = nodes.get(item.id);
        if (!node) return;

        const mode =
          item.surfaceMode ||
          (item.occlusionEdge === 'bottom'
            ? 'on_furniture'
            : item.occlusionEdge === 'top'
            ? 'under_furniture'
            : 'behind_furniture');

        node.preferTopSurface = false;

        let rawX = 0;
        let rawZ = -item.distanceMeters;

        if (item.box2d) {
          const unprojected = unprojectBox2dToWorld(
            item.box2d,
            item.sourceFrameHeadingDeg ?? item.yawDeg,
            item.sourceFramePitchDeg ?? -18,
            item.distanceMeters,
            aspect,
            65
          );
          rawX = unprojected.worldPos.x;
          rawZ = unprojected.worldPos.z;
        } else {
          const yawRad = THREE.MathUtils.degToRad(item.yawDeg);
          const dist = THREE.MathUtils.clamp(item.distanceMeters, 1.4, 2.1);
          rawX = Math.sin(yawRad) * dist;
          rawZ = -Math.cos(yawRad) * dist;
        }

        // Clamp every animal strictly inside the room's XYZ floor footprint and lock Y = FLOOR_Y!
        const [x, z] = clampToRoomFloorXZ(rawX, rawZ);
        const groundY = FLOOR_Y;

        node.localSurfaceY = groundY;

        const effectiveYawRad = Math.atan2(x, -z);
        const rightX = Math.cos(effectiveYawRad);
        const rightZ = Math.sin(effectiveYawRad);
        const forwardToCamX = -Math.sin(effectiveYawRad);
        const forwardToCamZ = Math.cos(effectiveYawRad);

        node.homePos.set(x, groundY, z);

        let peekOffsetX = forwardToCamX * 0.16;
        let peekOffsetZ = forwardToCamZ * 0.16;
        if (item.occlusionEdge === 'left') {
          peekOffsetX += rightX * 0.18;
          peekOffsetZ += rightZ * 0.18;
        } else if (item.occlusionEdge === 'right') {
          peekOffsetX -= rightX * 0.18;
          peekOffsetZ -= rightZ * 0.18;
        }

        const [px, pz] = clampToRoomFloorXZ(x + peekOffsetX, z + peekOffsetZ);
        node.peekPos.set(px, groundY, pz);
        node.targetWaypoint.copy(node.peekPos);

        node.rig.root.position.set(x, groundY, z);
        node.rig.occlusionEdge = item.occlusionEdge || 'bottom';
        node.rig.physics.velocity.set(0, 0, 0);
        node.rig.physics.angularVelocityY = 0;
        node.rig.physics.isGrounded = true;
        node.rig.physics.crouchFactor = mode === 'under_furniture' ? 0.55 : 0.08;
        node.rig.physics.headingRad = Math.atan2(-x, -z);
        node.rig.physics.targetHeadingRad = Math.atan2(-x, -z);
        node.rig.physics.initializedFootsteps = false;
        node.rig.physics.affordanceDescription = `Grounded on floor near ${item.detectedParentObject}`;

        // Keep occluder plane disabled so animals are always clearly visible on the floor
        node.rig.occluderPlane.visible = false;

        node.rig.root.visible = false;
        node.visibilityAlpha = 0;
        node.peekProgress = 0.0;
        node.lockDwellSeconds = 0;
        node.behavior = 'HIDDEN';
      });
    }, [animals]);

    // Gyroscope Orientation + Walking Step Detector
    useEffect(() => {
      const handleOrientation = (e: DeviceOrientationEvent) => {
        if (e.alpha === null || e.beta === null || e.gamma === null) return;
        const st = motionStateRef.current;
        st.hasDeviceOrientation = true;
        st.rawAlphaRad = THREE.MathUtils.degToRad(e.alpha);
        st.rawBetaRad = THREE.MathUtils.degToRad(e.beta);
        st.rawGammaRad = THREE.MathUtils.degToRad(e.gamma);
      };

      const handleMotion = (e: DeviceMotionEvent) => {
        if (phaseRef.current !== 'seek') return;
        const acc = e.accelerationIncludingGravity;
        if (!acc || acc.x === null || acc.y === null || acc.z === null) return;

        const mag = Math.hypot(acc.x, acc.y, acc.z);
        const st = motionStateRef.current;
        st.accelBaseline = st.accelBaseline * 0.92 + mag * 0.08;
        const deltaAccel = mag - st.accelBaseline;

        const now = performance.now();
        if (deltaAccel > 1.2 && now - st.lastStepTimeMs > 420) {
          st.lastStepTimeMs = now;
          const horizLen = Math.hypot(_camForward.x, _camForward.z) || 1;
          st.targetPosX = THREE.MathUtils.clamp(
            st.targetPosX + (_camForward.x / horizLen) * 0.35,
            -0.85,
            0.85
          );
          st.targetPosZ = THREE.MathUtils.clamp(
            st.targetPosZ + (_camForward.z / horizLen) * 0.35,
            -0.85,
            0.85
          );
        }
      };

      window.addEventListener('deviceorientation', handleOrientation, true);
      window.addEventListener('devicemotion', handleMotion, true);
      return () => {
        window.removeEventListener('deviceorientation', handleOrientation, true);
        window.removeEventListener('devicemotion', handleMotion, true);
      };
    }, []);

    // Live Room Lighting Color Temperature & Luminance Matcher
    useEffect(() => {
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = 32;
      probeCanvas.height = 18;
      const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

      const interval = window.setInterval(() => {
        const videoEl = videoRef.current;
        if (!probeCtx || !videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return;

        probeCtx.drawImage(videoEl, 0, 0, 32, 18);
        const pixels = probeCtx.getImageData(0, 0, 32, 18).data;

        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        const count = 32 * 18;

        for (let i = 0; i < pixels.length; i += 4) {
          rSum += pixels[i];
          gSum += pixels[i + 1];
          bSum += pixels[i + 2];
        }

        const rAvg = rSum / count;
        const gAvg = gSum / count;
        const bAvg = bSum / count;
        const luma = (0.299 * rAvg + 0.587 * gAvg + 0.114 * bAvg) / 255;

        const st = motionStateRef.current;
        const color = new THREE.Color(rAvg / 255, gAvg / 255, bAvg / 255);
        color.lerp(new THREE.Color(0xffffff), 0.5);
        st.roomLightHex = color.getHex();
        st.roomLightIntensity = THREE.MathUtils.clamp(0.9 + luma * 1.4, 0.85, 2.2);
        st.roomLightLabel =
          rAvg > bAvg + 15
            ? 'warm indoor tungsten lighting'
            : bAvg > rAvg + 15
            ? 'cool daylight window lighting'
            : 'balanced natural room lighting';
      }, 400);

      return () => clearInterval(interval);
    }, []);

    // Initialize Three.js WebGL Scene + SpatialSlamEngine + 3D Physics-Based Animals
    useEffect(() => {
      const container = canvasMountRef.current;
      if (!container) return;

      const isSoftwareGl = (() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return true;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
        const gpu = String(gl.getParameter(param));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      })();

      const renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        alpha: true,
        powerPreference: 'high-performance',
      });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
      renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = !isSoftwareGl;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setClearColor(0x000000, 0);

      const width = container.clientWidth || window.innerWidth;
      const height = container.clientHeight || window.innerHeight;
      renderer.setSize(width, height);
      container.innerHTML = '';
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(65, width / height, 0.1, 80);
      camera.position.set(0, 0, 0);
      cameraRef.current = camera;

      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      pmremGenerator.dispose();

      const hemiLight = new THREE.HemisphereLight(0xffffff, 0x44403c, 1.15);
      scene.add(hemiLight);

      const keyLight = new THREE.DirectionalLight(0xfffbeb, 1.7);
      keyLight.position.set(2.5, 6.0, 2.5);
      if (!isSoftwareGl) {
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.width = 1024;
        keyLight.shadow.mapSize.height = 1024;
        keyLight.shadow.camera.near = 0.5;
        keyLight.shadow.camera.far = 16;
        const d = 6;
        keyLight.shadow.camera.left = -d;
        keyLight.shadow.camera.right = d;
        keyLight.shadow.camera.top = d;
        keyLight.shadow.camera.bottom = -d;
        keyLight.shadow.bias = -0.0008;
      }
      scene.add(keyLight);

      const slamEngine = new SpatialSlamEngine(scene);
      slamEngine.setPhase(phaseRef.current);
      slamEngineRef.current = slamEngine;

      // 3D Virtual Sanctuary Rescue Basket (Players carry grabbed animals here and release!)
      const rescueBasket = create3DRescueBasket();
      rescueBasket.visible = false;
      scene.add(rescueBasket);

      const hitProxies: THREE.Mesh[] = [];
      const builtMap = new Map<string, BuiltAnimalNode>();

      animalsRef.current.forEach((item) => {
        const rig = createProceduralAnimalCluster(item.species.id, item.coverType);
        const yawRad = THREE.MathUtils.degToRad(item.yawDeg);
        const dist = THREE.MathUtils.clamp(item.distanceMeters, 1.4, 2.1);
        const [x, z] = clampToRoomFloorXZ(Math.sin(yawRad) * dist, -Math.cos(yawRad) * dist);

        rig.root.position.set(x, FLOOR_Y, z);
        rig.root.visible = false;
        scene.add(rig.root);

        const proxyGeo = new THREE.SphereGeometry(0.48, 8, 8);
        const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
        const hitProxy = new THREE.Mesh(proxyGeo, proxyMat);
        hitProxy.position.set(0, 0.22, 0);
        hitProxy.layers.set(1);
        hitProxy.userData.animalId = item.id;
        rig.root.add(hitProxy);
        hitProxies.push(hitProxy);

        builtMap.set(item.id, {
          animalId: item.id,
          speciesId: item.species.id,
          rig,
          hitProxy,
          homePos: new THREE.Vector3(x, FLOOR_Y, z),
          peekPos: new THREE.Vector3(x, FLOOR_Y, z),
          targetWaypoint: new THREE.Vector3(x, FLOOR_Y, z),
          localSurfaceY: FLOOR_Y,
          preferTopSurface: false,
          visibilityAlpha: 0,
          peekProgress: 0,
          lockDwellSeconds: 0,
          runTimer: 0,
          behavior: 'HIDDEN',
        });
      });

      animalNodesRef.current = builtMap;

      if (!isSoftwareGl) {
        renderer.compile(scene, camera);
      }

      const raycaster = new THREE.Raycaster();
      raycaster.layers.set(1);
      const pointerNDC = new THREE.Vector2();

      let isDragging = false;
      let dragDist = 0;
      let prevX = 0;
      let prevY = 0;
      const domEl = renderer.domElement;

      const onPointerDown = (e: PointerEvent) => {
        spatialAudio.unlock();
        isDragging = true;
        dragDist = 0;
        prevX = e.clientX;
        prevY = e.clientY;

        if (phaseRef.current === 'seek') {
          const rect = domEl.getBoundingClientRect();
          const normX = (e.clientX - rect.left) / Math.max(1, rect.width);
          const normY = (e.clientY - rect.top) / Math.max(1, rect.height);
          pointerNDC.x = normX * 2 - 1;
          pointerNDC.y = -(normY * 2 - 1);

          raycaster.setFromCamera(pointerNDC, camera);
          const hits = raycaster.intersectObjects(hitProxies, false);
          if (hits.length > 0) {
            const hitAnimalId = hits[0].object.userData.animalId as string;
            const node = hitAnimalId ? builtMap.get(hitAnimalId) : undefined;
            if (hitAnimalId && node && node.rig.root.visible && node.visibilityAlpha > 0.25) {
              const gs = grabStateRef.current;
              gs.pointerCarriedAnimalId = hitAnimalId;
              gs.carriedAnimalId = hitAnimalId;
              gs.pointerNormX = normX;
              gs.pointerNormY = normY;
              gs.prevCarryPos.copy(node.rig.root.position);
              gs.carryVelocity.set(0, 0, 0);
              spatialAudio.playScanSweep();
            }
          }
        }
      };

      const onPointerMove = (e: PointerEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - prevX;
        const dy = e.clientY - prevY;
        prevX = e.clientX;
        prevY = e.clientY;
        dragDist += Math.hypot(dx, dy);

        const gs = grabStateRef.current;
        if (gs.pointerCarriedAnimalId) {
          const rect = domEl.getBoundingClientRect();
          gs.pointerNormX = THREE.MathUtils.clamp(
            (e.clientX - rect.left) / Math.max(1, rect.width),
            0.05,
            0.95
          );
          gs.pointerNormY = THREE.MathUtils.clamp(
            (e.clientY - rect.top) / Math.max(1, rect.height),
            0.05,
            0.95
          );
          return;
        }

        const st = motionStateRef.current;
        if (!st.hasDeviceOrientation) {
          st.manualYawDeg = (st.manualYawDeg - dx * 0.32 + 360) % 360;
          st.manualPitchDeg = THREE.MathUtils.clamp(st.manualPitchDeg + dy * 0.25, -55, 45);
        }
      };

      const onPointerUp = () => {
        if (!isDragging) return;
        isDragging = false;

        const gs = grabStateRef.current;
        if (gs.pointerCarriedAnimalId) {
          const releasedId = gs.pointerCarriedAnimalId;
          const node = builtMap.get(releasedId);

          // Project the 3D World-Locked Floor Corner Basket to screen to check if pointer released over it
          _basketProjVec.copy(rescueBasket.position);
          _basketProjVec.y += 0.16;
          _basketProjVec.project(camera);
          const basketInFront = _basketProjVec.z < 1.0;
          const basketScreenX = (_basketProjVec.x + 1) * 0.5;
          const basketScreenY = (1 - _basketProjVec.y) * 0.5;
          const screenDistToBasket = Math.hypot(
            gs.pointerNormX - basketScreenX,
            gs.pointerNormY - basketScreenY
          );
          const worldDistToBasket = node
            ? node.rig.root.position.distanceTo(rescueBasket.position)
            : 999;

          const isOverCornerBasket =
            (basketInFront && screenDistToBasket < 0.28) || worldDistToBasket < 1.05;

          gs.pointerCarriedAnimalId = null;
          gs.carriedAnimalId = null;

          if (isOverCornerBasket) {
            onAnimalFoundRef.current(releasedId);
          } else if (node) {
            // Released away from the corner basket -> drop with real gravity onto furniture/floor!
            node.rig.physics.velocity.copy(gs.carryVelocity);
            node.rig.physics.isGrounded = false;
            node.homePos.set(
              node.rig.root.position.x,
              node.localSurfaceY,
              node.rig.root.position.z
            );
            node.peekPos.copy(node.homePos);
            node.targetWaypoint.copy(node.homePos);
          }
        }
      };

      domEl.addEventListener('pointerdown', onPointerDown);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);

      const onResize = () => {
        if (!container) return;
        const w = container.clientWidth || window.innerWidth;
        const h = container.clientHeight || window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener('resize', onResize);

      const clock = new THREE.Clock();
      let frameId = 0;
      let lastTelemetryMs = 0;
      const targetQuat = new THREE.Quaternion();

      function afterDraw(cb: () => void) {
        const gl = renderer.getContext() as WebGL2RenderingContext;
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = () => {
          const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (state === gl.UNSIGNALED) {
            frameId = window.setTimeout(poll, 5);
          } else {
            if (sync) gl.deleteSync(sync);
            frameId = window.setTimeout(cb, 80);
          }
        };
        frameId = window.setTimeout(poll, 5);
      }

      function tick() {
        const delta = Math.min(clock.getDelta(), 0.1);
        const elapsed = clock.getElapsedTime();
        const nowMs = performance.now();
        const st = motionStateRef.current;

        keyLight.color.setHex(st.roomLightHex);
        keyLight.intensity = st.roomLightIntensity;

        st.posX = THREE.MathUtils.damp(st.posX, st.targetPosX, 5, delta);
        st.posZ = THREE.MathUtils.damp(st.posZ, st.targetPosZ, 5, delta);
        camera.position.set(st.posX, 0, st.posZ);

        if (st.hasDeviceOrientation) {
          const screenOrientDeg =
            typeof window.screen?.orientation?.angle === 'number'
              ? window.screen.orientation.angle
              : Number((window as unknown as { orientation?: number }).orientation) || 0;
          setObjectQuaternion(
            targetQuat,
            st.rawAlphaRad,
            st.rawBetaRad,
            st.rawGammaRad,
            THREE.MathUtils.degToRad(screenOrientDeg)
          );
          // Extract compass yaw and horizon-stabilize pitch & roll so the 3D ground plane (FLOOR_Y)
          // stays firmly anchored to the physical room floor without tilting or floating!
          _euler.setFromQuaternion(targetQuat, 'YXZ');
          const rawPitchDeg = THREE.MathUtils.radToDeg(_euler.x);
          const stabilizedPitchDeg = THREE.MathUtils.clamp(
            THREE.MathUtils.lerp(-16, rawPitchDeg, 0.55),
            -30,
            6
          );
          _euler.x = THREE.MathUtils.degToRad(stabilizedPitchDeg);
          _euler.z = 0; // Zero roll twist so floor stays level with real horizon
          targetQuat.setFromEuler(_euler);
          camera.quaternion.slerp(targetQuat, Math.min(1, delta * 14));
        } else {
          let yawDiff = st.manualYawDeg - st.smoothedYawDeg;
          if (yawDiff > 180) yawDiff -= 360;
          if (yawDiff < -180) yawDiff += 360;
          st.smoothedYawDeg =
            ((st.smoothedYawDeg + yawDiff * Math.min(1, delta * 12)) % 360 + 360) % 360;
          st.smoothedPitchDeg = THREE.MathUtils.damp(
            st.smoothedPitchDeg,
            THREE.MathUtils.clamp(st.manualPitchDeg, -30, 6),
            12,
            delta
          );
          _euler.set(
            THREE.MathUtils.degToRad(st.smoothedPitchDeg),
            THREE.MathUtils.degToRad(-st.smoothedYawDeg),
            0,
            'YXZ'
          );
          camera.quaternion.setFromEuler(_euler);
        }

        camera.getWorldDirection(_camForward);
        _camRight.crossVectors(_camForward, camera.up).normalize();
        _camUp.crossVectors(_camRight, _camForward).normalize();

        const headingRad = Math.atan2(_camForward.x, -_camForward.z);
        st.currentHeadingDeg = ((THREE.MathUtils.radToDeg(headingRad) % 360) + 360) % 360;
        st.currentPitchDeg = THREE.MathUtils.radToDeg(
          Math.asin(THREE.MathUtils.clamp(_camForward.y, -1, 1))
        );

        const currentPhase = phaseRef.current;
        const currentAnimals = animalsRef.current;
        const currentTargetId = activeTargetIdRef.current;
        const cb = cornerBasketRef.current;

        // =====================================================================
        // 1. ANCHOR 3D RESCUE BASKET AT WORLD-LOCKED FLOOR CORNER IN THE ROOM!
        // =====================================================================
        if (currentPhase === 'scan' || currentPhase === 'seek') {
          rescueBasket.visible = true;
          const [clampedBx, clampedBz] = clampToRoomFloorXZ(cb.worldPos[0], cb.worldPos[2]);
          _basketWorldPos.set(clampedBx, FLOOR_Y, clampedBz);
          rescueBasket.position.lerp(_basketWorldPos, Math.min(1, delta * 16));
          rescueBasket.position.y = FLOOR_Y;

          const beacon = rescueBasket.getObjectByName('basketCornerBeacon');
          if (beacon) {
            beacon.rotation.y = elapsed * 2.2;
            beacon.position.y = 0.72 + Math.sin(elapsed * 3.2) * 0.05;
          }
          const floorRing = rescueBasket.getObjectByName('basketFloorRing');
          if (floorRing) {
            const s = 1.0 + Math.sin(elapsed * 4.0) * 0.06;
            floorRing.scale.set(s, s, 1);
          }
        } else {
          rescueBasket.visible = false;
        }

        if (currentPhase !== 'seek') {
          builtMap.forEach((node) => {
            node.rig.root.visible = false;
            node.visibilityAlpha = 0;
          });
        } else {
          // Compute 3D vector & direction from player to the World-Locked Corner Basket
          _toBasket.copy(rescueBasket.position).sub(camera.position);
          const basketDistanceMeters = Math.hypot(_toBasket.x, _toBasket.z);
          _toBasket.normalize();
          const basketDot = THREE.MathUtils.clamp(_camForward.dot(_toBasket), -1, 1);
          const basketAngleDeg = THREE.MathUtils.radToDeg(Math.acos(basketDot));
          const basketCrossY = _camForward.x * _toBasket.z - _camForward.z * _toBasket.x;
          const basketTurnDirection: SeekTelemetry['basketTurnDirection'] =
            basketAngleDeg < 22 ? 'ahead' : basketCrossY < 0 ? 'left' : 'right';

          // Project 3D Corner Basket to 2D normalized screen coordinates
          _basketProjVec.copy(rescueBasket.position);
          _basketProjVec.y += 0.16;
          _basketProjVec.project(camera);
          const basketInFront = _basketProjVec.z < 1.0;
          const basketScreenNormX = (_basketProjVec.x + 1) * 0.5;
          const basketScreenNormY = (1 - _basketProjVec.y) * 0.5;

          // ===================================================================
          // 2. MEDIAPIPE HAND LANDMARKER + 3D HAND-OBJECT COLLISION & GRABBING
          // ===================================================================
          const gs = grabStateRef.current;
          const videoEl = videoRef.current;
          const handEngine = handEngineRef.current;

          let handTel: TrackedHandTelemetry | undefined;
          if (handEngine && videoEl) {
            handTel = handEngine.detectHandFrame(
              videoEl,
              nowMs,
              gs.hoveredAnimalId,
              gs.carriedAnimalId
            );
          }

          // Determine which unfound animal the user's 3D hand is reaching over (Collision Detection)
          let closestHoveredId: string | null = null;
          let closestScreenDist = 0.165;

          if (handTel && handTel.handDetected) {
            for (let i = 0; i < currentAnimals.length; i++) {
              const item = currentAnimals[i];
              if (item.found) continue;
              const node = builtMap.get(item.id);
              if (!node || !node.rig.root.visible) continue;

              _projVec.copy(node.rig.root.position);
              _projVec.y += 0.14;
              _projVec.project(camera);

              if (_projVec.z < 1.0) {
                const screenX = (_projVec.x + 1) * 0.5;
                const screenY = (1 - _projVec.y) * 0.5;
                const dScreen = Math.hypot(screenX - handTel.normX, screenY - handTel.normY);
                if (dScreen < closestScreenDist) {
                  closestScreenDist = dScreen;
                  closestHoveredId = item.id;
                }
              }
            }
          }
          gs.hoveredAnimalId = closestHoveredId;
          if (handTel) {
            handTel.hoveredAnimalId = closestHoveredId;
          }

          // Check if the player's hand/carried animal is positioned over the 3D Corner Basket!
          const activeHandX = gs.pointerCarriedAnimalId
            ? gs.pointerNormX
            : handTel?.normX ?? 0.5;
          const activeHandY = gs.pointerCarriedAnimalId
            ? gs.pointerNormY
            : handTel?.normY ?? 0.5;
          const handToBasketScreenDist = Math.hypot(
            activeHandX - basketScreenNormX,
            activeHandY - basketScreenNormY
          );
          const carriedNode = gs.carriedAnimalId ? builtMap.get(gs.carriedAnimalId) : undefined;
          const carriedWorldDistToBasket = carriedNode
            ? carriedNode.rig.root.position.distanceTo(rescueBasket.position)
            : 999;

          const isReadyToDropInBasket =
            Boolean(gs.carriedAnimalId) &&
            ((basketInFront &&
              basketDistanceMeters < 2.25 &&
              handToBasketScreenDist < 0.28) ||
              carriedWorldDistToBasket < 1.05 ||
              (basketAngleDeg < 26 && basketDistanceMeters < 1.45));

          if (handTel) {
            handTel.isOverBasketZone = isReadyToDropInBasket;
          }

          // Handle Real-Hand Pinch/Grab Start & Open-Hand Release into Corner Basket
          if (handTel && handTel.handDetected && !gs.pointerCarriedAnimalId) {
            if (handTel.isGrabbing && !gs.carriedAnimalId && closestHoveredId) {
              // User closed their fingers / pinched over an animal -> GRAB IT!
              gs.carriedAnimalId = closestHoveredId;
              handTel.carriedAnimalId = closestHoveredId;
              const grabbedNode = builtMap.get(closestHoveredId);
              if (grabbedNode) {
                gs.prevCarryPos.copy(grabbedNode.rig.root.position);
                gs.carryVelocity.set(0, 0, 0);
              }
              spatialAudio.playScanSweep();
            } else if (!handTel.isGrabbing && gs.carriedAnimalId) {
              // User opened their hand while carrying an animal -> RELEASE IT!
              const releasedId = gs.carriedAnimalId;
              const releasedNode = builtMap.get(releasedId);
              gs.carriedAnimalId = null;
              handTel.carriedAnimalId = null;

              if (isReadyToDropInBasket) {
                // Released over the 3D Corner Rescue Basket -> Animal Rescued!
                onAnimalFoundRef.current(releasedId);
              } else if (releasedNode) {
                // Released away from the corner basket -> Animal drops with real gravity onto furniture/floor!
                releasedNode.rig.physics.velocity.copy(gs.carryVelocity);
                releasedNode.rig.physics.isGrounded = false;
                releasedNode.homePos.set(
                  releasedNode.rig.root.position.x,
                  releasedNode.localSurfaceY,
                  releasedNode.rig.root.position.z
                );
                releasedNode.peekPos.copy(releasedNode.homePos);
                releasedNode.targetWaypoint.copy(releasedNode.homePos);
              }
            }
          }

          // Render 21-Joint Hand Skeleton, Pinch Reticle, and 3D Corner Basket Label/Tether on 2D Overlay
          const overlay = overlayCanvasRef.current;
          if (overlay) {
            const rect = overlay.getBoundingClientRect();
            if (overlay.width !== rect.width || overlay.height !== rect.height) {
              overlay.width = rect.width;
              overlay.height = rect.height;
            }
            const ctx = overlay.getContext('2d');
            if (ctx) {
              ctx.clearRect(0, 0, overlay.width, overlay.height);
              if (handEngine && handTel) {
                const carriedName = currentAnimals.find(
                  (a) => a.id === gs.carriedAnimalId
                )?.instanceLabel;
                const hoveredName = currentAnimals.find(
                  (a) => a.id === gs.hoveredAnimalId
                )?.instanceLabel;
                handEngine.drawHandSkeletonOverlay(
                  ctx,
                  overlay.width,
                  overlay.height,
                  handTel,
                  carriedName,
                  hoveredName,
                  {
                    normX: basketScreenNormX,
                    normY: basketScreenNormY,
                    inFront: basketInFront,
                    distMeters: basketDistanceMeters,
                    angleDeltaDeg: basketAngleDeg,
                    turnDir: basketTurnDirection,
                    isReadyToDrop: isReadyToDropInBasket,
                  }
                );
              }
            }
          }

          let bestTelemetryCandidate: {
            item: HiddenAnimalInstance;
            node: BuiltAnimalNode;
            distMeters: number;
            angleDeltaDeg: number;
            turnDirection: SeekTelemetry['turnDirection'];
            surfaceLabel: string;
            affordanceDesc: string;
          } | null = null;

          for (let i = 0; i < currentAnimals.length; i++) {
            const item = currentAnimals[i];
            const node = builtMap.get(item.id);
            if (!node) continue;

            // Only hide animals that have ALREADY been caught! All unfound animals are visible simultaneously!
            if (item.found) {
              node.visibilityAlpha = THREE.MathUtils.damp(node.visibilityAlpha, 0, 8, delta);
              node.rig.root.visible = node.visibilityAlpha > 0.03;
              node.rig.root.scale.setScalar(Math.max(0.01, node.visibilityAlpha));
              continue;
            }

            const isBeingCarried = gs.carriedAnimalId === item.id;

            // =================================================================
            // 3A. IF THIS ANIMAL IS GRABBED BY USER'S HAND -> ATTACH TO 3D HAND
            // =================================================================
            if (isBeingCarried) {
              const carryNormX = gs.pointerCarriedAnimalId
                ? gs.pointerNormX
                : handTel?.normX ?? 0.5;
              const carryNormY = gs.pointerCarriedAnimalId
                ? gs.pointerNormY
                : handTel?.normY ?? 0.5;
              const carryDepth = gs.pointerCarriedAnimalId
                ? 1.08
                : THREE.MathUtils.clamp(handTel?.estimatedDepthMeters ?? 1.08, 0.72, 1.38);

              const ndcX = carryNormX * 2 - 1;
              const ndcY = -(carryNormY * 2 - 1);

              // Unproject 2D tracked hand + monocular depth to 3D world position
              const halfFovRad = THREE.MathUtils.degToRad(camera.fov * 0.5);
              const tanHalfFov = Math.tan(halfFovRad);
              const localX = ndcX * carryDepth * tanHalfFov * camera.aspect;
              const localY = ndcY * carryDepth * tanHalfFov;

              _handWorldPos
                .copy(camera.position)
                .addScaledVector(_camForward, carryDepth)
                .addScaledVector(_camRight, localX)
                .addScaledVector(_camUp, localY - 0.08);

              gs.prevCarryPos.copy(node.rig.root.position);
              node.rig.root.position.lerp(_handWorldPos, Math.min(1, delta * 16));

              // Track 3D hand carry velocity so releasing imparts realistic momentum
              if (delta > 0.001) {
                gs.carryVelocity
                  .copy(node.rig.root.position)
                  .sub(gs.prevCarryPos)
                  .divideScalar(delta)
                  .clampLength(0, 3.2);
              }

              node.rig.physics.velocity.set(0.35, 0, 0.35);
              node.rig.physics.isGrounded = false;
              node.rig.physics.crouchFactor = 0;
              node.rig.physics.affordanceDescription =
                'Held in your hand · Walk to Corner Basket & Open Hand!';
              node.rig.occluderPlane.visible = false;
              node.behavior = 'RUNNING';
              node.visibilityAlpha = 1.0;
              node.rig.root.visible = true;
              node.rig.root.scale.setScalar(1.08);

              const queryCarriedSurface = (wx: number, wz: number) =>
                slamEngine.querySurfacePhysicsAt(
                  wx,
                  wz,
                  node.rig.root.position.y,
                  node.preferTopSurface
                );

              updatePhysicsBasedAnimalLocomotion(
                node.rig,
                item.species.id,
                elapsed * 1.4,
                delta,
                1.0,
                camera.position,
                queryCarriedSurface
              );

              bestTelemetryCandidate = {
                item,
                node,
                distMeters: carryDepth,
                angleDeltaDeg: 0,
                turnDirection: 'ahead',
                surfaceLabel: 'Held in Tracked 3D Hand',
                affordanceDesc: 'Walk to Corner Basket & Open Hand to Release',
              };
              continue;
            }

            // =================================================================
            // 3B. STANDARD ENVIRONMENT-AWARE PHYSICS & SURFACE CONTOUR FOLLOWING
            // =================================================================
            _toAnimal.copy(node.rig.root.position).sub(camera.position);
            const distMeters = _toAnimal.length();
            _toAnimal.normalize();

            const dot = THREE.MathUtils.clamp(_camForward.dot(_toAnimal), -1, 1);
            const angleDeltaDeg = THREE.MathUtils.radToDeg(Math.acos(dot));

            const isAimedAtCrevice = angleDeltaDeg < 34 || distMeters < 1.95;
            const phys = node.rig.physics;
            phys.jumpCooldown = Math.max(0, phys.jumpCooldown - delta);

            let desiredMaxSpeed = 0;

            if (!isAimedAtCrevice) {
              node.behavior = 'PEEKING';
              node.lockDwellSeconds = Math.max(0, node.lockDwellSeconds - delta * 1.5);
              node.peekProgress = THREE.MathUtils.damp(node.peekProgress, 0.78, 5, delta);
              node.targetWaypoint.copy(node.homePos);
              desiredMaxSpeed = 0.42;
            } else {
              node.lockDwellSeconds += delta;

              if (node.lockDwellSeconds < 1.1 && distMeters >= 1.85) {
                node.behavior = 'PEEKING';
                node.peekProgress = THREE.MathUtils.damp(node.peekProgress, 0.92, 4, delta);
                node.targetWaypoint.copy(node.peekPos);
                desiredMaxSpeed = 0.42;
              } else {
                node.peekProgress = THREE.MathUtils.damp(node.peekProgress, 1.0, 3.5, delta);
                node.runTimer += delta;
                if (node.runTimer > 2.4) {
                  node.runTimer = 0;
                  const nextAff = slamEngine.selectNextAffordanceWaypoint(
                    item.species.id,
                    node.rig.root.position,
                    node.homePos
                  );
                  node.targetWaypoint.copy(nextAff.targetPos);
                  node.preferTopSurface = nextAff.preferTopSurface;
                  phys.activeAffordance = nextAff.affordanceType;
                  phys.affordanceDescription = nextAff.description;
                }
                desiredMaxSpeed = item.species.id === 'chameleon' ? 0.42 : 0.78;
              }
            }

            // Evaluates the exact 3D curved contour height & surface normal of the scanned object
            const queryPhysicalSurface = (wx: number, wz: number) =>
              slamEngine.querySurfacePhysicsAt(
                wx,
                wz,
                node.rig.root.position.y,
                node.preferTopSurface
              );

            const surf = queryPhysicalSurface(
              node.rig.root.position.x,
              node.rig.root.position.z
            );
            phys.currentSurfaceLabel = surf.surfaceLabel;

            _desiredDir.copy(node.targetWaypoint).sub(node.rig.root.position);
            _desiredDir.y = 0;
            const horizDistToTarget = _desiredDir.length();

            if (horizDistToTarget > 0.06 && desiredMaxSpeed > 0) {
              _desiredDir.normalize();
              const arrivalFactor = Math.min(1.0, horizDistToTarget / 0.3);
              const targetSpeed = desiredMaxSpeed * arrivalFactor;

              const targetVx = _desiredDir.x * targetSpeed;
              const targetVz = _desiredDir.z * targetSpeed;

              const traction = phys.isGrounded ? surf.surfaceFriction : 1.8;
              phys.velocity.x = THREE.MathUtils.damp(
                phys.velocity.x,
                targetVx,
                traction,
                delta
              );
              phys.velocity.z = THREE.MathUtils.damp(
                phys.velocity.z,
                targetVz,
                traction,
                delta
              );

              if (node.lockDwellSeconds >= 1.35 || distMeters < 1.85) {
                node.behavior = 'RUNNING';
              }
              phys.targetHeadingRad = Math.atan2(phys.velocity.x, phys.velocity.z);
            } else {
              const brakeFriction = phys.isGrounded ? surf.surfaceFriction * 1.2 : 1.0;
              phys.velocity.x = THREE.MathUtils.damp(
                phys.velocity.x,
                0,
                brakeFriction,
                delta
              );
              phys.velocity.z = THREE.MathUtils.damp(
                phys.velocity.z,
                0,
                brakeFriction,
                delta
              );

              if (node.behavior === 'RUNNING') {
                node.behavior = 'PEEKING';
              }
              phys.targetHeadingRad = Math.atan2(
                camera.position.x - node.rig.root.position.x,
                camera.position.z - node.rig.root.position.z
              );
            }

            node.rig.root.position.x += phys.velocity.x * delta;
            node.rig.root.position.z += phys.velocity.z * delta;

            slamEngine.resolveCharacterCollision(
              node.rig.root.position,
              phys.velocity,
              0.12,
              false
            );

            const postSurf = queryPhysicalSurface(
              node.rig.root.position.x,
              node.rig.root.position.z
            );

            // If animal was dropped from hand above the floor, apply gravity until it lands on FLOOR_Y;
            // once grounded, keep it strictly planted on FLOOR_Y so it never floats!
            if (!phys.isGrounded && node.rig.root.position.y > FLOOR_Y + 0.005) {
              const prevVy = phys.velocity.y;
              phys.velocity.y -= 9.81 * delta;
              node.rig.root.position.y += phys.velocity.y * delta;
              if (node.rig.root.position.y <= FLOOR_Y) {
                node.rig.root.position.y = FLOOR_Y;
                if (prevVy < -0.6) {
                  phys.landingSpringVel = Math.min(1.2, Math.abs(prevVy) * 0.25);
                }
                phys.velocity.y = 0;
                phys.isGrounded = true;
              }
            } else {
              node.rig.root.position.y = FLOOR_Y;
              phys.velocity.y = 0;
              phys.isGrounded = true;
            }

            const targetCrouch = postSurf.isUnderFurniture ? 1.0 : 0.0;
            phys.crouchFactor = THREE.MathUtils.damp(
              phys.crouchFactor,
              targetCrouch,
              7,
              delta
            );

            const isHandHovered = gs.hoveredAnimalId === item.id;
            const targetAlpha = node.behavior === 'HIDDEN' ? 0.88 : 1.0;
            node.visibilityAlpha = THREE.MathUtils.damp(
              node.visibilityAlpha,
              targetAlpha,
              6,
              delta
            );
            node.rig.root.visible = true;
            node.rig.root.scale.setScalar(isHandHovered ? 1.06 : 1.0);

            updatePhysicsBasedAnimalLocomotion(
              node.rig,
              item.species.id,
              elapsed,
              delta,
              node.peekProgress,
              camera.position,
              queryPhysicalSurface
            );

            const crossY = _camForward.x * _toAnimal.z - _camForward.z * _toAnimal.x;
            const turnDirection: SeekTelemetry['turnDirection'] =
              angleDeltaDeg < 18 ? 'ahead' : crossY < 0 ? 'left' : 'right';

            if (
              !bestTelemetryCandidate ||
              angleDeltaDeg < bestTelemetryCandidate.angleDeltaDeg ||
              (item.id === currentTargetId && angleDeltaDeg < 45)
            ) {
              bestTelemetryCandidate = {
                item,
                node,
                distMeters,
                angleDeltaDeg,
                turnDirection,
                surfaceLabel: postSurf.surfaceLabel,
                affordanceDesc: phys.affordanceDescription,
              };
            }
          }

          if (bestTelemetryCandidate) {
            spatialAudio.tickProximitySonar(bestTelemetryCandidate.angleDeltaDeg, nowMs);

            if (nowMs - lastTelemetryMs > 90) {
              lastTelemetryMs = nowMs;
              onTelemetryUpdateRef.current({
                currentHeadingDeg: st.currentHeadingDeg,
                walkedDistanceMeters: Math.hypot(st.posX, st.posZ),
                targetName: bestTelemetryCandidate.item.instanceLabel,
                targetParentObject: bestTelemetryCandidate.item.detectedParentObject,
                targetAnchor: bestTelemetryCandidate.item.realObjectAnchor,
                targetClue: bestTelemetryCandidate.item.riddleClue,
                distanceToTargetMeters: bestTelemetryCandidate.distMeters,
                angleToTargetDeg: bestTelemetryCandidate.angleDeltaDeg,
                turnDirection: bestTelemetryCandidate.turnDirection,
                behaviorState: bestTelemetryCandidate.node.behavior,
                activeSurfaceLabel: bestTelemetryCandidate.surfaceLabel,
                activeAffordanceLabel: bestTelemetryCandidate.affordanceDesc,
                roomLightSummary: st.roomLightLabel,
                handTelemetry: handTel,
                handModelReady: Boolean(handEngine?.isLoaded()) || handReady,
                carriedAnimalId: gs.carriedAnimalId,
                basketDistanceMeters,
                basketAngleDeg,
                basketTurnDirection,
                isReadyToDropInBasket,
              });
            }
          }
        }

        renderer.render(scene, camera);

        if (isSoftwareGl) {
          afterDraw(tick);
        } else {
          frameId = requestAnimationFrame(tick);
        }
      }

      tick();

      return () => {
        cancelAnimationFrame(frameId);
        clearTimeout(frameId);
        domEl.removeEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.removeEventListener('resize', onResize);
        renderer.dispose();
      };
    }, []);

    return (
      <div className="relative w-full h-full overflow-hidden bg-stone-950">
        {/* Live Back Camera Video */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={`absolute inset-0 w-full h-full object-cover ${
            cameraStream ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        />

        {!cameraStream && <div className="absolute inset-0 bg-stone-950" />}

        {/* 3D WebGL Scene: Continuous ARKit Mesh, 3D Rescue Basket, Depth Occluders & IK Animals */}
        <div ref={canvasMountRef} className="absolute inset-0 w-full h-full" />

        {/* 2D AR Overlay: Object Scan Outlines (Scan Phase) & 21-Joint MediaPipe Hand Skeleton (Seek Phase) */}
        <canvas
          ref={overlayCanvasRef}
          className={`absolute inset-0 w-full h-full pointer-events-none transition-opacity ${
            phase === 'scan' || phase === 'seek' ? 'opacity-100' : 'opacity-0'
          }`}
        />
      </div>
    );
  }
);
