import React, { useState, useRef, useCallback, useEffect } from 'react';
import QRCode from 'qrcode';
import {
  Camera,
  QrCode,
  Scan,
  Footprints,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  X,
  Hand,
  Users,
  Timer,
  MapPin,
  Trophy,
  RotateCcw,
  Crown,
} from 'lucide-react';
import {
  ArViewport,
  ArViewportHandle,
  ScanProgressTelemetry,
  SeekTelemetry,
} from './components/ArViewport';
import {
  SCAN_READY_THRESHOLD_PERCENT,
  TOTAL_ANIMALS_COUNT,
  WIN_RESCUE_TARGET,
  buildDefault15AnimalInstances,
} from './data/speciesCatalog';
import {
  CornerBasketPlacement,
  CoverType,
  HiddenAnimalInstance,
  MultiplayerRoomState,
  OcclusionEdge,
  SharedAnimalPlacementDTO,
  SurfacePhysicsMode,
} from './types/safari';
import { CoverageTier, FLOOR_Y } from './three/spatialSlamEngine';
import { spatialAudio } from './audio/spatialAudio';

const DEV_URL = 'https://ais-dev-wdilitgsal34bqe3lcmckc-29557996632.europe-west2.run.app';
const SHARED_URL = 'https://ais-pre-wdilitgsal34bqe3lcmckc-29557996632.europe-west2.run.app';
const SHARED_SESSION_CODE = 'MAIN';

const DEFAULT_CORNER_BASKET: CornerBasketPlacement = {
  yawDeg: 42,
  distanceMeters: 1.65,
  worldPos: [
    Number((Math.sin((42 * Math.PI) / 180) * 1.65).toFixed(2)),
    FLOOR_Y,
    Number((-Math.cos((42 * Math.PI) / 180) * 1.65).toFixed(2)),
  ],
  cornerLabel: 'Right Corner (42° · 1.6m)',
};

const INITIAL_15_ANIMALS: HiddenAnimalInstance[] = buildDefault15AnimalInstances();

function formatTimerMMSS(totalSeconds: number): string {
  const clamped = Math.max(0, Math.ceil(totalSeconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export default function App() {
  const viewportRef = useRef<ArViewportHandle | null>(null);

  // Unique Player Identity for Real-Time Multiplayer Room Sync (Name-only entry, no signup)
  const [playerId] = useState<string>(() => {
    const saved = typeof window !== 'undefined' ? sessionStorage.getItem('wildseek_pid') : null;
    if (saved) return saved;
    const generated = `p_${Math.random().toString(36).slice(2, 8)}`;
    if (typeof window !== 'undefined') sessionStorage.setItem('wildseek_pid', generated);
    return generated;
  });

  const [playerName, setPlayerName] = useState<string>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('wildseek_pname') : null;
    return saved || '';
  });

  const [roomState, setRoomState] = useState<MultiplayerRoomState | null>(null);

  const [phase, setPhase] = useState<'launch' | 'scan' | 'seek'>('launch');
  const [animals, setAnimals] = useState<HiddenAnimalInstance[]>(INITIAL_15_ANIMALS);
  const [activeTargetId, setActiveTargetId] = useState<string>('animal_1');
  const [cornerBasket, setCornerBasket] = useState<CornerBasketPlacement>(DEFAULT_CORNER_BASKET);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);

  // 3-Second Pre-Start Countdown & 2-Minute (120s) Round Timer State
  const [countdownSecondsLeft, setCountdownSecondsLeft] = useState<number | null>(null);
  const [roundSecondsLeft, setRoundSecondsLeft] = useState<number>(120);
  const [roundFinishedReason, setRoundFinishedReason] = useState<
    'winner_5' | 'all_found' | 'time_up' | null
  >(null);
  const roundEndsAtMsRef = useRef<number | null>(null);
  const countdownEndsAtMsRef = useRef<number | null>(null);
  const lastProcessedToastIdRef = useRef<string>('');
  const autoTriggeredAt90Ref = useRef<boolean>(false);

  const [scanProgress, setScanProgress] = useState<ScanProgressTelemetry>({
    progressPercent: 0,
    accuratePercent: 0,
    partialPercent: 0,
    missedPercent: 100,
    sectorStates: new Array(18).fill('missed') as CoverageTier[],
    currentHeadingDeg: 0,
    nbv: {
      yawDeg: 45,
      pitchDeg: -16,
      deltaYawDeg: 45,
      deltaPitchDeg: -4,
      directionLabel: 'Pan Right 45° to reach 90% Green',
      reason: 'Fast Optical-Flow Scan (Auto-starts at 90%)',
      worldPos: [1.5, -1.0, -1.5],
      tier: 'missed',
    },
    detectedObjects: [],
    scannedObjects: [],
    uniqueLabels: [],
    capturedFramesCount: 0,
    crevicesCount: 0,
    lockedCellsCount: 0,
    lidarPointsCount: 0,
    furnitureVolumesCount: 0,
    modelLoaded: false,
  });

  const [showQrModal, setShowQrModal] = useState<boolean>(false);
  const [linkMode, setLinkMode] = useState<'dev' | 'shared'>('dev');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);

  const [telemetry, setTelemetry] = useState<SeekTelemetry | null>(null);
  const [spottedToast, setSpottedToast] = useState<string | null>(null);

  const effectivePlayerName = playerName.trim() || 'Explorer';

  const activePhoneUrl =
    linkMode === 'dev'
      ? typeof window !== 'undefined' && window.location.origin.includes('run.app')
        ? window.location.origin
        : DEV_URL
      : SHARED_URL;

  useEffect(() => {
    QRCode.toDataURL(activePhoneUrl, {
      width: 240,
      margin: 2,
      color: {
        dark: '#0c0a09',
        light: '#ffffff',
      },
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => {});
  }, [activePhoneUrl]);

  // Apply authoritative Multiplayer Room State from Server (SSE + HTTP Sync)
  const applyIncomingServerRoomState = useCallback(
    (incoming: MultiplayerRoomState & { serverNowMs?: number }) => {
      setRoomState(incoming);

      if (incoming.cornerBasket && Array.isArray(incoming.cornerBasket.worldPos)) {
        setCornerBasket(incoming.cornerBasket);
      }

      if (
        incoming.lastEventToast &&
        incoming.lastEventToast.id !== lastProcessedToastIdRef.current
      ) {
        lastProcessedToastIdRef.current = incoming.lastEventToast.id;
        setSpottedToast(incoming.lastEventToast.message);
      }

      // Sync shared 15 animal placements & rescued status across all players in the room
      if (Array.isArray(incoming.placements) && incoming.placements.length > 0) {
        setAnimals((prev) =>
          prev.map((item, idx) => {
            const shared =
              incoming.placements.find((p) => p.id === item.id) ||
              incoming.placements[idx];
            if (!shared) return item;
            return {
              ...item,
              id: shared.id || item.id,
              instanceLabel: shared.instanceLabel || item.instanceLabel,
              yawDeg: shared.yawDeg,
              pitchDeg: shared.pitchDeg,
              distanceMeters: shared.distanceMeters,
              coverType: shared.coverType,
              detectedParentObject: shared.detectedParentObject,
              realObjectAnchor: shared.realObjectAnchor,
              riddleClue: shared.riddleClue,
              occlusionEdge: shared.occlusionEdge,
              surfaceMode: shared.surfaceMode,
              furnitureDims: shared.furnitureDims,
              box2d: shared.box2d,
              occluderBox2d: shared.occluderBox2d,
              sourceFrameHeadingDeg: shared.sourceFrameHeadingDeg,
              sourceFramePitchDeg: shared.sourceFramePitchDeg,
              found: shared.found,
              rescuedBy: shared.rescuedBy,
            };
          })
        );
      }

      const clockOffset = incoming.serverNowMs ? Date.now() - incoming.serverNowMs : 0;
      if (incoming.roundStartedAtMs) {
        countdownEndsAtMsRef.current = incoming.roundStartedAtMs + clockOffset;
      }
      if (incoming.roundEndsAtMs) {
        roundEndsAtMsRef.current = incoming.roundEndsAtMs + clockOffset;
      }

      // If any player reached 5 rescued animals (or server marked finished), finish immediately!
      if (incoming.status === 'finished') {
        if (incoming.winnerPlayerName) {
          setRoundFinishedReason('winner_5');
        } else {
          setRoundFinishedReason((prev) => prev || 'time_up');
        }
      } else if (incoming.status === 'countdown' || incoming.status === 'seeking') {
        setRoundFinishedReason(null);
      }

      // Host-Only Scan: If the Host started the round while we were waiting/scanning, jump straight into Seek!
      setPhase((currentPhase) => {
        if (
          currentPhase === 'scan' &&
          (incoming.status === 'countdown' || incoming.status === 'seeking')
        ) {
          setRoundFinishedReason(null);
          return 'seek';
        }
        if (currentPhase === 'seek' && incoming.status === 'scanning') {
          autoTriggeredAt90Ref.current = false;
          setRoundFinishedReason(null);
          return 'scan';
        }
        return currentPhase;
      });
    },
    []
  );

  // Real-Time Server-Sent Events (SSE) + HTTP Sync for Multi-User Room Collaboration
  useEffect(() => {
    if (phase === 'launch') return;

    let es: EventSource | null = null;
    try {
      const streamUrl = `/api/room/stream?roomCode=${encodeURIComponent(
        SHARED_SESSION_CODE
      )}&playerId=${encodeURIComponent(playerId)}&playerName=${encodeURIComponent(
        effectivePlayerName
      )}`;
      es = new EventSource(streamUrl);
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data?.type === 'room:state' && data.state) {
            applyIncomingServerRoomState(data.state);
          }
        } catch {
          // ignore
        }
      };
    } catch {
      // Fallback to HTTP sync below
    }

    const syncInterval = window.setInterval(() => {
      fetch('/api/room/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: SHARED_SESSION_CODE,
          playerId,
          playerName: effectivePlayerName,
          scanCoveragePercent: scanProgress.accuratePercent,
          carryingAnimalId: telemetry?.carriedAnimalId || null,
          scannedObjects: scanProgress.uniqueLabels,
        }),
      })
        .then((r) => r.json())
        .then((state) => {
          if (state && state.roomCode) {
            applyIncomingServerRoomState(state);
          }
        })
        .catch(() => {});
    }, 900);

    return () => {
      clearInterval(syncInterval);
      es?.close();
    };
  }, [
    phase,
    playerId,
    effectivePlayerName,
    scanProgress.accuratePercent,
    scanProgress.uniqueLabels,
    telemetry?.carriedAnimalId,
    applyIncomingServerRoomState,
  ]);

  // 3-Second Pre-Start Countdown ("3... 2... 1... GO!") + 2-Minute (120s) Round Timer Tick
  useEffect(() => {
    if (phase !== 'seek') {
      setCountdownSecondsLeft(null);
      return;
    }

    const timer = window.setInterval(() => {
      const now = Date.now();
      const cdEnd = countdownEndsAtMsRef.current;

      if (cdEnd && now < cdEnd) {
        const remCd = Math.ceil((cdEnd - now) / 1000);
        setCountdownSecondsLeft((prev) => {
          if (prev !== remCd) {
            spatialAudio.playScanSweep();
          }
          return remCd;
        });
        setRoundSecondsLeft(120);
        return;
      }

      setCountdownSecondsLeft((prev) => {
        if (prev !== null) {
          spatialAudio.playDiscoveryFanfare();
        }
        return null;
      });

      const rEnd = roundEndsAtMsRef.current;
      if (rEnd) {
        const remSec = Math.max(0, Math.ceil((rEnd - now) / 1000));
        setRoundSecondsLeft(remSec);
        if (remSec <= 0) {
          setRoundFinishedReason((prev) => prev || 'time_up');
        }
      }
    }, 150);

    return () => clearInterval(timer);
  }, [phase]);

  // Check if all 15 animals have been rescued into the Corner Basket
  useEffect(() => {
    if (phase === 'seek' && animals.length > 0 && animals.every((a) => a.found)) {
      setRoundFinishedReason((prev) => prev || 'all_found');
    }
  }, [phase, animals]);

  const handleOpenBackCamera = async () => {
    spatialAudio.unlock();
    const cleanName = playerName.trim() || `Player-${Math.floor(10 + Math.random() * 89)}`;
    if (!playerName.trim()) {
      setPlayerName(cleanName);
    }
    if (typeof window !== 'undefined') {
      localStorage.setItem('wildseek_pname', cleanName);
    }

    try {
      const DevOrient = DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<'granted' | 'denied'>;
      };
      if (typeof DevOrient?.requestPermission === 'function') {
        await DevOrient.requestPermission();
      }
      const DevMotion = DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<'granted' | 'denied'>;
      };
      if (typeof DevMotion?.requestPermission === 'function') {
        await DevMotion.requestPermission();
      }
    } catch {
      // Non-iOS browsers
    }

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        setCameraStream(stream);
      } catch {
        // Fallback if testing on desktop without rear camera
      }
    }

    viewportRef.current?.resetScanProgress();
    autoTriggeredAt90Ref.current = false;
    setRoundFinishedReason(null);

    // Check current room state first: if Host already scanned the room, jump straight into Seek!
    try {
      const res = await fetch('/api/room/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: SHARED_SESSION_CODE,
          playerId,
          playerName: cleanName,
          scanCoveragePercent: 0,
        }),
      });
      if (res.ok) {
        const state = await res.json();
        applyIncomingServerRoomState(state);
        if (state.status === 'countdown' || state.status === 'seeking') {
          setPhase('seek');
          return;
        }
      }
    } catch {
      // ignore
    }

    setPhase('scan');
  };

  // Allow any player to claim Host role if they want to scan from their phone
  const handleClaimHostScanner = async () => {
    spatialAudio.playScanSweep();
    autoTriggeredAt90Ref.current = false;
    try {
      const res = await fetch('/api/room/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: SHARED_SESSION_CODE,
          playerId,
          playerName: effectivePlayerName,
          claimHost: true,
        }),
      });
      if (res.ok) {
        const state = await res.json();
        applyIncomingServerRoomState(state);
      }
    } catch {
      // ignore
    }
  };

  // Place the 3D Sanctuary Rescue Basket on the floor in the corner the player is pointing at
  const handlePlaceBasketInCurrentCorner = async () => {
    const placed = viewportRef.current?.placeCornerBasketAtCurrentView();
    if (!placed) return;
    spatialAudio.playScanSweep();
    setCornerBasket(placed);
    setSpottedToast(`Rescue Basket placed in ${placed.cornerLabel}!`);

    try {
      const res = await fetch('/api/room/place-basket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: SHARED_SESSION_CODE,
          playerName: effectivePlayerName,
          ...placed,
        }),
      });
      if (res.ok) {
        const state = await res.json();
        applyIncomingServerRoomState(state);
      }
    } catch {
      // ignore
    }
  };

  // Place 15 animals with careful object verification & start the 3s countdown + 2-minute round for everyone!
  const handleCompleteScanAndHide = useCallback(async () => {
    if (isScanning) return;
    spatialAudio.playScanSweep();
    setIsScanning(true);

    const scanBundle = viewportRef.current?.getCapturedScanData();
    const currentHeading = scanBundle?.currentHeadingDeg ?? 0;
    const currentPitch = scanBundle?.currentPitchDeg ?? -12;
    const verifiedLabels = scanBundle?.cocoDetectedLabels ?? [];

    const carefulAnchors = [
      'Floor Corner Shadow',
      'Room Baseboard Edge',
      'Low Furniture Shadow',
      'Wall-Floor Crevice',
      'Side Perimeter Ledge',
      'Open Floor Alcove',
    ];

    // Fast baseline distribution of all 15 animals around the 360° room floor (every 24°)
    let computedAnimals: HiddenAnimalInstance[] = animals.map((item, idx) => {
      const verifiedObj =
        verifiedLabels.length > 0 && idx % 2 === 0
          ? verifiedLabels[idx % verifiedLabels.length]
          : carefulAnchors[idx % carefulAnchors.length];
      const placedYaw = ((currentHeading + idx * 24 - 168) % 360 + 360) % 360;
      const placedDist = Number((1.48 + (idx % 4) * 0.16).toFixed(2));
      return {
        ...item,
        yawDeg: placedYaw,
        pitchDeg: -18,
        distanceMeters: placedDist,
        surfaceMode: 'floor',
        detectedParentObject: verifiedObj,
        realObjectAnchor: `${item.species.defaultAnchor} (${verifiedObj})`,
        sourceFrameBase64: scanBundle?.frames[0]?.base64,
        sourceFrameHeadingDeg: scanBundle?.frames[0]?.headingDeg ?? currentHeading,
        sourceFramePitchDeg: scanBundle?.frames[0]?.pitchDeg ?? currentPitch,
        found: false,
        rescuedBy: undefined,
      };
    });

    try {
      if (scanBundle && scanBundle.frames.length > 0) {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 3600);

        const response = await fetch('/api/scan-room', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            frames: scanBundle.frames,
            cocoDetectedLabels: scanBundle.cocoDetectedLabels,
            mimeType: 'image/jpeg',
            currentHeadingDeg: currentHeading,
          }),
        });
        clearTimeout(timeoutId);

        const data = await response.json();
        if (response.ok && Array.isArray(data.placements) && data.placements.length > 0) {
          const validEdges: OcclusionEdge[] = ['top', 'bottom', 'left', 'right', 'none'];
          const validCovers: CoverType[] = ['fern', 'log', 'pot', 'ledge', 'boulder', 'basket'];
          const validSurfaceModes: SurfacePhysicsMode[] = [
            'under_furniture',
            'behind_furniture',
            'on_furniture',
            'floor',
          ];

          computedAnimals = animals.map((item, idx) => {
            const match = data.placements[idx % data.placements.length];

            const frameIndex = Math.max(
              0,
              Math.min(
                scanBundle.frames.length - 1,
                Number(match?.frameIndex) || idx % scanBundle.frames.length
              )
            );
            const matchedFrame = scanBundle.frames[frameIndex] || scanBundle.frames[0];
            const frameHeading = matchedFrame?.headingDeg ?? currentHeading;
            const framePitch = matchedFrame?.pitchDeg ?? currentPitch;

            const rawOffset =
              match?.yawOffsetDeg !== undefined
                ? Number(match.yawOffsetDeg) + idx * 14
                : idx * 24 - 168;
            const placedYaw = ((frameHeading + rawOffset) % 360 + 360) % 360;
            const placedPitch = -18;
            const placedDist = Math.max(
              1.42,
              Math.min(2.05, Number(match?.distanceMeters) || 1.48 + (idx % 4) * 0.16)
            );

            const edgeCandidate = String(
              match?.occlusionEdge || 'bottom'
            ).toLowerCase() as OcclusionEdge;
            const occlusionEdge = validEdges.includes(edgeCandidate) ? edgeCandidate : 'bottom';

            const coverCandidate = String(match?.coverType || '').toLowerCase() as CoverType;
            const coverType = validCovers.includes(coverCandidate)
              ? coverCandidate
              : item.species.defaultCover;

            // Keep all animals strictly grounded on the room floor
            const surfaceMode: SurfacePhysicsMode = 'floor';

            const parentCandidate = String(match?.detectedParentObject || '').trim();
            const safeParentObject =
              parentCandidate.length > 0
                ? parentCandidate
                : carefulAnchors[idx % carefulAnchors.length];

            const furnitureDims: [number, number, number] | undefined =
              Array.isArray(match?.furnitureDims) && match.furnitureDims.length === 3
                ? [
                    Math.max(0.35, Math.min(2.0, Number(match.furnitureDims[0]) || 0.9)),
                    Math.max(0.2, Math.min(1.0, Number(match.furnitureDims[1]) || 0.45)),
                    Math.max(0.35, Math.min(2.0, Number(match.furnitureDims[2]) || 0.9)),
                  ]
                : undefined;

            return {
              ...item,
              yawDeg: placedYaw,
              pitchDeg: placedPitch,
              distanceMeters: placedDist,
              coverType,
              detectedParentObject: safeParentObject,
              realObjectAnchor:
                match?.realObjectAnchor || `${item.species.defaultAnchor} (${safeParentObject})`,
              riddleClue: match?.riddleClue || item.species.defaultRiddle,
              occlusionEdge,
              surfaceMode,
              furnitureDims,
              sourceFrameBase64: matchedFrame?.base64,
              sourceFrameHeadingDeg: frameHeading,
              sourceFramePitchDeg: framePitch,
              found: false,
              rescuedBy: undefined,
            };
          });
        }
      }
    } catch {
      // Fast fallback already populated in computedAnimals
    }

    setAnimals(computedAnimals);

    // Start the synchronized 3-second countdown + 2-minute round for all players in the room!
    const now = Date.now();
    countdownEndsAtMsRef.current = now + 3000;
    roundEndsAtMsRef.current = now + 3000 + 120 * 1000;
    setCountdownSecondsLeft(3);
    setRoundSecondsLeft(120);
    setRoundFinishedReason(null);

    const sharedPlacements: SharedAnimalPlacementDTO[] = computedAnimals.map((a) => ({
      id: a.id,
      instanceLabel: a.instanceLabel,
      speciesId: a.species.id,
      yawDeg: a.yawDeg,
      pitchDeg: a.pitchDeg,
      distanceMeters: a.distanceMeters,
      coverType: a.coverType,
      detectedParentObject: a.detectedParentObject,
      realObjectAnchor: a.realObjectAnchor,
      riddleClue: a.riddleClue,
      occlusionEdge: a.occlusionEdge,
      surfaceMode: a.surfaceMode,
      furnitureDims: a.furnitureDims,
      box2d: a.box2d,
      occluderBox2d: a.occluderBox2d,
      sourceFrameHeadingDeg: a.sourceFrameHeadingDeg,
      sourceFramePitchDeg: a.sourceFramePitchDeg,
      found: false,
    }));

    try {
      const res = await fetch('/api/room/start-round', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: SHARED_SESSION_CODE,
          playerId,
          playerName: effectivePlayerName,
          placements: sharedPlacements,
          cornerBasket,
        }),
      });
      if (res.ok) {
        const state = await res.json();
        applyIncomingServerRoomState(state);
      }
    } catch {
      // ignore
    }

    viewportRef.current?.resetWalkPosition();
    setActiveTargetId('animal_1');
    setIsScanning(false);
    setPhase('seek');
  }, [
    animals,
    cornerBasket,
    effectivePlayerName,
    isScanning,
    playerId,
    applyIncomingServerRoomState,
  ]);

  const activePlayers = roomState?.players || [];
  const isCurrentPlayerHost =
    !roomState?.hostPlayerId || roomState.hostPlayerId === playerId;
  const hostDisplayName = roomState?.hostPlayerName || effectivePlayerName;

  const effectiveGreenPercent = isCurrentPlayerHost
    ? Math.max(scanProgress.accuratePercent, roomState?.combinedScanPercent || 0)
    : Math.max(roomState?.combinedScanPercent || 0, scanProgress.accuratePercent);
  const effectiveGreyPercent = Math.max(0, 100 - effectiveGreenPercent);

  // Auto-trigger animal placement for the Host as soon as scan reaches 90%!
  useEffect(() => {
    if (
      phase === 'scan' &&
      isCurrentPlayerHost &&
      effectiveGreenPercent >= SCAN_READY_THRESHOLD_PERCENT &&
      !autoTriggeredAt90Ref.current &&
      !isScanning
    ) {
      autoTriggeredAt90Ref.current = true;
      handleCompleteScanAndHide();
    }
  }, [phase, isCurrentPlayerHost, effectiveGreenPercent, isScanning, handleCompleteScanAndHide]);

  // Restart a fresh 2-Minute Round with 3-Second Countdown using the scanned room (15 animals, first to 5 wins)
  const handleRestartTwoMinRound = async () => {
    const resetList = animals.map((a, idx) => ({
      ...a,
      yawDeg: (a.yawDeg + 35 + idx * 11) % 360,
      found: false,
      rescuedBy: undefined,
    }));
    setAnimals(resetList);

    const now = Date.now();
    countdownEndsAtMsRef.current = now + 3000;
    roundEndsAtMsRef.current = now + 3000 + 120 * 1000;
    setCountdownSecondsLeft(3);
    setRoundSecondsLeft(120);
    setRoundFinishedReason(null);

    const sharedPlacements: SharedAnimalPlacementDTO[] = resetList.map((a) => ({
      id: a.id,
      instanceLabel: a.instanceLabel,
      speciesId: a.species.id,
      yawDeg: a.yawDeg,
      pitchDeg: a.pitchDeg,
      distanceMeters: a.distanceMeters,
      coverType: a.coverType,
      detectedParentObject: a.detectedParentObject,
      realObjectAnchor: a.realObjectAnchor,
      riddleClue: a.riddleClue,
      occlusionEdge: a.occlusionEdge,
      surfaceMode: a.surfaceMode,
      furnitureDims: a.furnitureDims,
      box2d: a.box2d,
      occluderBox2d: a.occluderBox2d,
      sourceFrameHeadingDeg: a.sourceFrameHeadingDeg,
      sourceFramePitchDeg: a.sourceFramePitchDeg,
      found: false,
    }));

    try {
      const res = await fetch('/api/room/start-round', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: SHARED_SESSION_CODE,
          playerId,
          playerName: effectivePlayerName,
          placements: sharedPlacements,
          cornerBasket,
        }),
      });
      if (res.ok) {
        const state = await res.json();
        applyIncomingServerRoomState(state);
      }
    } catch {
      // ignore
    }
  };

  const handleAnimalFound = useCallback(
    (animalId: string) => {
      if (
        (countdownEndsAtMsRef.current && Date.now() < countdownEndsAtMsRef.current) ||
        roundFinishedReason !== null
      ) {
        return;
      }

      setAnimals((prev) => {
        const target = prev.find((a) => a.id === animalId);
        if (!target || target.found) return prev;

        spatialAudio.playDiscoveryFanfare();
        setSpottedToast(`You dropped ${target.instanceLabel} into the Corner Basket!`);

        const updated = prev.map((item) =>
          item.id === animalId
            ? { ...item, found: true, rescuedBy: effectivePlayerName }
            : item
        );

        const myRescuedSoFar = updated.filter(
          (item) => item.found && item.rescuedBy === effectivePlayerName
        ).length;
        if (myRescuedSoFar >= WIN_RESCUE_TARGET) {
          setRoundFinishedReason('winner_5');
        }

        const nextUnfound = updated.find((item) => !item.found);
        if (nextUnfound) {
          setActiveTargetId(nextUnfound.id);
        }

        // Broadcast rescue to all players in the room!
        fetch('/api/room/rescue-animal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roomCode: SHARED_SESSION_CODE,
            playerId,
            playerName: effectivePlayerName,
            animalId,
            animalLabel: target.instanceLabel,
          }),
        })
          .then((r) => r.json())
          .then((state) => {
            if (state && state.roomCode) {
              applyIncomingServerRoomState(state);
            }
          })
          .catch(() => {});

        return updated;
      });
    },
    [playerId, effectivePlayerName, roundFinishedReason, applyIncomingServerRoomState]
  );

  useEffect(() => {
    if (!spottedToast) return;
    const timer = window.setTimeout(() => setSpottedToast(null), 2600);
    return () => clearTimeout(timer);
  }, [spottedToast]);

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(activePhoneUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const foundCount = animals.filter((a) => a.found).length;
  const myPlayerRecord = activePlayers.find((p) => p.id === playerId);
  const myRescuedCount =
    myPlayerRecord?.rescuedCount ??
    animals.filter((a) => a.found && a.rescuedBy === effectivePlayerName).length;

  const activeAnimal = animals.find((a) => a.id === activeTargetId) || animals[0];
  const carriedAnimal = animals.find((a) => a.id === telemetry?.carriedAnimalId);
  const winnerDisplayName =
    roomState?.winnerPlayerName ||
    (myRescuedCount >= WIN_RESCUE_TARGET ? effectivePlayerName : null) ||
    activePlayers.slice().sort((a, b) => b.rescuedCount - a.rescuedCount)[0]?.name ||
    effectivePlayerName;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-stone-950 text-stone-100 select-none">
      {/* Live Camera + Continuous 3D Room Mesh + World-Locked Corner Basket + 15 3D Hand-Tracked Animals */}
      <ArViewport
        ref={viewportRef}
        phase={phase}
        animals={animals}
        activeTargetId={activeTargetId}
        cornerBasket={cornerBasket}
        cameraStream={cameraStream}
        onAnimalFound={handleAnimalFound}
        onTelemetryUpdate={setTelemetry}
        onScanProgressUpdate={setScanProgress}
      />

      {/* =====================================================================
          PHASE 2: HOST-ONLY FAST ROOM SCAN (AUTO-STARTS AT 90% FOR EVERYONE!)
         ===================================================================== */}
      {phase === 'scan' && (
        <div className="fixed inset-0 z-20 flex flex-col justify-between p-3.5 sm:p-5 pointer-events-none">
          {/* Top Clean Grey -> Green Scan Progress Card + Host Status Bar */}
          <div className="max-w-md w-full mx-auto bg-stone-950/92 border border-stone-800 rounded-2xl p-3.5 shadow-xl pointer-events-auto">
            {/* Multiplayer Room Presence & Host Indicator Row */}
            <div className="flex items-center justify-between gap-2 pb-2 mb-2.5 border-b border-stone-800/90 text-[11px] font-mono">
              <div className="flex items-center gap-1.5 text-amber-400 font-semibold truncate">
                <Crown className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">
                  {isCurrentPlayerHost
                    ? `You (${effectivePlayerName}) are Room Host`
                    : `Host: ${hostDisplayName}`}{' '}
                  · {Math.max(1, activePlayers.length)} Playing
                </span>
              </div>
              <span className="text-emerald-400 shrink-0">
                15 Animals · First to 5 Wins
              </span>
            </div>

            <div className="flex items-center gap-3">
              {/* Left: 360° Ring (Grey = Unscanned, Green = Scanned) */}
              <div className="relative w-16 h-16 shrink-0 bg-stone-900 rounded-xl border border-stone-800 flex items-center justify-center">
                <svg viewBox="0 0 100 100" className="w-14 h-14">
                  {scanProgress.sectorStates.map((tier, idx) => {
                    const startDeg = idx * 20 - 90;
                    const endDeg = startDeg + 17;
                    const r = 38;
                    const x1 = 50 + r * Math.cos((startDeg * Math.PI) / 180);
                    const y1 = 50 + r * Math.sin((startDeg * Math.PI) / 180);
                    const x2 = 50 + r * Math.cos((endDeg * Math.PI) / 180);
                    const y2 = 50 + r * Math.sin((endDeg * Math.PI) / 180);
                    const strokeColor = tier === 'accurate' ? '#10b981' : '#64748b';
                    return (
                      <path
                        key={idx}
                        d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth="9"
                        strokeLinecap="round"
                      />
                    );
                  })}
                  <line
                    x1="50"
                    y1="50"
                    x2={
                      50 +
                      26 *
                        Math.cos(((scanProgress.currentHeadingDeg - 90) * Math.PI) / 180)
                    }
                    y2={
                      50 +
                      26 *
                        Math.sin(((scanProgress.currentHeadingDeg - 90) * Math.PI) / 180)
                    }
                    stroke="#f8fafc"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                  <circle cx="50" cy="50" r="4.5" fill="#10b981" />
                </svg>
              </div>

              {/* Right: Fast 90% Auto-Start Progress Bar */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1 mb-1.5">
                  <span className="text-xs font-semibold text-white truncate">
                    {isCurrentPlayerHost
                      ? 'Pan Camera to 90% (Auto-Starts!)'
                      : `Host ${hostDisplayName} Scanning Room...`}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-bold text-emerald-400">
                      {effectiveGreenPercent}% / 90%
                    </span>
                    <button
                      onClick={() => setShowQrModal(true)}
                      className="min-h-[30px] min-w-[30px] rounded-lg bg-stone-900 border border-stone-800 text-amber-400 flex items-center justify-center cursor-pointer"
                    >
                      <QrCode className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="w-full h-3 bg-slate-600/80 rounded-full overflow-hidden flex border border-stone-700">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-200"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round((effectiveGreenPercent / SCAN_READY_THRESHOLD_PERCENT) * 100)
                      )}%`,
                    }}
                  />
                </div>

                <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono">
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 shrink-0" />
                    <span>Scanned: {effectiveGreenPercent}%</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-300">
                    <span className="w-2.5 h-2.5 rounded-sm bg-slate-500 shrink-0" />
                    <span>
                      {effectiveGreenPercent >= SCAN_READY_THRESHOLD_PERCENT
                        ? '90% Ready!'
                        : `${Math.max(0, SCAN_READY_THRESHOLD_PERCENT - effectiveGreenPercent)}% to Auto-Start`}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Controls: Host Scans & Places Basket; Non-Host Players Wait Automatically */}
          <div className="w-full max-w-md mx-auto pointer-events-auto flex flex-col gap-2">
            {isCurrentPlayerHost ? (
              <>
                <button
                  onClick={handlePlaceBasketInCurrentCorner}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-stone-950/90 border border-emerald-500/60 text-emerald-300 hover:bg-stone-900 text-xs font-semibold flex items-center justify-center gap-2 shadow-lg cursor-pointer"
                >
                  <MapPin className="w-4 h-4 text-emerald-400" />
                  <span>
                    Point at a Floor Corner &amp; Tap to Set Basket ({cornerBasket.cornerLabel})
                  </span>
                </button>

                <button
                  onClick={handleCompleteScanAndHide}
                  disabled={isScanning}
                  className={`w-full min-h-[52px] px-6 py-3.5 rounded-2xl font-semibold text-sm flex items-center justify-center gap-2 shadow-xl cursor-pointer transition-colors ${
                    effectiveGreenPercent >= SCAN_READY_THRESHOLD_PERCENT
                      ? 'bg-emerald-500 hover:bg-emerald-400 text-stone-950'
                      : 'bg-amber-400 hover:bg-amber-300 text-stone-950'
                  } disabled:opacity-60`}
                >
                  <Scan className="w-4 h-4" />
                  <span>
                    {isScanning
                      ? 'Placing 15 Animals & Starting 3s Countdown...'
                      : `Place 15 Animals & Start Now (${effectiveGreenPercent}% · Auto at 90%)`}
                  </span>
                </button>
              </>
            ) : (
              <div className="bg-stone-950/95 border border-stone-800 rounded-2xl p-4 text-center shadow-xl">
                <div className="text-xs font-bold text-emerald-400">
                  Host ({hostDisplayName}) is scanning the room ({effectiveGreenPercent}% / 90%)
                </div>
                <p className="text-[11px] text-stone-300 mt-1">
                  You don&apos;t need to scan! Once {hostDisplayName} reaches 90%, the 2:00 timer
                  and all 15 animals will start on your screen automatically.
                </p>
                <button
                  onClick={handleClaimHostScanner}
                  className="mt-3 w-full min-h-[40px] px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-amber-300 text-xs font-semibold cursor-pointer"
                >
                  Scan From My Phone Instead (Become Host)
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          PHASE 3: SEEK & WALK (15 Animals · First to Pick 5 Wins · 2:00 Timer)
         ===================================================================== */}
      {phase === 'seek' && (
        <>
          {/* 3-SECOND PRE-START COUNTDOWN OVERLAY ("3... 2... 1... GO!") */}
          {countdownSecondsLeft !== null && (
            <div className="fixed inset-0 z-30 bg-stone-950/75 backdrop-blur-xs flex flex-col items-center justify-center p-6 text-center pointer-events-auto">
              <div className="text-xs font-mono uppercase tracking-widest text-amber-400 mb-2">
                {Math.max(1, activePlayers.length)} Player
                {activePlayers.length === 1 ? '' : 's'} · 15 Animals Hidden · First to 5 Wins!
              </div>
              <div className="text-7xl sm:text-8xl font-display font-black text-white drop-shadow-2xl">
                {countdownSecondsLeft}
              </div>
              <div className="mt-4 text-base font-bold text-emerald-400">
                First to Rescue {WIN_RESCUE_TARGET} Animals Wins!
              </div>
              <p className="mt-1.5 max-w-xs text-xs text-stone-300 leading-relaxed">
                Grab any animal with your hand, walk over to the{' '}
                <strong className="text-amber-300">
                  Corner Rescue Basket ({cornerBasket.cornerLabel})
                </strong>{' '}
                and open your hand to drop it in!
              </p>
            </div>
          )}

          {/* Top-Left Timer + First-to-5 Scoreboard + Top-Right 15 Animal Photo Thumbnails */}
          <div className="fixed top-3 left-3 right-3 z-20 flex items-start justify-between gap-2 pointer-events-none">
            {/* Top-Left: 2:00 Timer + My Score (X/5 to Win) + Multiplayer Leaderboard */}
            <div className="max-w-[215px] sm:max-w-xs bg-stone-950/92 border border-stone-800 rounded-2xl p-3 shadow-xl pointer-events-auto">
              {/* Row 1: 2-Minute Countdown Timer + Player's X/5 Progress to Win */}
              <div className="flex items-center justify-between gap-2 pb-1.5 mb-1.5 border-b border-stone-800">
                <div
                  className={`flex items-center gap-1 font-mono text-xs font-bold ${
                    roundSecondsLeft <= 15
                      ? 'text-rose-400'
                      : roundSecondsLeft <= 35
                      ? 'text-amber-400'
                      : 'text-emerald-400'
                  }`}
                >
                  <Timer className="w-3.5 h-3.5 shrink-0" />
                  <span>{formatTimerMMSS(roundSecondsLeft)}</span>
                </div>
                <span className="font-mono text-xs font-bold text-amber-400">
                  You: {myRescuedCount}/{WIN_RESCUE_TARGET} to Win
                </span>
                {isCurrentPlayerHost && (
                  <button
                    onClick={() => {
                      fetch('/api/room/reset-to-scan', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          roomCode: SHARED_SESSION_CODE,
                          playerId,
                          playerName: effectivePlayerName,
                        }),
                      }).catch(() => {});
                      viewportRef.current?.resetScanProgress();
                      autoTriggeredAt90Ref.current = false;
                      setPhase('scan');
                    }}
                    className="text-[10px] text-stone-400 hover:text-white underline cursor-pointer"
                  >
                    Re-Scan
                  </button>
                )}
              </div>

              {/* Row 2: Live Multiplayer Race to 5 */}
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-stone-300 mb-1.5 truncate">
                <Users className="w-3 h-3 text-amber-400 shrink-0" />
                <span className="truncate">
                  {activePlayers.length > 0
                    ? activePlayers
                        .slice()
                        .sort((a, b) => b.rescuedCount - a.rescuedCount)
                        .map((p) => `${p.name}: ${p.rescuedCount}/${WIN_RESCUE_TARGET}`)
                        .join(' · ')
                    : `${effectivePlayerName}: ${myRescuedCount}/${WIN_RESCUE_TARGET}`}
                </span>
              </div>

              {/* Row 3: Active Animal or Carry-to-Corner-Basket Guidance */}
              {carriedAnimal ? (
                <div className="mt-1 p-1.5 rounded-xl bg-emerald-950/80 border border-emerald-500/70">
                  <div className="text-[11px] font-bold text-emerald-300 truncate">
                    Holding {carriedAnimal.instanceLabel}!
                  </div>
                  <div className="text-[10px] font-mono text-amber-300 mt-0.5">
                    {telemetry?.isReadyToDropInBasket
                      ? '✓ Over Corner Basket! Open Hand!'
                      : telemetry?.basketTurnDirection === 'ahead'
                      ? `Walk Forward to Basket (${telemetry.basketDistanceMeters.toFixed(1)}m)`
                      : `Turn ${
                          telemetry?.basketTurnDirection === 'left' ? 'Left' : 'Right'
                        } to Corner Basket (${telemetry?.basketDistanceMeters.toFixed(1)}m)`}
                  </div>
                </div>
              ) : (
                <div className="mt-1">
                  {telemetry && (
                    <div className="flex items-center gap-1 text-[11px] text-amber-300 font-mono">
                      {telemetry.turnDirection === 'ahead' ? (
                        <span className="text-emerald-400 font-bold truncate">
                          ✓ {telemetry.targetName} ({telemetry.distanceToTargetMeters.toFixed(1)}m)
                        </span>
                      ) : telemetry.turnDirection === 'left' ? (
                        <>
                          <ArrowLeft className="w-3 h-3 shrink-0" />
                          <span className="truncate">
                            {telemetry.targetName}: Left ({telemetry.distanceToTargetMeters.toFixed(1)}m)
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="truncate">
                            {telemetry.targetName}: Right ({telemetry.distanceToTargetMeters.toFixed(1)}m)
                          </span>
                          <ArrowRight className="w-3 h-3 shrink-0" />
                        </>
                      )}
                    </div>
                  )}
                  <p className="text-[10px] text-stone-400 mt-0.5 truncate">
                    {telemetry
                      ? `Near ${telemetry.targetParentObject}`
                      : `Near ${activeAnimal.detectedParentObject}`}
                  </p>
                </div>
              )}
            </div>

            {/* Top-Right: Visual Checklist of All 15 Animals with Bundled Photo Thumbnails */}
            <div className="bg-stone-950/92 border border-stone-800 rounded-2xl p-2 shadow-xl pointer-events-auto w-[162px] sm:w-[190px]">
              <div className="text-[10px] font-mono uppercase tracking-wider text-stone-400 px-1 mb-1.5 flex items-center justify-between">
                <span>15 Animals</span>
                <span className="text-emerald-400">
                  {foundCount}/{TOTAL_ANIMALS_COUNT} Found
                </span>
              </div>
              <div className="flex flex-col gap-1 max-h-[245px] overflow-y-auto pr-0.5">
                {animals.map((item) => {
                  const isSelected = item.id === activeTargetId;
                  const isCarried = item.id === telemetry?.carriedAnimalId;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveTargetId(item.id)}
                      className={`w-full flex items-center gap-2 p-1 rounded-xl border text-left transition-colors cursor-pointer ${
                        item.found
                          ? 'bg-emerald-950/50 border-emerald-700/60 opacity-60'
                          : isCarried
                          ? 'bg-emerald-900/80 border-emerald-400'
                          : isSelected
                          ? 'bg-stone-800/95 border-amber-400/80'
                          : 'bg-stone-900/85 border-stone-800 hover:border-stone-700'
                      }`}
                    >
                      <div
                        className="relative w-8 h-8 rounded-lg overflow-hidden shrink-0 border border-stone-700 flex items-center justify-center"
                        style={{ backgroundColor: item.species.accentColor + '33' }}
                      >
                        <img
                          src={item.species.photoUrl}
                          alt={item.instanceLabel}
                          className="w-full h-full object-cover block"
                        />
                        {item.found && (
                          <div className="absolute inset-0 bg-emerald-950/75 flex items-center justify-center">
                            <Check className="w-4 h-4 text-emerald-400 stroke-[3]" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div
                          className={`text-[11px] font-semibold truncate ${
                            item.found
                              ? 'line-through text-emerald-300'
                              : 'text-stone-100'
                          }`}
                        >
                          {item.instanceLabel}
                        </div>
                        <div className="text-[9px] font-mono text-stone-400 truncate">
                          {item.found
                            ? item.rescuedBy
                              ? `By ${item.rescuedBy}`
                              : 'In Basket!'
                            : isCarried
                            ? 'In Your Hand!'
                            : item.detectedParentObject}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Bottom Corner Basket Radar + Walk / Place Basket Controls */}
          <div className="fixed bottom-4 left-0 right-0 z-20 px-4 pointer-events-none">
            <div className="max-w-md mx-auto flex flex-col gap-2 pointer-events-auto">
              {/* Corner Rescue Basket Status & Drop Action Banner */}
              <div
                className={`w-full rounded-2xl px-3.5 py-2.5 border transition-all flex items-center justify-between gap-2.5 ${
                  carriedAnimal
                    ? telemetry?.isReadyToDropInBasket
                      ? 'bg-emerald-950/95 border-emerald-400 text-emerald-200 shadow-xl'
                      : 'bg-amber-950/95 border-amber-400 text-amber-200 shadow-xl'
                    : 'bg-stone-950/90 border-stone-800 text-stone-300'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <div
                    className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border ${
                      carriedAnimal
                        ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                        : 'bg-amber-500/15 border-amber-500/40 text-amber-400'
                    }`}
                  >
                    <Hand className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-white truncate">
                      {carriedAnimal
                        ? telemetry?.isReadyToDropInBasket
                          ? `Open Hand to Drop ${carriedAnimal.instanceLabel} in Basket!`
                          : `Walk ${carriedAnimal.instanceLabel} to Corner Basket (${
                              telemetry ? telemetry.basketDistanceMeters.toFixed(1) : '1.5'
                            }m)`
                        : `First to ${WIN_RESCUE_TARGET} Wins · Basket: ${cornerBasket.cornerLabel}`}
                    </div>
                    <div className="text-[10px] font-mono text-stone-400 truncate">
                      {carriedAnimal
                        ? telemetry?.basketTurnDirection === 'ahead'
                          ? 'Basket is right ahead on the floor — step closer & open hand!'
                          : `Turn ${
                              telemetry?.basketTurnDirection === 'left' ? 'LEFT' : 'RIGHT'
                            } toward the green floor basket beacon`
                        : 'Grab animal with hand → Walk to corner basket → Open hand'}
                    </div>
                  </div>
                </div>

                {carriedAnimal && (
                  <button
                    onClick={() => handleAnimalFound(carriedAnimal.id)}
                    className="px-3 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-bold text-xs shrink-0 cursor-pointer"
                  >
                    Drop in Basket
                  </button>
                )}
              </div>

              {/* Bottom Walk & Move Corner Basket Controls */}
              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={() => viewportRef.current?.stepForwardManual(0.65)}
                  className="flex-1 min-h-[44px] px-3 py-2.5 rounded-xl bg-stone-950/90 border border-stone-800 text-stone-200 active:bg-stone-800 text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <Footprints className="w-4 h-4 text-amber-400 shrink-0" />
                  <span className="truncate">Walk / Step Closer (+0.6m)</span>
                </button>

                <button
                  onClick={handlePlaceBasketInCurrentCorner}
                  className="min-h-[44px] px-3 py-2.5 rounded-xl bg-stone-950/90 border border-stone-800 text-emerald-400 active:bg-stone-800 text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer shrink-0"
                >
                  <MapPin className="w-4 h-4 shrink-0" />
                  <span>Set Basket Corner</span>
                </button>

                <button
                  onClick={() => setShowQrModal(true)}
                  className="min-h-[44px] min-w-[44px] rounded-xl bg-stone-950/90 border border-stone-800 text-amber-400 flex items-center justify-center cursor-pointer shrink-0"
                >
                  <QrCode className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* =================================================================
              WINNER (FIRST TO 5 ANIMALS) / TIME'S UP MULTIPLAYER SUMMARY MODAL
             ================================================================= */}
          {roundFinishedReason && (
            <div className="fixed inset-0 z-30 bg-stone-950/85 backdrop-blur-xs flex items-center justify-center p-4 pointer-events-auto">
              <div className="bg-stone-900 border border-stone-800 rounded-2xl max-w-sm w-full p-6 shadow-2xl text-center">
                <div className="w-12 h-12 rounded-2xl bg-amber-400/15 border border-amber-400/40 text-amber-400 flex items-center justify-center mx-auto mb-3">
                  <Trophy className="w-6 h-6" />
                </div>
                <h2 className="font-display text-xl font-bold text-white">
                  {roundFinishedReason === 'winner_5'
                    ? `🏆 ${winnerDisplayName} Wins!`
                    : roundFinishedReason === 'all_found'
                    ? `🏆 ${winnerDisplayName} Wins! (All 15 Found)`
                    : `Time's Up! 🏆 ${winnerDisplayName} Leads!`}
                </h2>
                <p className="text-xs text-emerald-400 mt-1 font-mono font-semibold">
                  {roundFinishedReason === 'winner_5'
                    ? `First player to rescue ${WIN_RESCUE_TARGET} animals into the Corner Basket!`
                    : `Total Rescued: ${foundCount}/${TOTAL_ANIMALS_COUNT} · Time Left: ${formatTimerMMSS(
                        roundSecondsLeft
                      )}`}
                </p>

                {/* Multiplayer Room Leaderboard */}
                <div className="mt-4 bg-stone-950 border border-stone-800 rounded-xl p-3 text-left">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-stone-400 mb-2 flex items-center justify-between">
                    <span>Player Standings</span>
                    <span>Target: {WIN_RESCUE_TARGET} to Win</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {(activePlayers.length > 0
                      ? activePlayers
                      : [
                          {
                            id: playerId,
                            name: effectivePlayerName,
                            rescuedCount: myRescuedCount,
                          },
                        ]
                    )
                      .slice()
                      .sort((a, b) => b.rescuedCount - a.rescuedCount)
                      .map((p, idx) => (
                        <div
                          key={p.id}
                          className="flex items-center justify-between text-xs font-mono"
                        >
                          <span className="text-stone-200 font-semibold truncate">
                            {idx === 0 ? '👑 ' : ''}
                            {p.name} {p.id === playerId ? '(You)' : ''}
                          </span>
                          <span className="text-emerald-400 font-bold">
                            {p.rescuedCount} / {WIN_RESCUE_TARGET} Rescued
                          </span>
                        </div>
                      ))}
                  </div>
                </div>

                <div className="mt-5 flex flex-col gap-2">
                  <button
                    onClick={handleRestartTwoMinRound}
                    className="w-full min-h-[46px] px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-stone-950 font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>Play Again (15 Animals · First to 5 Wins)</span>
                  </button>
                  <button
                    onClick={() => {
                      fetch('/api/room/reset-to-scan', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          roomCode: SHARED_SESSION_CODE,
                          playerId,
                          playerName: effectivePlayerName,
                        }),
                      }).catch(() => {});
                      setRoundFinishedReason(null);
                      autoTriggeredAt90Ref.current = false;
                      viewportRef.current?.resetScanProgress();
                      setPhase('scan');
                    }}
                    className="w-full min-h-[42px] px-4 py-2 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-medium cursor-pointer"
                  >
                    Re-Scan Room &amp; Change Corner Basket
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {spottedToast && (
        <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 px-5 py-3 rounded-2xl bg-stone-950/95 border border-emerald-500 text-emerald-300 text-sm font-bold shadow-2xl text-center max-w-xs pointer-events-none">
          {spottedToast}
        </div>
      )}

      {/* =====================================================================
          PHASE 1: NAME-ONLY LAUNCH SCREEN (NO SIGNUP, NO ROOM CODE) & QR MODAL
         ===================================================================== */}
      {(phase === 'launch' || showQrModal) && (
        <div className="fixed inset-0 z-40 bg-stone-950 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-stone-900 border border-stone-800 rounded-2xl max-w-sm w-full p-5 shadow-2xl text-center relative my-auto">
            {phase !== 'launch' && (
              <button
                onClick={() => setShowQrModal(false)}
                className="absolute top-4 right-4 min-h-[38px] min-w-[38px] rounded-lg bg-stone-800 text-stone-300 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}

            <h1 className="font-display text-xl font-bold text-white">
              WildSeek AR
            </h1>
            <p className="text-xs text-stone-400 mt-1">
              15 Hidden Animals · First to Pick 5 Wins · Host Scans Room (90%)
            </p>

            {/* Name-Only Input (No Signup, No Room Code Needed) */}
            <div className="mt-4 text-left">
              <label className="block text-[11px] font-mono uppercase text-stone-400 mb-1.5">
                Enter Your Name to Play
              </label>
              <input
                type="text"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setShowQrModal(false);
                    handleOpenBackCamera();
                  }
                }}
                className="w-full px-3.5 py-2.5 rounded-xl bg-stone-950 border border-stone-700 focus:border-amber-400 focus:outline-none text-sm text-white font-mono"
                placeholder="Your Name (e.g. Alex)"
                autoFocus
              />
            </div>

            <button
              onClick={() => {
                setShowQrModal(false);
                handleOpenBackCamera();
              }}
              className="mt-3.5 w-full min-h-[48px] px-5 py-3 rounded-xl bg-amber-400 hover:bg-amber-300 text-stone-950 font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Camera className="w-4 h-4" />
              <span>Enter Game &amp; Play</span>
            </button>

            <p className="mt-2 text-[11px] text-stone-400">
              Only the Host needs to scan the room to 90% — once scanned, the 2:00 timer starts
              for everyone automatically!
            </p>

            <div className="mt-4 pt-3.5 border-t border-stone-800">
              <div className="flex items-center justify-center gap-1 p-1 bg-stone-950 rounded-xl border border-stone-800 mb-2.5">
                <button
                  onClick={() => setLinkMode('dev')}
                  className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                    linkMode === 'dev'
                      ? 'bg-stone-800 text-amber-400 font-semibold'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  Dev Link (Lab Login)
                </button>
                <button
                  onClick={() => setLinkMode('shared')}
                  className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                    linkMode === 'shared'
                      ? 'bg-stone-800 text-amber-400 font-semibold'
                      : 'text-stone-400 hover:text-stone-200'
                  }`}
                >
                  Public Link (Share)
                </button>
              </div>

              {qrDataUrl && (
                <div className="bg-white p-2.5 rounded-xl inline-block mx-auto shadow-md">
                  <img
                    src={qrDataUrl}
                    alt="Scan QR code to open on phone"
                    referrerPolicy="no-referrer"
                    className="w-40 h-40 block"
                  />
                </div>
              )}

              <div className="mt-2.5 flex items-center gap-2 bg-stone-950 border border-stone-800 rounded-xl p-2">
                <span className="font-mono text-[11px] text-stone-400 truncate flex-1 text-left px-1">
                  {activePhoneUrl}
                </span>
                <button
                  onClick={handleCopyUrl}
                  className="min-h-[34px] px-3 py-1 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-medium flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
