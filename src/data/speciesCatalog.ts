import { AnimalSpecies, HiddenAnimalInstance, SurfacePhysicsMode } from '../types/safari';
import foxPhoto from '../assets/images/real_red_fox_cutout_1793454465677.jpg';
import lemurPhoto from '../assets/images/real_lemur_cutout_1793454466569.jpg';
import frogPhoto from '../assets/images/real_tree_frog_cutout_1793454467713.jpg';
import owlPhoto from '../assets/images/real_snowy_owl_cutout_1793454469340.jpg';
import pandaPhoto from '../assets/images/real_red_panda_cutout_1793454476577.jpg';
import chameleonPhoto from '../assets/images/real_chameleon_cutout_1793454471548.jpg';

export const TOTAL_ANIMALS_COUNT = 15;
export const WIN_RESCUE_TARGET = 5;
export const SCAN_READY_THRESHOLD_PERCENT = 90;

export const SPECIES_CATALOG: AnimalSpecies[] = [
  {
    id: 'fox',
    name: 'Red Fox',
    scientificName: 'Vulpes vulpes',
    habitat: 'Low Floor Shadows & Under Furniture',
    stealthTrait:
      'Crouches low along floor shadows or underneath furniture with its amber eyes peeking out.',
    accentColor: '#EA580C',
    photoUrl: foxPhoto,
    defaultCover: 'fern',
    defaultAnchor: 'Crouched low along the floor shadow',
    defaultRiddle:
      'Check low along floor corners and under-furniture shadows—amber eyes are peeking out.',
    points: 150,
  },
  {
    id: 'lemur',
    name: 'Ring-Tailed Lemur',
    scientificName: 'Lemur catta',
    habitat: 'Side Edges & Vertical Corners',
    stealthTrait: 'Peeks around vertical room edges before darting across the floor.',
    accentColor: '#F59E0B',
    photoUrl: lemurPhoto,
    defaultCover: 'basket',
    defaultAnchor: 'Peeking around the vertical corner edge',
    defaultRiddle:
      'Look around vertical furniture sides or wall corners for a striped black-and-white tail.',
    points: 180,
  },
  {
    id: 'frog',
    name: 'Red-Eyed Tree Frog',
    scientificName: 'Agalychnis callidryas',
    habitat: 'Surface Edges & Ledges',
    stealthTrait: 'Tucks itself near surface corners and hops when discovered.',
    accentColor: '#10B981',
    photoUrl: frogPhoto,
    defaultCover: 'pot',
    defaultAnchor: 'Tucked along the surface edge',
    defaultRiddle: 'Inspect mid-height surfaces and edges closely for vivid emerald green.',
    points: 200,
  },
  {
    id: 'owl',
    name: 'Snowy Owl',
    scientificName: 'Bubo scandiacus',
    habitat: 'Elevated Ledges & Upper Corners',
    stealthTrait: 'Perches quietly on elevated ledges and glides when spotted.',
    accentColor: '#38BDF8',
    photoUrl: owlPhoto,
    defaultCover: 'ledge',
    defaultAnchor: 'Perched along an elevated room ledge',
    defaultRiddle: 'Scan slightly higher along upper surfaces and room perimeter ledges.',
    points: 220,
  },
  {
    id: 'panda',
    name: 'Red Panda',
    scientificName: 'Ailurus fulgens',
    habitat: 'Floor Corners & Baseboard Edges',
    stealthTrait: 'Prowls low along room baseboards and floor corners.',
    accentColor: '#F43F5E',
    photoUrl: pandaPhoto,
    defaultCover: 'log',
    defaultAnchor: 'Hiding along the floor corner baseboard',
    defaultRiddle: 'Look near floor corners and perimeter edges for cinnamon fur and white whiskers.',
    points: 200,
  },
  {
    id: 'chameleon',
    name: 'Veiled Chameleon',
    scientificName: 'Chamaeleo calyptratus',
    habitat: 'Camouflaged Along Trim & Crevices',
    stealthTrait: 'Clings low along trim edges and crawls slowly when your camera locks on.',
    accentColor: '#A855F7',
    photoUrl: chameleonPhoto,
    defaultCover: 'boulder',
    defaultAnchor: 'Clinging along a room crevice edge',
    defaultRiddle: 'Follow the proximity distance closely and check room trim and surface rims.',
    points: 300,
  },
];

const CAREFUL_ROOM_ANCHORS = [
  'Floor Corner Shadow',
  'Room Baseboard Edge',
  'Low Furniture Shadow',
  'Wall-Floor Crevice',
  'Side Perimeter Edge',
  'Open Floor Alcove',
];

export function buildDefault15AnimalInstances(): HiddenAnimalInstance[] {
  const instances: HiddenAnimalInstance[] = [];
  const speciesCounts: Record<string, number> = {};

  for (let i = 0; i < TOTAL_ANIMALS_COUNT; i++) {
    const species = SPECIES_CATALOG[i % SPECIES_CATALOG.length];
    speciesCounts[species.id] = (speciesCounts[species.id] || 0) + 1;
    const num = speciesCounts[species.id];

    // Distribute all 15 animals evenly around the 360° room floor (every 24°) within calibrated room XYZ bounds
    const yawDeg = (i * 24 + 18) % 360;
    const distanceMeters = Number((1.5 + (i % 4) * 0.16).toFixed(2));
    const pitchDeg = -18;
    const surfaceMode: SurfacePhysicsMode = 'floor';
    const carefulParent = CAREFUL_ROOM_ANCHORS[i % CAREFUL_ROOM_ANCHORS.length];

    instances.push({
      id: `animal_${i + 1}`,
      instanceLabel: `${species.name} #${num}`,
      species,
      yawDeg,
      pitchDeg,
      distanceMeters,
      coverType: species.defaultCover,
      detectedParentObject: carefulParent,
      realObjectAnchor: `${species.defaultAnchor} (${carefulParent})`,
      riddleClue: species.defaultRiddle,
      occlusionEdge: i % 2 === 0 ? 'bottom' : 'left',
      surfaceMode,
      furnitureDims: [0.85, 0.4, 0.85],
      found: false,
    });
  }

  return instances;
}
