import 'dotenv/config';
import express, { Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '25mb' }));

let latestPhoneTelemetry: Record<string, unknown> = {
  status: 'Waiting for phone connection',
  updatedAt: new Date().toISOString(),
};

function getGenAIClient() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// =============================================================================
// MULTIPLAYER ROOM STATE ENGINE (Server-Authoritative SSE + HTTP Sync)
// - Name-only entry into the shared session ("MAIN")
// - Host-only room scanning (auto-starts at 90% coverage for everyone!)
// - 15 hidden 3D animals in the room
// - First player to pick 5 animals & drop in the Corner Basket wins!
// =============================================================================
const TOTAL_ANIMALS_COUNT = 15;
const WIN_TARGET_COUNT = 5;

interface ServerRoomPlayer {
  id: string;
  name: string;
  color: string;
  rescuedCount: number;
  scanCoveragePercent: number;
  carryingAnimalId?: string | null;
  lastSeenMs: number;
  isHost?: boolean;
}

interface ServerCornerBasket {
  yawDeg: number;
  distanceMeters: number;
  worldPos: [number, number, number];
  cornerLabel: string;
  placedBy?: string;
}

interface ServerAnimalPlacement {
  id: string;
  instanceLabel: string;
  speciesId: string;
  yawDeg: number;
  pitchDeg: number;
  distanceMeters: number;
  coverType: string;
  detectedParentObject: string;
  realObjectAnchor: string;
  riddleClue: string;
  occlusionEdge: string;
  surfaceMode?: string;
  furnitureDims?: [number, number, number];
  box2d?: [number, number, number, number];
  occluderBox2d?: [number, number, number, number];
  sourceFrameHeadingDeg?: number;
  sourceFramePitchDeg?: number;
  found: boolean;
  rescuedBy?: string;
}

interface ServerRoomState {
  roomCode: string;
  status: 'scanning' | 'countdown' | 'seeking' | 'finished';
  hostPlayerId: string | null;
  hostPlayerName: string | null;
  winnerPlayerId: string | null;
  winnerPlayerName: string | null;
  winTargetCount: number;
  totalAnimalsCount: number;
  countdownStartedAtMs: number | null;
  roundStartedAtMs: number | null;
  roundEndsAtMs: number | null;
  roundDurationSeconds: number;
  cornerBasket: ServerCornerBasket;
  players: Map<string, ServerRoomPlayer>;
  placements: ServerAnimalPlacement[];
  scannedObjects: Set<string>;
  combinedScanPercent: number;
  lastEventToast?: {
    id: string;
    message: string;
    timestampMs: number;
  };
}

const PLAYER_COLORS = ['#f59e0b', '#10b981', '#38bdf8', '#f43f5e', '#a855f7', '#eab308'];

const rooms = new Map<string, ServerRoomState>();
const sseClientsByRoom = new Map<string, Set<Response>>();

function isMuratHostName(name?: string | null): boolean {
  return String(name || '').trim().toLowerCase() === 'murat';
}

function ensureRoomHost(room: ServerRoomState) {
  // Rule: The player named "Murat" (case-insensitive) is ALWAYS the Room Host
  let muratPlayer: ServerRoomPlayer | undefined;
  for (const p of room.players.values()) {
    if (isMuratHostName(p.name)) {
      muratPlayer = p;
      break;
    }
  }

  if (muratPlayer) {
    room.hostPlayerId = muratPlayer.id;
    room.hostPlayerName = muratPlayer.name;
    for (const p of room.players.values()) {
      p.isHost = p.id === muratPlayer.id;
    }
    return;
  }

  // If Murat is not currently connected, keep host reserved for Murat
  room.hostPlayerId = null;
  room.hostPlayerName = 'Murat';
  for (const p of room.players.values()) {
    p.isHost = false;
  }
}

function getOrCreateRoom(rawCode = 'MAIN'): ServerRoomState {
  const roomCode = String(rawCode || 'MAIN').trim().toUpperCase();
  let room = rooms.get(roomCode);
  if (!room) {
    const defaultYawRad = (42 * Math.PI) / 180;
    const defaultDist = 1.65;
    room = {
      roomCode,
      status: 'scanning',
      hostPlayerId: null,
      hostPlayerName: null,
      winnerPlayerId: null,
      winnerPlayerName: null,
      winTargetCount: WIN_TARGET_COUNT,
      totalAnimalsCount: TOTAL_ANIMALS_COUNT,
      countdownStartedAtMs: null,
      roundStartedAtMs: null,
      roundEndsAtMs: null,
      roundDurationSeconds: 120,
      cornerBasket: {
        yawDeg: 42,
        distanceMeters: defaultDist,
        worldPos: [
          Number((Math.sin(defaultYawRad) * defaultDist).toFixed(2)),
          -0.88,
          Number((-Math.cos(defaultYawRad) * defaultDist).toFixed(2)),
        ],
        cornerLabel: 'Right Room Corner (1.6m)',
      },
      players: new Map(),
      placements: [],
      scannedObjects: new Set(),
      combinedScanPercent: 0,
    };
    rooms.set(roomCode, room);
  }

  const now = Date.now();
  if (
    room.status === 'countdown' &&
    room.roundStartedAtMs &&
    now >= room.roundStartedAtMs
  ) {
    room.status = 'seeking';
  }
  if (
    room.status === 'seeking' &&
    room.roundEndsAtMs &&
    now >= room.roundEndsAtMs
  ) {
    room.status = 'finished';
    // If timer expired without a 5-animal winner, crown the player with the highest rescue count
    if (!room.winnerPlayerName && room.players.size > 0) {
      const sorted = Array.from(room.players.values()).sort(
        (a, b) => b.rescuedCount - a.rescuedCount
      );
      if (sorted[0] && sorted[0].rescuedCount > 0) {
        room.winnerPlayerId = sorted[0].id;
        room.winnerPlayerName = sorted[0].name;
      }
    }
  }

  // Prune stale disconnected players (> 35s without heartbeat)
  for (const [pid, p] of room.players.entries()) {
    if (now - p.lastSeenMs > 35000) {
      room.players.delete(pid);
    }
  }

  ensureRoomHost(room);

  // Room scan coverage is driven by the Host's scan (or max player scan) so non-hosts don't need to scan
  let maxScan = 0;
  for (const p of room.players.values()) {
    if (p.scanCoveragePercent > maxScan) {
      maxScan = p.scanCoveragePercent;
    }
  }
  room.combinedScanPercent = Math.min(100, Math.round(maxScan));

  return room;
}

function serializeRoom(room: ServerRoomState) {
  return {
    roomCode: room.roomCode,
    status: room.status,
    hostPlayerId: room.hostPlayerId,
    hostPlayerName: room.hostPlayerName,
    winnerPlayerId: room.winnerPlayerId,
    winnerPlayerName: room.winnerPlayerName,
    winTargetCount: room.winTargetCount,
    totalAnimalsCount: room.totalAnimalsCount,
    countdownStartedAtMs: room.countdownStartedAtMs,
    roundStartedAtMs: room.roundStartedAtMs,
    roundEndsAtMs: room.roundEndsAtMs,
    roundDurationSeconds: room.roundDurationSeconds,
    cornerBasket: room.cornerBasket,
    players: Array.from(room.players.values()),
    placements: room.placements,
    scannedObjects: Array.from(room.scannedObjects),
    combinedScanPercent: room.combinedScanPercent,
    lastEventToast: room.lastEventToast,
    serverNowMs: Date.now(),
  };
}

function broadcastRoomState(roomCode: string) {
  const room = getOrCreateRoom(roomCode);
  const payload = JSON.stringify({
    type: 'room:state',
    state: serializeRoom(room),
  });
  const clients = sseClientsByRoom.get(room.roomCode);
  if (!clients) return;
  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

// Real-time Server-Sent Events (SSE) stream for multiplayer room state
app.get('/api/room/stream', (req, res) => {
  const roomCode = String(req.query.roomCode || 'MAIN').toUpperCase();
  const playerId = String(req.query.playerId || `p_${Math.random().toString(36).slice(2, 8)}`);
  const playerName = String(req.query.playerName || 'Explorer');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let clientSet = sseClientsByRoom.get(roomCode);
  if (!clientSet) {
    clientSet = new Set();
    sseClientsByRoom.set(roomCode, clientSet);
  }
  clientSet.add(res);

  const room = getOrCreateRoom(roomCode);
  const existing = room.players.get(playerId);
  room.players.set(playerId, {
    id: playerId,
    name: playerName || existing?.name || 'Explorer',
    color: existing?.color || PLAYER_COLORS[room.players.size % PLAYER_COLORS.length],
    rescuedCount: existing?.rescuedCount || 0,
    scanCoveragePercent: existing?.scanCoveragePercent || 0,
    carryingAnimalId: existing?.carryingAnimalId || null,
    lastSeenMs: Date.now(),
  });
  ensureRoomHost(room);

  broadcastRoomState(roomCode);

  req.on('close', () => {
    clientSet?.delete(res);
  });
});

// HTTP Multiplayer Sync Endpoint
app.post('/api/room/sync', (req, res) => {
  const {
    roomCode = 'MAIN',
    playerId = 'p_default',
    playerName = 'Player 1',
    scanCoveragePercent,
    carryingAnimalId,
    scannedObjects,
    claimHost,
  } = req.body || {};

  const room = getOrCreateRoom(roomCode);
  const existing = room.players.get(playerId);
  room.players.set(playerId, {
    id: playerId,
    name: playerName || existing?.name || `Player ${room.players.size + 1}`,
    color: existing?.color || PLAYER_COLORS[room.players.size % PLAYER_COLORS.length],
    rescuedCount: existing?.rescuedCount || 0,
    scanCoveragePercent:
      typeof scanCoveragePercent === 'number'
        ? Math.max(existing?.scanCoveragePercent || 0, scanCoveragePercent)
        : existing?.scanCoveragePercent || 0,
    carryingAnimalId:
      carryingAnimalId !== undefined ? carryingAnimalId : existing?.carryingAnimalId || null,
    lastSeenMs: Date.now(),
  });

  if (isMuratHostName(playerName)) {
    room.hostPlayerId = playerId;
    room.hostPlayerName = playerName;
  }
  ensureRoomHost(room);

  if (Array.isArray(scannedObjects)) {
    scannedObjects.forEach((o: string) => room.scannedObjects.add(String(o)));
  }

  let maxScan = 0;
  for (const p of room.players.values()) {
    if (isMuratHostName(p.name) && p.scanCoveragePercent > maxScan) {
      maxScan = p.scanCoveragePercent;
    }
  }
  if (maxScan === 0) {
    for (const p of room.players.values()) {
      if (p.scanCoveragePercent > maxScan) {
        maxScan = p.scanCoveragePercent;
      }
    }
  }
  room.combinedScanPercent = Math.min(100, Math.round(maxScan));

  res.json(serializeRoom(room));
});

app.post('/api/room/place-basket', (req, res) => {
  const {
    roomCode = 'MAIN',
    playerName = 'Murat',
    yawDeg = 42,
    distanceMeters = 1.45,
    worldPos = [1.0, -0.88, -1.1],
    cornerLabel = 'Shared Floor Basket',
  } = req.body || {};

  const room = getOrCreateRoom(roomCode);
  // Only Host ("Murat") places the single shared basket for everyone in the room
  if (!isMuratHostName(playerName)) {
    res.json(serializeRoom(room));
    return;
  }

  room.cornerBasket = {
    yawDeg: Number(yawDeg),
    distanceMeters: Number(distanceMeters),
    worldPos: worldPos as [number, number, number],
    cornerLabel: String(cornerLabel),
    placedBy: String(playerName),
  };
  room.lastEventToast = {
    id: `basket_${Date.now()}`,
    message: `Host ${playerName} placed the shared Rescue Basket (${cornerLabel})!`,
    timestampMs: Date.now(),
  };

  broadcastRoomState(roomCode);
  res.json(serializeRoom(room));
});

app.post('/api/room/start-round', (req, res) => {
  const {
    roomCode = 'MAIN',
    playerId,
    playerName = 'Murat',
    placements = [],
    cornerBasket,
  } = req.body || {};

  const room = getOrCreateRoom(roomCode);
  if (playerId && isMuratHostName(playerName)) {
    room.hostPlayerId = String(playerId);
    room.hostPlayerName = String(playerName);
  }
  ensureRoomHost(room);

  if (Array.isArray(placements) && placements.length > 0) {
    room.placements = placements.map((p: ServerAnimalPlacement) => ({
      ...p,
      found: false,
      rescuedBy: undefined,
    }));
  } else {
    room.placements = room.placements.map((p) => ({
      ...p,
      found: false,
      rescuedBy: undefined,
    }));
  }

  if (cornerBasket && Array.isArray(cornerBasket.worldPos)) {
    room.cornerBasket = cornerBasket;
  }

  // Reset per-round player scores & winner state
  room.winnerPlayerId = null;
  room.winnerPlayerName = null;
  for (const p of room.players.values()) {
    p.rescuedCount = 0;
    p.carryingAnimalId = null;
  }

  const now = Date.now();
  room.status = 'countdown';
  room.countdownStartedAtMs = now;
  room.roundStartedAtMs = now + 3000; // 3 seconds countdown before start!
  room.roundDurationSeconds = 120; // 2 minutes (120 seconds) timer!
  room.roundEndsAtMs = now + 3000 + 120 * 1000;
  room.lastEventToast = {
    id: `start_${now}`,
    message: `${playerName} scanned the room! 15 Animals Hidden · First to 5 Wins!`,
    timestampMs: now,
  };

  broadcastRoomState(roomCode);
  res.json(serializeRoom(room));
});

app.post('/api/room/rescue-animal', (req, res) => {
  const {
    roomCode = 'MAIN',
    playerId = 'p_default',
    playerName = 'Player',
    animalId,
    animalLabel = 'Animal',
  } = req.body || {};

  const room = getOrCreateRoom(roomCode);
  const target = room.placements.find((a) => a.id === animalId);

  // Idempotent guard: only rescue if not already rescued and round is active
  if (target && !target.found && room.status !== 'finished') {
    target.found = true;
    target.rescuedBy = playerName;

    let player = room.players.get(playerId);
    if (!player) {
      player = {
        id: playerId,
        name: playerName,
        color: PLAYER_COLORS[room.players.size % PLAYER_COLORS.length],
        rescuedCount: 0,
        scanCoveragePercent: 90,
        carryingAnimalId: null,
        lastSeenMs: Date.now(),
      };
      room.players.set(playerId, player);
    }

    player.rescuedCount = (player.rescuedCount || 0) + 1;
    player.carryingAnimalId = null;

    // Check if this player just reached 5 rescued animals (WIN_TARGET_COUNT = 5)!
    if (player.rescuedCount >= WIN_TARGET_COUNT) {
      room.status = 'finished';
      room.winnerPlayerId = player.id;
      room.winnerPlayerName = player.name;
      room.lastEventToast = {
        id: `win_${animalId}_${Date.now()}`,
        message: `🏆 ${playerName} rescued ${WIN_TARGET_COUNT} animals first and WON the game!`,
        timestampMs: Date.now(),
      };
    } else {
      room.lastEventToast = {
        id: `rescue_${animalId}_${Date.now()}`,
        message: `${playerName} rescued ${animalLabel} (${player.rescuedCount}/${WIN_TARGET_COUNT} to Win)!`,
        timestampMs: Date.now(),
      };

      const allFound = room.placements.length > 0 && room.placements.every((a) => a.found);
      if (allFound) {
        room.status = 'finished';
        const topPlayer = Array.from(room.players.values()).sort(
          (a, b) => b.rescuedCount - a.rescuedCount
        )[0];
        if (topPlayer) {
          room.winnerPlayerId = topPlayer.id;
          room.winnerPlayerName = topPlayer.name;
        }
      }
    }
  } else if (room.placements.length === 0 && room.status !== 'finished') {
    const player = room.players.get(playerId);
    if (player) {
      player.rescuedCount = (player.rescuedCount || 0) + 1;
      player.carryingAnimalId = null;
      if (player.rescuedCount >= WIN_TARGET_COUNT) {
        room.status = 'finished';
        room.winnerPlayerId = player.id;
        room.winnerPlayerName = player.name;
      }
    }
  }

  broadcastRoomState(roomCode);
  res.json(serializeRoom(room));
});

app.post('/api/room/reset-to-scan', (req, res) => {
  const { roomCode = 'MAIN', playerId, playerName } = req.body || {};
  const room = getOrCreateRoom(roomCode);
  room.status = 'scanning';
  room.winnerPlayerId = null;
  room.winnerPlayerName = null;
  room.countdownStartedAtMs = null;
  room.roundStartedAtMs = null;
  room.roundEndsAtMs = null;
  room.combinedScanPercent = 0;
  if (playerId) {
    room.hostPlayerId = String(playerId);
    room.hostPlayerName = String(playerName || 'Host');
  }
  for (const p of room.players.values()) {
    p.rescuedCount = 0;
    p.scanCoveragePercent = 0;
    p.carryingAnimalId = null;
  }
  ensureRoomHost(room);
  broadcastRoomState(roomCode);
  res.json(serializeRoom(room));
});

// Live phone telemetry endpoint
app.post('/api/live-telemetry', (req, res) => {
  latestPhoneTelemetry = {
    ...req.body,
    updatedAt: new Date().toISOString(),
  };
  res.json({ ok: true });
});

app.get('/api/live-telemetry', (_req, res) => {
  res.json(latestPhoneTelemetry);
});

// POST /api/nbv-evaluate
app.post('/api/nbv-evaluate', async (req, res) => {
  try {
    const {
      imageBase64,
      mimeType = 'image/jpeg',
      currentHeadingDeg = 0,
      accuratePercent = 0,
      partialPercent = 0,
      missedPercent = 100,
    } = req.body;

    if (!imageBase64) {
      res.status(400).json({ error: 'Missing imageBase64 for NBV evaluation.' });
      return;
    }

    const ai = getGenAIClient();
    const clean = String(imageBase64).replace(/^data:image\/\w+;base64,/, '');

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: clean,
            },
          },
          {
            text: `You are a Real-Time 3D Spatial Mapping & Next-Best-View (NBV) planner.
Current 360° room scan coverage: ${accuratePercent}% Scanned Green, ${partialPercent}% Partial, ${missedPercent}% Unscanned Grey (Ready threshold: 90%).
Current camera compass heading: ${Math.round(Number(currentHeadingDeg) || 0)}°.

CRITICAL CAREFULNESS RULE: Only name a specific object (like "Chair" or "Table") if you are 100% visually certain what it is. If you are not sure about an object's identity, DO NOT guess—use safe geometric terms like "Floor surface", "Wall corner", "Baseboard edge", or "Low shadow".

1. List 1-2 surfaces that are clearly captured in this view.
2. List 1-2 surfaces that are cut off at the frame edge.
3. Recommend a Next-Best-View (NBV) camera movement to reach 90% coverage quickly.`,
          },
        ],
      },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            accuratelyCaptured: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            partiallyScanned: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            nbvInstruction: {
              type: Type.STRING,
            },
            recommendedYawOffsetDeg: {
              type: Type.NUMBER,
            },
            recommendedPitchDeg: {
              type: Type.NUMBER,
            },
          },
          required: [
            'accuratelyCaptured',
            'partiallyScanned',
            'nbvInstruction',
            'recommendedYawOffsetDeg',
            'recommendedPitchDeg',
          ],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'NBV evaluation failed.';
    res.status(500).json({ error: message });
  }
});

// POST /api/nano-banana-coat
app.post('/api/nano-banana-coat', async (req, res) => {
  try {
    const { speciesName = 'Red Fox', roomLightingDesc = 'warm indoor room lighting' } = req.body;
    const ai = getGenAIClient();

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-image-preview',
      contents: {
        parts: [
          {
            text: `Seamless close-up macro PBR wildlife coat texture swatch of a ${speciesName} fur/scales/feathers under ${roomLightingDesc}, rich natural detail, uniform lighting, tileable 3D surface texture, no background.`,
          },
        ],
      },
      config: {
        imageConfig: {
          aspectRatio: '1:1',
          imageSize: '512px',
        },
      },
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || 'image/png';
        res.json({
          dataUrl: `data:${mime};base64,${part.inlineData.data}`,
          model: 'gemini-3.1-flash-image-preview',
        });
        return;
      }
    }

    res.status(404).json({ error: 'No texture image returned by Nano Banana 2.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nano Banana 2 synthesis failed.';
    res.status(500).json({ error: message });
  }
});

// POST /api/scan-room
app.post('/api/scan-room', async (req, res) => {
  try {
    const {
      frames = [],
      imageBase64,
      mimeType = 'image/jpeg',
      currentHeadingDeg = 0,
      cocoDetectedLabels = [],
    } = req.body;

    const frameList: Array<{ base64: string; headingDeg: number }> =
      Array.isArray(frames) && frames.length > 0
        ? frames
        : imageBase64
        ? [{ base64: imageBase64, headingDeg: currentHeadingDeg }]
        : [];

    if (frameList.length === 0) {
      res.status(400).json({ error: 'Missing camera scan frames.' });
      return;
    }

    const ai = getGenAIClient();

    const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [];

    frameList.slice(0, 3).forEach((f, idx) => {
      const clean = String(f.base64).replace(/^data:image\/\w+;base64,/, '');
      parts.push({
        inlineData: {
          mimeType,
          data: clean,
        },
      });
      parts.push({
        text: `Room Scan Frame #${idx} (0-indexed) captured at compass heading ${Math.round(
          Number(f.headingDeg) || 0
        )} degrees.`,
      });
    });

    const detectedHint =
      Array.isArray(cocoDetectedLabels) && cocoDetectedLabels.length > 0
        ? `High-confidence detector verified: ${cocoDetectedLabels.join(', ')}.`
        : '';

    const promptText = `You are the 3D Spatial Reconstruction & RoomPlan Engine for a multiplayer WebAR Hide-and-Seek game.
Examine the scanned camera frame(s) of the player's real room. ${detectedHint}

CRITICAL CAREFULNESS RULE ON OBJECTS:
- Be very careful when identifying objects! ONLY name a specific furniture item (such as "Chair", "Desk", "Sofa", "Table", "Bed", "Plant") if it is 100% clearly visible and unambiguous in the frame.
- If you are NOT completely sure what an object is, DO NOT guess or invent furniture names! Instead, use safe, accurate physical room geometry descriptions: "Floor Corner Shadow", "Room Baseboard Edge", "Wall-Floor Crevice", "Low Furniture Shadow", "Side Perimeter Ledge", or "Open Floor Zone".

Place 15 3D animals around the room (cycling speciesId across "fox", "lemur", "frog", "owl", "panda", "chameleon") so players can hunt for them (first player to rescue 5 wins!).
For each of the 15 placements, return:
- speciesId: one of "fox", "lemur", "frog", "owl", "panda", "chameleon"
- frameIndex: integer index (0, 1, or 2)
- detectedParentObject: ONLY a 100% verified object name OR a careful room geometry anchor ("Floor Corner Shadow", "Room Baseboard Edge", "Wall-Floor Crevice", "Low Shadow")
- realObjectAnchor: short physical placement description
- riddleClue: 1-sentence clue
- surfaceMode: "floor", "under_furniture", "behind_furniture", or "on_furniture"
- furnitureDims: [widthMeters, heightMeters, depthMeters] in meters (e.g. [0.85, 0.45, 0.85])
- yawOffsetDeg: horizontal angle offset in degrees (-170 to +170 spread around the room)
- pitchDeg: vertical angle in degrees (-20 to -6)
- distanceMeters: accessible distance in meters (between 1.35 and 2.35)
- occlusionEdge: "bottom", "left", "right", or "top"`;

    parts.push({ text: promptText });

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: { parts },
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            environmentSummary: {
              type: Type.STRING,
            },
            detectedObjects: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            placements: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  speciesId: { type: Type.STRING },
                  frameIndex: { type: Type.INTEGER },
                  detectedParentObject: { type: Type.STRING },
                  realObjectAnchor: { type: Type.STRING },
                  riddleClue: { type: Type.STRING },
                  surfaceMode: { type: Type.STRING },
                  furnitureDims: {
                    type: Type.ARRAY,
                    items: { type: Type.NUMBER },
                  },
                  yawOffsetDeg: { type: Type.NUMBER },
                  pitchDeg: { type: Type.NUMBER },
                  distanceMeters: { type: Type.NUMBER },
                  occlusionEdge: { type: Type.STRING },
                },
                required: [
                  'speciesId',
                  'frameIndex',
                  'detectedParentObject',
                  'realObjectAnchor',
                  'riddleClue',
                  'surfaceMode',
                  'furnitureDims',
                  'yawOffsetDeg',
                  'pitchDeg',
                  'distanceMeters',
                  'occlusionEdge',
                ],
              },
            },
          },
          required: ['environmentSummary', 'detectedObjects', 'placements'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    latestPhoneTelemetry = {
      status: '15 Animals Placed with Careful Room Geometry Verification',
      environmentSummary: parsed.environmentSummary,
      detectedObjects: parsed.detectedObjects,
      placementsCount: parsed.placements?.length || 0,
      updatedAt: new Date().toISOString(),
    };
    res.json(parsed);
  } catch (error) {
    console.error('Error in /api/scan-room:', error);
    const message = error instanceof Error ? error.message : 'Failed to analyze room scan.';
    res.status(500).json({ error: message });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`WildSeek WebAR Multiplayer Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
