export type SpeciesId = 'fox' | 'lemur' | 'frog' | 'owl' | 'panda' | 'chameleon';

export type CoverType = 'fern' | 'log' | 'pot' | 'ledge' | 'boulder' | 'basket';

export type OcclusionEdge = 'top' | 'bottom' | 'left' | 'right' | 'none';

export type SurfacePhysicsMode =
  | 'under_furniture'
  | 'behind_furniture'
  | 'on_furniture'
  | 'floor';

export interface ReconstructedFurnitureBox {
  id: string;
  label: string;
  center: [number, number, number];
  size: [number, number, number];
  yawRad: number;
  underClearanceMeters: number;
  canStandOnTop: boolean;
}

export interface ScannedObjectStatus {
  id: string;
  label: string;
  scanPercent: number;
  isFullyScanned: boolean;
}

export interface AnimalSpecies {
  id: SpeciesId;
  name: string;
  scientificName: string;
  habitat: string;
  stealthTrait: string;
  accentColor: string;
  photoUrl: string;
  defaultCover: CoverType;
  defaultRiddle: string;
  defaultAnchor: string;
  points: number;
}

export interface HiddenAnimalInstance {
  id: string; // Unique instance ID across all 15 animals ('animal_1' .. 'animal_15')
  instanceLabel: string; // e.g., 'Red Fox #1'
  species: AnimalSpecies;
  yawDeg: number; // 0 to 360 compass bearing
  pitchDeg: number; // -35 to +25 elevation angle from camera
  distanceMeters: number; // 1.35 to 2.6m
  coverType: CoverType;
  detectedParentObject: string; // Careful verified object or safe room anchor
  realObjectAnchor: string;
  riddleClue: string;
  occlusionEdge: OcclusionEdge;
  surfaceMode?: SurfacePhysicsMode;
  furnitureDims?: [number, number, number];
  surfaceElevationMeters?: number;
  box2d?: [number, number, number, number];
  occluderBox2d?: [number, number, number, number];
  sourceFrameBase64?: string;
  sourceFrameHeadingDeg?: number;
  sourceFramePitchDeg?: number;
  found: boolean;
  foundAt?: number;
  rescuedBy?: string;
}

export interface LiveDetectedObject {
  id: string;
  label: string;
  score: number;
  bbox: [number, number, number, number];
  headingDeg: number;
  objectScanPercent?: number;
  estimatedDistanceMeters?: number;
  worldPos?: [number, number, number];
}

export interface CornerBasketPlacement {
  yawDeg: number;
  distanceMeters: number;
  worldPos: [number, number, number];
  cornerLabel: string;
  placedBy?: string;
}

export interface RoomPlayer {
  id: string;
  name: string;
  color: string;
  rescuedCount: number;
  scanCoveragePercent: number;
  carryingAnimalId?: string | null;
  lastSeenMs: number;
  isHost?: boolean;
}

export interface SharedAnimalPlacementDTO {
  id: string;
  instanceLabel: string;
  speciesId: SpeciesId;
  yawDeg: number;
  pitchDeg: number;
  distanceMeters: number;
  coverType: CoverType;
  detectedParentObject: string;
  realObjectAnchor: string;
  riddleClue: string;
  occlusionEdge: OcclusionEdge;
  surfaceMode?: SurfacePhysicsMode;
  furnitureDims?: [number, number, number];
  box2d?: [number, number, number, number];
  occluderBox2d?: [number, number, number, number];
  sourceFrameHeadingDeg?: number;
  sourceFramePitchDeg?: number;
  found: boolean;
  rescuedBy?: string;
}

export interface MultiplayerRoomState {
  roomCode: string;
  status: 'scanning' | 'countdown' | 'seeking' | 'finished';
  hostPlayerId: string | null;
  hostPlayerName: string | null;
  winnerPlayerId: string | null;
  winnerPlayerName: string | null;
  winTargetCount: number; // 5 animals to win
  totalAnimalsCount: number; // 15 animals placed in room
  countdownStartedAtMs: number | null;
  roundStartedAtMs: number | null;
  roundEndsAtMs: number | null;
  roundDurationSeconds: number;
  cornerBasket: CornerBasketPlacement;
  players: RoomPlayer[];
  placements: SharedAnimalPlacementDTO[];
  scannedObjects: string[];
  combinedScanPercent: number;
  lastEventToast?: {
    id: string;
    message: string;
    timestampMs: number;
  };
}
