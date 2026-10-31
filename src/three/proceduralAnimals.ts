import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { AffordanceType, SurfacePhysicsQuery } from './spatialSlamEngine';
import { CoverType, OcclusionEdge, SpeciesId } from '../types/safari';
import { SPECIES_CATALOG } from '../data/speciesCatalog';

let sharedShadowTexture: THREE.CanvasTexture | null = null;
const furCoatTextureCache = new Map<
  SpeciesId,
  { map: THREE.CanvasTexture; bump: THREE.CanvasTexture }
>();
const photoCutoutCache = new Map<string, THREE.CanvasTexture>();

// Official Khronos Rigged 3D Fox glTF Model Cache (Walk / Survey / Run animations)
const FOX_GLB_URL =
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb';
let cachedFoxGltf: { scene: THREE.Group; animations: THREE.AnimationClip[] } | null = null;
let foxGltfLoading = false;
const foxWaiters: Array<
  (gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }) => void
> = [];

function loadOfficialFoxGltf(
  cb: (gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }) => void
) {
  if (cachedFoxGltf) {
    cb(cachedFoxGltf);
    return;
  }
  foxWaiters.push(cb);
  if (foxGltfLoading) return;
  foxGltfLoading = true;

  const loader = new GLTFLoader();
  loader.load(
    FOX_GLB_URL,
    (gltf) => {
      cachedFoxGltf = { scene: gltf.scene, animations: gltf.animations };
      while (foxWaiters.length > 0) {
        const w = foxWaiters.shift();
        if (w) w(cachedFoxGltf);
      }
    },
    undefined,
    () => {
      foxGltfLoading = false;
    }
  );
}

const _tempWorldHip = new THREE.Vector3();
const _tempLocalFoot = new THREE.Vector3();
const _invHipMatrix = new THREE.Matrix4();

function getContactShadowTexture(): THREE.CanvasTexture {
  if (sharedShadowTexture) return sharedShadowTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 60);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0.84)');
    grad.addColorStop(0.5, 'rgba(0, 0, 0, 0.38)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedShadowTexture = tex;
  return tex;
}

function loadPhotorealisticCutoutTexture(
  photoUrl: string,
  onReady: (tex: THREE.CanvasTexture) => void
) {
  const cached = photoCutoutCache.get(photoUrl);
  if (cached) {
    onReady(cached);
    return;
  }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const w = 384;
    const h = 384;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    const visited = new Uint8Array(w * h);
    const isBg = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;

    const isStudioWhite = (idx: number): boolean => {
      const p = idx * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = maxC - minC;
      return lum > 224 && sat < 34;
    };

    for (let x = 0; x < w; x++) {
      const topIdx = x;
      const botIdx = (h - 1) * w + x;
      if (isStudioWhite(topIdx)) {
        visited[topIdx] = 1;
        isBg[topIdx] = 1;
        queue[tail++] = topIdx;
      }
      if (isStudioWhite(botIdx)) {
        visited[botIdx] = 1;
        isBg[botIdx] = 1;
        queue[tail++] = botIdx;
      }
    }
    for (let y = 0; y < h; y++) {
      const leftIdx = y * w;
      const rightIdx = y * w + (w - 1);
      if (!visited[leftIdx] && isStudioWhite(leftIdx)) {
        visited[leftIdx] = 1;
        isBg[leftIdx] = 1;
        queue[tail++] = leftIdx;
      }
      if (!visited[rightIdx] && isStudioWhite(rightIdx)) {
        visited[rightIdx] = 1;
        isBg[rightIdx] = 1;
        queue[tail++] = rightIdx;
      }
    }

    while (head < tail) {
      const curr = queue[head++];
      const cx = curr % w;
      const cy = (curr / w) | 0;

      const neighbors = [
        cy > 0 ? curr - w : -1,
        cy < h - 1 ? curr + w : -1,
        cx > 0 ? curr - 1 : -1,
        cx < w - 1 ? curr + 1 : -1,
      ];

      for (let i = 0; i < 4; i++) {
        const nb = neighbors[i];
        if (nb >= 0 && !visited[nb]) {
          visited[nb] = 1;
          if (isStudioWhite(nb)) {
            isBg[nb] = 1;
            queue[tail++] = nb;
          }
        }
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const p = idx * 4;
        if (isBg[idx]) {
          data[p + 3] = 0;
        } else {
          let bgNeighbors = 0;
          if (x > 0 && isBg[idx - 1]) bgNeighbors++;
          if (x < w - 1 && isBg[idx + 1]) bgNeighbors++;
          if (y > 0 && isBg[idx - w]) bgNeighbors++;
          if (y < h - 1 && isBg[idx + w]) bgNeighbors++;
          if (bgNeighbors > 0) {
            data[p + 3] = Math.round(255 * (1 - bgNeighbors * 0.2));
            data[p] = Math.round(data[p] * 0.88);
            data[p + 1] = Math.round(data[p + 1] * 0.88);
            data[p + 2] = Math.round(data[p + 2] * 0.88);
          } else {
            data[p + 3] = 255;
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    photoCutoutCache.set(photoUrl, tex);
    onReady(tex);
  };
  img.src = photoUrl;
}

export function applyRealObjectOccluderTexture(
  rig: ArticulatedAnimalRig,
  frameBase64: string,
  animalBox2d?: [number, number, number, number],
  occluderBox2d?: [number, number, number, number],
  occlusionEdge: OcclusionEdge = 'bottom'
) {
  if (!frameBase64) return;
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const size = 256;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const box = occluderBox2d || animalBox2d || [450, 350, 750, 650];
    const [ymin, xmin, ymax, xmax] = box;
    const sx = Math.max(0, Math.min(img.width - 16, (xmin / 1000) * img.width));
    const sy = Math.max(0, Math.min(img.height - 16, (ymin / 1000) * img.height));
    const sw = Math.max(24, Math.min(img.width - sx, ((xmax - xmin) / 1000) * img.width));
    const sh = Math.max(24, Math.min(img.height - sy, ((ymax - ymin) / 1000) * img.height));

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);

    ctx.globalCompositeOperation = 'destination-in';
    const grad =
      occlusionEdge === 'left'
        ? ctx.createLinearGradient(0, 0, size, 0)
        : occlusionEdge === 'right'
        ? ctx.createLinearGradient(size, 0, 0, 0)
        : occlusionEdge === 'top'
        ? ctx.createLinearGradient(0, size, 0, 0)
        : ctx.createLinearGradient(0, 0, 0, size);

    grad.addColorStop(0.0, 'rgba(0,0,0,0.68)');
    grad.addColorStop(0.32, 'rgba(0,0,0,0.35)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.0)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    const mat = rig.occluderPlane.material as THREE.MeshBasicMaterial;
    mat.map = tex;
    mat.opacity = 0.48;
    mat.needsUpdate = true;
    rig.occluderPlane.visible = true;
    rig.occlusionEdge = occlusionEdge;
  };
  img.src = frameBase64.startsWith('data:')
    ? frameBase64
    : `data:image/jpeg;base64,${frameBase64}`;
}

function getOrCreateSpeciesPbrMaps(speciesId: SpeciesId): {
  map: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
} {
  const cached = furCoatTextureCache.get(speciesId);
  if (cached) return cached;

  const size = 256;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const cCtx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);

  if (speciesId === 'fox') {
    const grad = cCtx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#9a3412');
    grad.addColorStop(0.6, '#ea580c');
    grad.addColorStop(1, '#fff7ed');
    cCtx.fillStyle = grad;
    cCtx.fillRect(0, 0, size, size);
  } else {
    cCtx.fillStyle = '#78716c';
    cCtx.fillRect(0, 0, size, size);
  }

  const map = new THREE.CanvasTexture(colorCanvas);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;

  const bump = new THREE.CanvasTexture(bumpCanvas);
  bump.wrapS = THREE.RepeatWrapping;
  bump.wrapT = THREE.RepeatWrapping;

  const pair = { map, bump };
  furCoatTextureCache.set(speciesId, pair);
  return pair;
}

export interface ArticulatedLimb {
  hipGroup: THREE.Group;
  kneeGroup: THREE.Group;
  pawGroup: THREE.Group;
  upperLen: number;
  lowerLen: number;
  restOffsetLocal: THREE.Vector3;
  currentFootWorld: THREE.Vector3;
  stepStartWorld: THREE.Vector3;
  stepTargetWorld: THREE.Vector3;
  stepProgress: number;
  gaitPair: 0 | 1;
  isFront: boolean;
}

export interface ArticulatedAnimalRig {
  root: THREE.Group;
  actor: THREE.Group;
  pelvisGroup: THREE.Group;
  lumbarGroup: THREE.Group;
  chestGroup: THREE.Group;
  neckGroup: THREE.Group;
  headGroup: THREE.Group;
  earLeft: THREE.Object3D;
  earRight: THREE.Object3D;
  tailSegments: THREE.Group[];
  legs: {
    frontLeft: ArticulatedLimb;
    frontRight: ArticulatedLimb;
    backLeft: ArticulatedLimb;
    backRight: ArticulatedLimb;
  };
  wings?: {
    left: THREE.Group;
    right: THREE.Group;
  };
  gltfMixer?: THREE.AnimationMixer;
  gltfActions?: {
    idle?: THREE.AnimationAction;
    walk?: THREE.AnimationAction;
    run?: THREE.AnimationAction;
    active?: THREE.AnimationAction;
  };
  photoReliefMesh: THREE.Mesh;
  photoBasePositions: Float32Array;
  occluderPlane: THREE.Mesh;
  primaryMaterials: THREE.MeshStandardMaterial[];
  shadowPlane: THREE.Mesh;
  occlusionEdge: OcclusionEdge;
  anatomicalScale: number;
  physics: {
    velocity: THREE.Vector3;
    angularVelocityY: number;
    isGrounded: boolean;
    crouchFactor: number;
    headingRad: number;
    targetHeadingRad: number;
    spineSlopePitch: number;
    spineRoll: number;
    spineTurnBend: number;
    landingCompression: number;
    landingSpringVel: number;
    jumpCooldown: number;
    currentSurfaceLabel: string;
    activeAffordance: AffordanceType;
    affordanceDescription: string;
    initializedFootsteps: boolean;
  };
}

export function applyNanoBananaCoatTexture(rig: ArticulatedAnimalRig, dataUrl: string) {
  const loader = new THREE.TextureLoader();
  loader.load(dataUrl, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1.5, 1.5);
    tex.needsUpdate = true;

    rig.primaryMaterials.forEach((mat) => {
      mat.map = tex;
      mat.needsUpdate = true;
    });
  });
}

function createIKLimb(
  upperLen: number,
  lowerLen: number,
  thickness: number,
  restOffsetLocal: THREE.Vector3,
  gaitPair: 0 | 1,
  isFront: boolean,
  upperMat: THREE.Material,
  lowerMat: THREE.Material,
  pawMat: THREE.Material
): ArticulatedLimb {
  const hipGroup = new THREE.Group();

  const upperGeo = new THREE.CapsuleGeometry(thickness, upperLen, 6, 8);
  upperGeo.translate(0, -upperLen * 0.5, 0);
  const upperMesh = new THREE.Mesh(upperGeo, upperMat);
  hipGroup.add(upperMesh);

  const kneeGroup = new THREE.Group();
  kneeGroup.position.set(0, -upperLen, 0);
  hipGroup.add(kneeGroup);

  const lowerGeo = new THREE.CapsuleGeometry(thickness * 0.78, lowerLen, 6, 8);
  lowerGeo.translate(0, -lowerLen * 0.5, 0);
  const lowerMesh = new THREE.Mesh(lowerGeo, lowerMat);
  kneeGroup.add(lowerMesh);

  const pawGroup = new THREE.Group();
  pawGroup.position.set(0, -lowerLen, 0);
  kneeGroup.add(pawGroup);

  const pawGeo = new THREE.SphereGeometry(thickness * 1.05, 8, 6);
  pawGeo.scale(1.1, 0.5, 1.4);
  pawGeo.translate(0, thickness * 0.2, thickness * 0.3);
  const pawMesh = new THREE.Mesh(pawGeo, pawMat);
  pawGroup.add(pawMesh);

  return {
    hipGroup,
    kneeGroup,
    pawGroup,
    upperLen,
    lowerLen,
    restOffsetLocal,
    currentFootWorld: new THREE.Vector3(),
    stepStartWorld: new THREE.Vector3(),
    stepTargetWorld: new THREE.Vector3(),
    stepProgress: 1.0,
    gaitPair,
    isFront,
  };
}

function solveTwoBoneLimbIK(limb: ArticulatedLimb, targetFootWorld: THREE.Vector3) {
  const parent = limb.hipGroup.parent;
  if (!parent) return;

  parent.updateWorldMatrix(true, false);
  limb.hipGroup.getWorldPosition(_tempWorldHip);

  _invHipMatrix.copy(parent.matrixWorld).invert();
  _tempLocalFoot.copy(targetFootWorld).applyMatrix4(_invHipMatrix);
  _tempLocalFoot.sub(limb.hipGroup.position);

  const L1 = limb.upperLen;
  const L2 = limb.lowerLen;
  const minReach = Math.abs(L1 - L2) + 0.01;
  const maxReach = L1 + L2 - 0.005;

  const rawDist = _tempLocalFoot.length();
  const clampedDist = THREE.MathUtils.clamp(rawDist, minReach, maxReach);

  const sagittalAngle = Math.atan2(_tempLocalFoot.z, -_tempLocalFoot.y);
  const lateralAngle = THREE.MathUtils.clamp(
    Math.atan2(_tempLocalFoot.x, -_tempLocalFoot.y),
    -0.35,
    0.35
  );

  const cosHipInterior = THREE.MathUtils.clamp(
    (L1 * L1 + clampedDist * clampedDist - L2 * L2) / (2 * L1 * clampedDist),
    -1,
    1
  );
  const hipInterior = Math.acos(cosHipInterior);

  const cosKneeInterior = THREE.MathUtils.clamp(
    (L1 * L1 + L2 * L2 - clampedDist * clampedDist) / (2 * L1 * L2),
    -1,
    1
  );
  const kneeBend = Math.PI - Math.acos(cosKneeInterior);

  const bendDir = limb.isFront ? -1 : 1;

  limb.hipGroup.rotation.x = -(sagittalAngle + bendDir * hipInterior);
  limb.hipGroup.rotation.z = lateralAngle * 0.6;
  limb.kneeGroup.rotation.x = bendDir * kneeBend;
  limb.pawGroup.rotation.x = -(limb.hipGroup.rotation.x + limb.kneeGroup.rotation.x);
}

export function createProceduralAnimalCluster(
  speciesId: SpeciesId,
  _coverType: CoverType
): ArticulatedAnimalRig {
  const root = new THREE.Group();
  root.renderOrder = 5;

  // Balanced room proportions so animals fit on pillows/chairs/beds while being clearly visible
  const anatomicalScale =
    speciesId === 'frog'
      ? 0.46
      : speciesId === 'chameleon'
      ? 0.50
      : speciesId === 'owl'
      ? 0.56
      : speciesId === 'panda'
      ? 0.58
      : 0.62;

  const shadowSize = 0.58 * anatomicalScale;
  const shadowGeo = new THREE.PlaneGeometry(shadowSize, shadowSize, 8, 8);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: getContactShadowTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.78,
  });
  const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
  shadowPlane.position.y = 0.005;

  // Subtle 3D surface anchor ring on the furniture/floor beneath the animal so it is easy to spot
  const ringGeo = new THREE.RingGeometry(shadowSize * 0.42, shadowSize * 0.52, 24);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x34d399,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.position.z = 0.002;
  shadowPlane.add(ringMesh);

  root.add(shadowPlane);

  const actor = new THREE.Group();
  actor.scale.setScalar(anatomicalScale);
  root.add(actor);

  const pelvisGroup = new THREE.Group();
  actor.add(pelvisGroup);

  const lumbarGroup = new THREE.Group();
  pelvisGroup.add(lumbarGroup);

  const chestGroup = new THREE.Group();
  lumbarGroup.add(chestGroup);

  const neckGroup = new THREE.Group();
  chestGroup.add(neckGroup);

  const headGroup = new THREE.Group();
  neckGroup.add(headGroup);

  const earLeft = new THREE.Group();
  const earRight = new THREE.Group();
  const tailSegments: THREE.Group[] = [];

  const pbr = getOrCreateSpeciesPbrMaps(speciesId);
  const coatMat = new THREE.MeshStandardMaterial({
    map: pbr.map,
    bumpMap: pbr.bump,
    bumpScale: 0.02,
    roughness: 0.65,
    metalness: 0.04,
  });
  const darkAccentMat = new THREE.MeshStandardMaterial({
    color: 0x1c1917,
    roughness: 0.55,
  });

  // Photorealistic 3D Depth-Sculpted Mesh (28x28 vertices that conform to the object's 3D shape!)
  const reliefW = 0.52;
  const reliefH = 0.52;
  const photoGeo = new THREE.PlaneGeometry(reliefW, reliefH, 28, 28);
  const posAttr = photoGeo.attributes.position as THREE.BufferAttribute;
  const photoBasePositions = new Float32Array(posAttr.count * 3);

  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vy = posAttr.getY(i);
    const nx = vx / (reliefW * 0.5);
    const ny = vy / (reliefH * 0.5);
    const radialSq = Math.min(1, nx * nx + ny * ny);
    const zRelief = Math.sqrt(Math.max(0, 1 - radialSq)) * 0.068;
    const anchoredY = Math.max(0, vy + reliefH * 0.5);

    posAttr.setXYZ(i, vx, anchoredY, zRelief);
    photoBasePositions[i * 3 + 0] = vx;
    photoBasePositions[i * 3 + 1] = anchoredY;
    photoBasePositions[i * 3 + 2] = zRelief;
  }
  photoGeo.computeVertexNormals();

  const photoMat = new THREE.MeshStandardMaterial({
    transparent: true,
    alphaTest: 0.08,
    roughness: speciesId === 'frog' ? 0.28 : 0.62,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });

  const speciesMeta = SPECIES_CATALOG.find((s) => s.id === speciesId);
  if (speciesMeta?.photoUrl) {
    loadPhotorealisticCutoutTexture(speciesMeta.photoUrl, (tex) => {
      photoMat.map = tex;
      photoMat.needsUpdate = true;
    });
  }

  const photoReliefMesh = new THREE.Mesh(photoGeo, photoMat);
  photoReliefMesh.castShadow = true;
  photoReliefMesh.receiveShadow = true;
  photoReliefMesh.renderOrder = 6;
  actor.add(photoReliefMesh);

  // Foreground Real-Object Occluder Plane
  const occGeo = new THREE.PlaneGeometry(0.42 * anatomicalScale, 0.42 * anatomicalScale);
  const occMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const occluderPlane = new THREE.Mesh(occGeo, occMat);
  occluderPlane.position.set(0, 0.18 * anatomicalScale, 0.08 * anatomicalScale);
  occluderPlane.renderOrder = 8;
  occluderPlane.visible = false;
  root.add(occluderPlane);

  const isFrog = speciesId === 'frog';
  const isChameleon = speciesId === 'chameleon';
  const hipHeight = isFrog ? 0.16 : isChameleon ? 0.2 : 0.25;

  pelvisGroup.position.set(0, hipHeight, -0.09);
  lumbarGroup.position.set(0, 0.01, 0.09);
  chestGroup.position.set(0, 0.01, 0.11);
  neckGroup.position.set(0, 0.06, 0.07);
  headGroup.position.set(0, 0.04, 0.04);

  const upperL = isFrog ? 0.1 : isChameleon ? 0.11 : 0.14;
  const lowerL = isFrog ? 0.1 : isChameleon ? 0.11 : 0.14;
  const legR = 0.022;

  const fl = createIKLimb(
    upperL,
    lowerL,
    legR,
    new THREE.Vector3(-0.08, 0, 0.13),
    0,
    true,
    coatMat,
    darkAccentMat,
    darkAccentMat
  );
  const fr = createIKLimb(
    upperL,
    lowerL,
    legR,
    new THREE.Vector3(0.08, 0, 0.13),
    1,
    true,
    coatMat,
    darkAccentMat,
    darkAccentMat
  );
  const bl = createIKLimb(
    upperL,
    lowerL,
    legR,
    new THREE.Vector3(-0.085, 0, -0.11),
    1,
    false,
    coatMat,
    darkAccentMat,
    darkAccentMat
  );
  const br = createIKLimb(
    upperL,
    lowerL,
    legR,
    new THREE.Vector3(0.085, 0, -0.11),
    0,
    false,
    coatMat,
    darkAccentMat,
    darkAccentMat
  );

  fl.hipGroup.visible = false;
  fr.hipGroup.visible = false;
  bl.hipGroup.visible = false;
  br.hipGroup.visible = false;

  fl.hipGroup.position.set(-0.08, -0.02, 0.02);
  fr.hipGroup.position.set(0.08, -0.02, 0.02);
  chestGroup.add(fl.hipGroup, fr.hipGroup);

  bl.hipGroup.position.set(-0.08, -0.01, -0.02);
  br.hipGroup.position.set(0.08, -0.01, -0.02);
  pelvisGroup.add(bl.hipGroup, br.hipGroup);

  const legs = { frontLeft: fl, frontRight: fr, backLeft: bl, backRight: br };

  const rig: ArticulatedAnimalRig = {
    root,
    actor,
    pelvisGroup,
    lumbarGroup,
    chestGroup,
    neckGroup,
    headGroup,
    earLeft,
    earRight,
    tailSegments,
    legs,
    photoReliefMesh,
    photoBasePositions,
    occluderPlane,
    primaryMaterials: [coatMat],
    shadowPlane,
    occlusionEdge: 'bottom',
    anatomicalScale,
    physics: {
      velocity: new THREE.Vector3(),
      angularVelocityY: 0,
      isGrounded: true,
      crouchFactor: 0,
      headingRad: 0,
      targetHeadingRad: 0,
      spineSlopePitch: 0,
      spineRoll: 0,
      spineTurnBend: 0,
      landingCompression: 0,
      landingSpringVel: 0,
      jumpCooldown: 0,
      currentSurfaceLabel: 'Floor',
      activeAffordance: 'ROAM_FLOOR',
      affordanceDescription: 'Hiding in cover',
      initializedFootsteps: false,
    },
  };

  // Load Official Khronos Rigged 3D Fox.glb for the Red Fox species
  if (speciesId === 'fox') {
    loadOfficialFoxGltf((gltf) => {
      const cloned = SkeletonUtils.clone(gltf.scene) as THREE.Group;
      // Scale Khronos Fox (native ~90 units tall) to 0.48 local units -> ~25cm in world!
      cloned.scale.setScalar(0.0052);
      cloned.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const m = child as THREE.Mesh;
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      actor.add(cloned);
      // Hide 2D/relief cutout once true rigged 3D Fox.glb is ready
      photoReliefMesh.visible = false;

      const mixer = new THREE.AnimationMixer(cloned);
      const surveyClip = gltf.animations[0];
      const walkClip = gltf.animations[1] || gltf.animations[0];
      const runClip = gltf.animations[2] || walkClip;

      const idleAction = surveyClip ? mixer.clipAction(surveyClip) : undefined;
      const walkAction = walkClip ? mixer.clipAction(walkClip) : undefined;
      const runAction = runClip ? mixer.clipAction(runClip) : undefined;

      if (idleAction) {
        idleAction.play();
      }
      rig.gltfMixer = mixer;
      rig.gltfActions = {
        idle: idleAction,
        walk: walkAction,
        run: runAction,
        active: idleAction,
      };
    });
  }

  return rig;
}

// =============================================================================
// 3D OBJECT-SHAPE CONFORMING LOCOMOTION, SURFACE NORMAL ALIGNMENT & IK SOLVER
// =============================================================================
export function updatePhysicsBasedAnimalLocomotion(
  rig: ArticulatedAnimalRig,
  speciesId: SpeciesId,
  elapsed: number,
  delta: number,
  peekProgress: number,
  cameraWorldPos: THREE.Vector3,
  querySurfaceAt: (wx: number, wz: number) => SurfacePhysicsQuery
) {
  const phys = rig.physics;
  const horizSpeed = Math.hypot(phys.velocity.x, phys.velocity.z);
  const isMoving = horizSpeed > 0.05;
  const isAirborne = !phys.isGrounded;

  // 1. Steering & Centripetal Spine Bending
  let angleDiff = phys.targetHeadingRad - phys.headingRad;
  while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
  while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

  const targetAngVel = THREE.MathUtils.clamp(angleDiff * 6.5, -6.0, 6.0);
  phys.angularVelocityY = THREE.MathUtils.damp(
    phys.angularVelocityY,
    targetAngVel,
    10,
    delta
  );
  phys.headingRad += phys.angularVelocityY * delta;

  const targetTurnBend = THREE.MathUtils.clamp(
    -phys.angularVelocityY * (0.08 + horizSpeed * 0.12),
    -0.38,
    0.38
  );
  phys.spineTurnBend = THREE.MathUtils.damp(
    phys.spineTurnBend,
    targetTurnBend,
    9,
    delta
  );

  // 2. Landing Impact Spring
  const springForce = -140 * phys.landingCompression - 16 * phys.landingSpringVel;
  phys.landingSpringVel += springForce * delta;
  phys.landingCompression += phys.landingSpringVel * delta;
  phys.landingCompression = THREE.MathUtils.clamp(phys.landingCompression, -0.1, 0.1);

  // 3. 4-Point 3D Object Contour Sampling (Front, Back, Left, Right + Surface Normal)
  // Makes the animal hug the exact 3D shape/slope of pillows, mattresses, chairs, and floors!
  const forwardX = Math.sin(phys.headingRad);
  const forwardZ = Math.cos(phys.headingRad);
  const rightX = Math.cos(phys.headingRad);
  const rightZ = -Math.sin(phys.headingRad);

  const rootPos = rig.root.position;
  const sampleDist = 0.13 * rig.anatomicalScale;

  const frontQuery = querySurfaceAt(
    rootPos.x + forwardX * sampleDist,
    rootPos.z + forwardZ * sampleDist
  );
  const backQuery = querySurfaceAt(
    rootPos.x - forwardX * sampleDist,
    rootPos.z - forwardZ * sampleDist
  );
  const leftQuery = querySurfaceAt(
    rootPos.x - rightX * sampleDist,
    rootPos.z - rightZ * sampleDist
  );
  const rightQuery = querySurfaceAt(
    rootPos.x + rightX * sampleDist,
    rootPos.z + rightZ * sampleDist
  );

  const slopePitchAngle = Math.atan2(
    frontQuery.activeSurfaceY - backQuery.activeSurfaceY,
    sampleDist * 2
  );
  const slopeRollAngle = Math.atan2(
    leftQuery.activeSurfaceY - rightQuery.activeSurfaceY,
    sampleDist * 2
  );

  const targetPitch = isAirborne
    ? THREE.MathUtils.clamp(-phys.velocity.y * 0.14, -0.45, 0.45)
    : THREE.MathUtils.clamp(-slopePitchAngle, -0.48, 0.48);
  const targetRoll = isAirborne
    ? 0
    : THREE.MathUtils.clamp(slopeRollAngle, -0.42, 0.42);

  phys.spineSlopePitch = THREE.MathUtils.damp(
    phys.spineSlopePitch,
    targetPitch,
    11,
    delta
  );
  phys.spineRoll = THREE.MathUtils.damp(phys.spineRoll, targetRoll, 11, delta);

  // Also deform the contact shadow plane so the shadow wraps onto the curved 3D object shape!
  rig.shadowPlane.rotation.x = -Math.PI / 2 + phys.spineSlopePitch;
  rig.shadowPlane.rotation.z = phys.spineRoll;

  // 4. Orient Actor & Update Rigged glTF AnimationMixer (if present)
  const toCamX = cameraWorldPos.x - rootPos.x;
  const toCamZ = cameraWorldPos.z - rootPos.z;
  const yawToCam = Math.atan2(toCamX, toCamZ);

  if (rig.gltfMixer && rig.gltfActions) {
    // True 3D Skeletal glTF Orientation: faces velocity direction and tilts to match 3D object shape!
    rig.actor.rotation.y = phys.headingRad;
    rig.actor.rotation.x = phys.spineSlopePitch;
    rig.actor.rotation.z = phys.spineRoll + phys.spineTurnBend * 0.35;

    const desiredAction =
      horizSpeed > 0.55
        ? rig.gltfActions.run
        : horizSpeed > 0.06
        ? rig.gltfActions.walk
        : rig.gltfActions.idle;

    if (desiredAction && desiredAction !== rig.gltfActions.active) {
      rig.gltfActions.active?.fadeOut(0.2);
      desiredAction.reset().fadeIn(0.2).play();
      rig.gltfActions.active = desiredAction;
    }
    rig.gltfMixer.update(delta);
  } else {
    rig.actor.rotation.y = yawToCam + phys.spineTurnBend * 0.45;
    rig.actor.rotation.x = phys.spineSlopePitch * 0.85;
    rig.actor.rotation.z = phys.spineRoll * 0.85;
  }

  // Crouch under low furniture
  const crouchScaleY = 1.0 - phys.crouchFactor * 0.34 - phys.landingCompression * 1.4;
  const crouchScaleXZ = 1.0 + phys.crouchFactor * 0.12 + phys.landingCompression * 0.8;

  const hideFrac = Math.max(0, 1 - peekProgress);
  let peekOffsetX = 0;
  if (rig.occlusionEdge === 'left') {
    peekOffsetX = -hideFrac * 0.04;
  } else if (rig.occlusionEdge === 'right') {
    peekOffsetX = hideFrac * 0.04;
  }

  // Keep actor base strictly planted at local Y = 0 (which sits flush on FLOOR_Y)
  rig.actor.position.set(peekOffsetX, 0, 0);
  rig.actor.scale.set(
    rig.anatomicalScale * crouchScaleXZ,
    rig.anatomicalScale * Math.max(0.65, crouchScaleY),
    rig.anatomicalScale * crouchScaleXZ
  );

  if (rig.occluderPlane.visible) {
    rig.occluderPlane.rotation.y = yawToCam;
    const occMat = rig.occluderPlane.material as THREE.MeshBasicMaterial;
    occMat.opacity = isMoving && horizSpeed > 0.25 ? 0.22 : 0.45;
  }

  // 5. Procedural Foot-Planting Step Planner & 2-Bone Analytical IK
  const allLimbs = [
    rig.legs.frontLeft,
    rig.legs.frontRight,
    rig.legs.backLeft,
    rig.legs.backRight,
  ];

  if (!phys.initializedFootsteps) {
    phys.initializedFootsteps = true;
    allLimbs.forEach((limb) => {
      const restWx =
        rootPos.x +
        (rightX * limb.restOffsetLocal.x + forwardX * limb.restOffsetLocal.z) *
          rig.anatomicalScale;
      const restWz =
        rootPos.z +
        (rightZ * limb.restOffsetLocal.x + forwardZ * limb.restOffsetLocal.z) *
          rig.anatomicalScale;
      const surf = querySurfaceAt(restWx, restWz);
      limb.currentFootWorld.set(restWx, surf.activeSurfaceY, restWz);
      limb.stepStartWorld.copy(limb.currentFootWorld);
      limb.stepTargetWorld.copy(limb.currentFootWorld);
      limb.stepProgress = 1.0;
    });
  }

  const pair0Stepping =
    rig.legs.frontLeft.stepProgress < 0.75 || rig.legs.backRight.stepProgress < 0.75;
  const pair1Stepping =
    rig.legs.frontRight.stepProgress < 0.75 || rig.legs.backLeft.stepProgress < 0.75;

  const stepThreshold = (speciesId === 'chameleon' ? 0.06 : 0.09) * rig.anatomicalScale;
  const stepSpeed = speciesId === 'chameleon' ? 5.2 : 8.5 + horizSpeed * 4.5;
  const stepLiftHeight = (speciesId === 'frog' ? 0.09 : 0.06) * rig.anatomicalScale;

  allLimbs.forEach((limb) => {
    const leadTime = 0.08;
    const idealWx =
      rootPos.x +
      (rightX * limb.restOffsetLocal.x + forwardX * limb.restOffsetLocal.z) *
        rig.anatomicalScale +
      phys.velocity.x * leadTime;
    const idealWz =
      rootPos.z +
      (rightZ * limb.restOffsetLocal.x + forwardZ * limb.restOffsetLocal.z) *
        rig.anatomicalScale +
      phys.velocity.z * leadTime;

    const footSurf = querySurfaceAt(idealWx, idealWz);
    const idealWy = footSurf.activeSurfaceY;

    if (isAirborne) {
      limb.currentFootWorld.set(idealWx, rootPos.y + 0.04, idealWz);
      limb.stepTargetWorld.set(idealWx, idealWy, idealWz);
      limb.stepProgress = 1.0;
    } else {
      const distFromIdeal = Math.hypot(
        limb.currentFootWorld.x - idealWx,
        limb.currentFootWorld.z - idealWz
      );
      const heightMismatch = Math.abs(limb.currentFootWorld.y - idealWy);
      const otherPairBusy = limb.gaitPair === 0 ? pair1Stepping : pair0Stepping;

      if (
        limb.stepProgress >= 1.0 &&
        (distFromIdeal > stepThreshold || heightMismatch > 0.04) &&
        (!otherPairBusy || distFromIdeal > stepThreshold * 1.6)
      ) {
        limb.stepStartWorld.copy(limb.currentFootWorld);
        limb.stepTargetWorld.set(
          idealWx + phys.velocity.x * 0.04,
          idealWy,
          idealWz + phys.velocity.z * 0.04
        );
        limb.stepProgress = 0.0;
      }

      if (limb.stepProgress < 1.0) {
        limb.stepProgress = Math.min(1.0, limb.stepProgress + delta * stepSpeed);
        const t = limb.stepProgress;
        const u = t * t * (3 - 2 * t);
        const curX = THREE.MathUtils.lerp(limb.stepStartWorld.x, limb.stepTargetWorld.x, u);
        const curZ = THREE.MathUtils.lerp(limb.stepStartWorld.z, limb.stepTargetWorld.z, u);
        const baseLinearY = THREE.MathUtils.lerp(
          limb.stepStartWorld.y,
          limb.stepTargetWorld.y,
          u
        );
        const arcLift = Math.sin(t * Math.PI) * stepLiftHeight;
        limb.currentFootWorld.set(curX, baseLinearY + arcLift, curZ);
      } else {
        const stanceSurf = querySurfaceAt(limb.currentFootWorld.x, limb.currentFootWorld.z);
        limb.currentFootWorld.y = stanceSurf.activeSurfaceY;
      }
    }

    solveTwoBoneLimbIK(limb, limb.currentFootWorld);
  });

  // ---------------------------------------------------------------------------
  // 6. PER-VERTEX 3D OBJECT-SHAPE CONTOUR WRAPPING + GAIT DEFORMATION
  // Each vertex along the animal's base & body samples the 3D surface contour
  // underneath it so the animal physically wraps/curves over pillows, beds & chairs!
  // ---------------------------------------------------------------------------
  if (rig.photoReliefMesh.visible) {
    const posAttr = rig.photoReliefMesh.geometry.attributes.position as THREE.BufferAttribute;
    const base = rig.photoBasePositions;

    const leftStepLift = Math.sin(rig.legs.frontLeft.stepProgress * Math.PI);
    const rightStepLift = Math.sin(rig.legs.frontRight.stepProgress * Math.PI);
    const strideFreq = elapsed * (isMoving ? 15.0 : 2.6);
    const breathExpand = Math.sin(elapsed * 3.1) * 0.012;
    const headPeekSway = Math.sin(elapsed * 2.2) * (isMoving ? 0.025 : 0.014);

    const cosYaw = Math.cos(yawToCam);
    const sinYaw = Math.sin(yawToCam);

    for (let i = 0; i < posAttr.count; i++) {
      const bx = base[i * 3 + 0];
      const by = base[i * 3 + 1];
      const bz = base[i * 3 + 2];

      const normY = THREE.MathUtils.clamp(by / 0.52, 0, 1);
      const normX = bx / 0.26;

      let dx = 0;
      let dy = 0;
      let dz = 0;

      // Sample 3D object shape height directly under this vertex's world X/Z position!
      const vertexWorldX = rootPos.x + (bx * cosYaw + bz * sinYaw) * rig.anatomicalScale;
      const vertexWorldZ = rootPos.z + (-bx * sinYaw + bz * cosYaw) * rig.anatomicalScale;
      const localContourSurf = querySurfaceAt(vertexWorldX, vertexWorldZ);
      const contourDeltaLocal =
        (localContourSurf.activeSurfaceY - rootPos.y) / Math.max(0.2, rig.anatomicalScale);

      // Conform lower & mid body vertices to the 3D shape of the underlying object!
      const shapeConformWeight = Math.pow(1.0 - normY * 0.65, 1.4);
      dy += THREE.MathUtils.clamp(contourDeltaLocal, -0.14, 0.18) * shapeConformWeight;
      // Curve z-depth along the object's surface normal
      dz += -normY * phys.spineSlopePitch * 0.12;

      if (normY < 0.36) {
        const legWeight = 1.0 - normY / 0.36;
        if (isMoving || isAirborne) {
          const sidePhase = normX < 0 ? strideFreq : strideFreq + Math.PI;
          const pawLift =
            normX < 0
              ? Math.max(leftStepLift * 0.045, Math.max(0, Math.sin(sidePhase)) * 0.038)
              : Math.max(rightStepLift * 0.045, Math.max(0, Math.sin(sidePhase)) * 0.038);
          const pawSwing = Math.cos(sidePhase) * 0.032 * Math.min(1.4, horizSpeed * 1.6);

          dy += pawLift * legWeight;
          dx += pawSwing * legWeight;
          dz += Math.sin(sidePhase) * 0.025 * legWeight;
        }
      }

      const torsoWeight = Math.sin(normY * Math.PI);
      dx += normX * breathExpand * torsoWeight;
      dz += breathExpand * 0.8 * torsoWeight;
      if (isMoving) {
        dy += Math.abs(Math.sin(strideFreq)) * 0.022 * torsoWeight;
      }

      if (normY > 0.62) {
        const headWeight = (normY - 0.62) / 0.38;
        dx += (headPeekSway + phys.spineTurnBend * 0.06) * headWeight;
        dz += Math.cos(elapsed * 2.7) * 0.018 * headWeight;
      }

      posAttr.setXYZ(i, bx + dx, by + dy, bz + dz);
    }
    posAttr.needsUpdate = true;
  }
}
