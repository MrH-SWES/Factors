import * as THREE from "three";
import RAPIER from "rapier";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

// ── Mobile Debugger ──────────────────────────────────────────────────
window.onerror = function (msg, src, line, col, err) {
  alert("Error: " + msg + "\nSource: " + src + "\nLine: " + line);
};

// ── Globals ──────────────────────────────────────────────────────────
let scene, camera, renderer, world;
let concreteTexture, concreteBumpTexture;
let brushedMetalTexture;
let mirrorCubeCamera, mirrorRenderTarget, mirrorMaterial;
let composer, bloomPass;
let mirrorMesh = null; // explicit reference to the '1' mirror block
const bodies = []; // { mesh, rigidBody, pointLight? } pairs for sync
const primeShaderMeshes = []; // meshes using supernova shader (need time uniform updates)

// ── Cold Open & Hinge State ──────────────────────────────────────────
const STAGE_Z = -10;
const STAGE_Y = 0.2; // stage surface height
const ALTAR_Z = 14;
const ALTAR_Y = 2.5; // top of altar slab
const CUBE_SIZE = 1;
const NUM_CUBES = 12;

const PRIMEDEX_Z = 18;
const PRIMEDEX_Y = 0.75;
const PRIMEDEX_SLOT_SPACING = 1.3;
const PRIMEDEX_LANDING_X = 0;
const PRIMEDEX_DROP_HEIGHT = 3.2;

let obeliskSegments = [];      // array of { mesh, rigidBody, index, heightStart, heightEnd }
let obeliskJointByHeight = new Map();
let obeliskAnchorJoint = null;
let obeliskGroup = null;
let hingePoints = [];          // interactive hinge point objects
let altarTrinkets = [];        // trinkets placed on the altar
let primeDexGroup = null;
let primeDexBody = null;
let primeDexWells = [];
let coldOpenComplete = false;
let foldingActive = false;
let foldingComplete = false;
let lastInteractionTime = 0;

// Audio context for thud sounds
let audioCtx = null;

// GSAP is loaded globally via <script> tag
const gsap = window.gsap;

// ── Simplex Noise (compact 3D implementation) ────────────────────────
// Based on Stefan Gustavson's GLSL simplex noise
const simplexNoiseGLSL = `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }
`;

// ── Number Classification ────────────────────────────────────────────
function isPrime(n) {
  if (n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i <= Math.sqrt(n); i += 2) {
    if (n % i === 0) return false;
  }
  return true;
}

// ── Procedural Concrete Texture (Formwork Panels & Tie Holes) ────────
function createConcreteTexture(size = 1024) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Base: warm-neutral concrete fill
  ctx.fillStyle = "#6b6560";
  ctx.fillRect(0, 0, size, size);

  // Fine aggregate grain
  const imgData = ctx.getImageData(0, 0, size, size);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(imgData, 0, 0);

  // Formwork panel grid
  const panelW = size / 4;
  const panelH = size / 3;
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 2;
  for (let px = 0; px < 4; px++) {
    for (let py = 0; py < 3; py++) {
      const x = px * panelW;
      const y = py * panelH;
      ctx.strokeRect(x + 1, y + 1, panelW - 2, panelH - 2);

      // 4 tie holes per panel
      ctx.fillStyle = "rgba(20,18,16,0.55)";
      const inset = 18;
      const holeR = 4;
      const cxs = [x + inset, x + panelW - inset, x + inset, x + panelW - inset];
      const cys = [y + inset, y + inset, y + panelH - inset, y + panelH - inset];
      for (let h = 0; h < 4; h++) {
        ctx.beginPath();
        ctx.arc(cxs[h], cys[h], holeR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  return texture;
}

function createConcreteBumpTexture(size = 1024) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Mid-gray base for bump neutrality
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, size, size);

  // Aggregate grain bump noise
  const imgData = ctx.getImageData(0, 0, size, size);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 60;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(imgData, 0, 0);

  // Panel seams as raised ridges
  const panelW = size / 4;
  const panelH = size / 3;
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 3;
  for (let px = 0; px < 4; px++) {
    for (let py = 0; py < 3; py++) {
      ctx.strokeRect(px * panelW + 1, py * panelH + 1, panelW - 2, panelH - 2);
    }
  }

  // Tie-hole depressions
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  for (let px = 0; px < 4; px++) {
    for (let py = 0; py < 3; py++) {
      const x = px * panelW;
      const y = py * panelH;
      const inset = 18;
      const cxs = [x + inset, x + panelW - inset, x + inset, x + panelW - inset];
      const cys = [y + inset, y + inset, y + panelH - inset, y + panelH - inset];
      for (let h = 0; h < 4; h++) {
        ctx.beginPath();
        ctx.arc(cxs[h], cys[h], 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  return texture;
}

function createBrushedMetalTexture(size = 512) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Solid neutral base
  ctx.fillStyle = "#d0d0d0";
  ctx.fillRect(0, 0, size, size);

  // Very faint horizontal brush lines — geometry relies on envMap + spotlights
  ctx.strokeStyle = "rgba(0,0,0,0.05)";
  ctx.lineWidth = 1;
  for (let y = 0; y < size; y += 2) {
    if (Math.random() > 0.35) continue; // sparse lines
    ctx.beginPath();
    ctx.moveTo(0, y + Math.random());
    ctx.lineTo(size, y + Math.random());
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(8, 1);
  return texture;
}

// ── Supernova Prime Material (Custom ShaderMaterial) ─────────────────
function createPrimeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0.0 },
    },
    vertexShader: `
      varying vec3 vPosition;
      varying vec3 vNormal;
      varying vec2 vUv;
      void main() {
        vPosition = position;
        vNormal = normal;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      ${simplexNoiseGLSL}

      uniform float uTime;
      varying vec3 vPosition;
      varying vec3 vNormal;
      varying vec2 vUv;

      void main() {
        // Distance from block center for radial glow
        float dist = length(vPosition) / 0.85;

        // Churning noise field
        float noise1 = snoise(vPosition * 2.5 + vec3(uTime * 0.4, 0.0, uTime * 0.3));
        float noise2 = snoise(vPosition * 5.0 - vec3(0.0, uTime * 0.6, uTime * 0.2));
        float combinedNoise = (noise1 + noise2 * 0.5) * 0.67;

        // White-hot center → orange-red energy cloud
        vec3 whiteHot = vec3(1.0, 1.0, 1.0);
        vec3 orange = vec3(1.0, 0.45, 0.05);
        vec3 deepRed = vec3(0.6, 0.05, 0.0);

        // Transition based on distance from center + noise distortion
        float t = clamp(dist + combinedNoise * 0.3, 0.0, 1.0);
        vec3 color;
        if (t < 0.3) {
          color = mix(whiteHot, orange, t / 0.3);
        } else {
          color = mix(orange, deepRed, (t - 0.3) / 0.7);
        }

        float core = smoothstep(0.45, 0.0, dist);
        color += whiteHot * core * 1.6;

        // Emissive glow intensity
        float glow = max(0.0, 1.0 - dist) * 2.0 + combinedNoise * 0.3;
        color *= (1.0 + glow);

        // Multiply by 4.0 to breach the Bloom Threshold and create pure energy
        gl_FragColor = vec4(color * 4.0, 1.0);
      }
    `,
  });
}

// ── Composite Brushed Aluminum Material ──────────────────────────────
const compositeScreenSize = { w: window.innerWidth, h: window.innerHeight };

function createCompositeMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xc8ccd0,
    metalness: 0.55,
    roughness: 0.45,
    map: brushedMetalTexture,
  });

  // "Bead" highlight logic — normal-based so it stays locked to each block's
  // physical surface regardless of camera angle.
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <output_fragment>',
      `#include <output_fragment>
       vec3 viewNormal = normalize(vNormal);
       float highlight = smoothstep(0.5, 1.0, dot(viewNormal, normalize(vec3(-1.0, 1.0, 1.0))));
       float shadow = smoothstep(0.5, 1.0, dot(viewNormal, normalize(vec3(1.0, -1.0, -1.0))));
       gl_FragColor.rgb += vec3(0.15) * highlight;
       gl_FragColor.rgb -= vec3(0.08) * shadow;`
    );
  };

  return mat;
}

// ── Mirror '1' Material (CubeCamera) ─────────────────────────────────
function getOrCreateMirrorMaterial() {
  if (mirrorMaterial) return mirrorMaterial;

  // Render target and cube camera are created in init(); just build the material
  mirrorMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transmission: 0.9,
    opacity: 1,
    metalness: 1.0,
    roughness: 0.0,
    ior: 1.5,
    thickness: 1.2,
    envMap: mirrorRenderTarget.texture,
  });
  return mirrorMaterial;
}

// ── Bootstrap ────────────────────────────────────────────────────────
async function init() {
  // 1. Rapier WASM initialisation (async/await for mobile WASM memory)
  await RAPIER.init();
  world = new RAPIER.World({ x: 0.0, y: -15.0, z: 0.0 });

  // 2. Three.js scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);

  // Volumetric 'Dust' — dusty cavern feel (dark gray lets light cones glow in air)
  scene.fog = new THREE.FogExp2(0x0a0a0a, 0.015);

  // Generate shared concrete textures
  concreteTexture = createConcreteTexture();
  concreteBumpTexture = createConcreteBumpTexture();
  brushedMetalTexture = createBrushedMetalTexture();

  // 3. Camera — low-angle, monumental perspective
  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    200
  );
  camera.position.set(0, 4.5, 22);
  camera.lookAt(0, 3, -5);

  // 4. Renderer with shadows
  renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  document.body.appendChild(renderer.domElement);

  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // High threshold keeps bloom focused on only the hottest prime core values.
    bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.0, 0.45, 3.0);
    composer.addPass(bloomPass);
  } catch (err) {
    console.warn("Post-processing unavailable, using direct renderer:", err);
    composer = null;
    bloomPass = null;
  }

  // 5. Shared CubeCamera / RenderTarget (used by mirror '1' and composite envMaps)
  mirrorRenderTarget = new THREE.WebGLCubeRenderTarget(256, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  mirrorCubeCamera = new THREE.CubeCamera(0.1, 100, mirrorRenderTarget);
  scene.add(mirrorCubeCamera);

  // 6. Lighting ──────────────────────────────────────────────────────────
  // A. Ambient Fill (Dim conference room baseline)
  const ambient = new THREE.HemisphereLight(0x3a4050, 0x111111, 0.25);
  scene.add(ambient);

  // B. Diffuse Altar Light (Second most well-lit, extremely soft)
  const altarSpot = new THREE.SpotLight(0xffffff, 80);
  altarSpot.position.set(0, 8, 14);
  altarSpot.target.position.set(0, 1, 14);
  altarSpot.angle = Math.PI / 4;
  altarSpot.penumbra = 1.0;
  altarSpot.decay = 2.0;
  altarSpot.castShadow = true;
  scene.add(altarSpot);
  scene.add(altarSpot.target);

  // C. 3-Point Obelisk Lighting (Angled down to highlight the artifact)
  const obeliskTarget = new THREE.Object3D();
  obeliskTarget.position.set(0, 4, STAGE_Z);
  scene.add(obeliskTarget);

  // Top-front angled down
  const spotFrontTop = new THREE.SpotLight(0xffffff, 120);
  spotFrontTop.position.set(0, 15, STAGE_Z + 6);
  spotFrontTop.target = obeliskTarget;
  spotFrontTop.angle = 0.5;
  spotFrontTop.penumbra = 0.6;
  spotFrontTop.decay = 2.0;
  spotFrontTop.castShadow = true;
  scene.add(spotFrontTop);

  // Left 45-degree
  const spotLeft = new THREE.SpotLight(0xffffff, 80);
  spotLeft.position.set(-8, 12, STAGE_Z + 4);
  spotLeft.target = obeliskTarget;
  spotLeft.angle = 0.5;
  spotLeft.penumbra = 0.6;
  spotLeft.decay = 2.0;
  spotLeft.castShadow = true;
  scene.add(spotLeft);

  // Right 45-degree
  const spotRight = new THREE.SpotLight(0xffffff, 80);
  spotRight.position.set(8, 12, STAGE_Z + 4);
  spotRight.target = obeliskTarget;
  spotRight.angle = 0.5;
  spotRight.penumbra = 0.6;
  spotRight.decay = 2.0;
  spotRight.castShadow = true;
  scene.add(spotRight);

  // D. Back Wall Downlights (Architectural depth)
  const downlightDefs = [ { x: -6 }, { x: 0 }, { x: 6 } ];
  for (const dl of downlightDefs) {
    const spot = new THREE.SpotLight(0xf5e6d0, 90);
    spot.position.set(dl.x, 9, -29);
    spot.target.position.set(dl.x, 0, -30);
    spot.angle = 0.35;
    spot.penumbra = 0.5;
    spot.decay = 2.0;
    spot.castShadow = false;
    scene.add(spot);
    scene.add(spot.target);
  }

  // 6. Room, Altar & Cold Open
  createRoom();
  createAltar();

  // 6b. Dust system removed — clear air for the vault

  // 7. Events (pointerdown for mobile touch support)
  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("resize", onResize);

  // 8. Start loop
  loop();

  // 9. Start the #12 Cold Open sequence after a brief delay
  gsap.delayedCall(0.5, startColdOpen);
}

// ── Room (Brutalist Concrete) ────────────────────────────────────────
function createRoom() {
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x4a4a4a,
    roughness: 0.88,
    metalness: 0.0,
    map: concreteTexture,
    bumpMap: concreteBumpTexture,
    bumpScale: 0.8,
  });

  // Matte poured-concrete floor — darker and smoother than walls
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.92,
    metalness: 0.02,
    map: concreteTexture,
    bumpMap: concreteBumpTexture,
    bumpScale: 0.4,
  });

  const roomW = 800; // width (x) — vast horizon for 144-obelisk chain
  const roomH = 20; // height (y)
  const roomD = 61; // depth  (z) — larger to accommodate z:14 altar and z:-10 stage
  const thick = 1;  // wall thickness
  const roomZCenter = 0; // room centered at z=0

  // Helper: create a static box with mesh + Rapier collider
  function addStaticBox(w, h, d, px, py, pz, mat) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, mat || wallMat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.position.set(px, py, pz);
    scene.add(mesh);

    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(px, py, pz);
    const rb = world.createRigidBody(bodyDesc);
    const cd = RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2)
      .setRestitution(0.0)
      .setFriction(0.8);
    world.createCollider(cd, rb);
  }

  // Floor (glossy sealed concrete for specular pooling)
  addStaticBox(roomW, thick, roomD, 0, -thick / 2, roomZCenter, floorMat);

  // Ceiling
  addStaticBox(roomW, thick, roomD, 0, roomH + thick / 2, roomZCenter);

  // Back Wall
  addStaticBox(roomW, roomH, thick, 0, roomH / 2, roomZCenter - roomD / 2 + thick / 2);

  // Side walls removed — infinite vault horizon

  // Stage — wider cylinder at z: -10 so obelisk shadow lands on it
  const stageRadius = 6;
  const stageHeight = 0.25;
  const stageGeo = new THREE.CylinderGeometry(stageRadius, stageRadius, stageHeight, 64);
  const stageMesh = new THREE.Mesh(stageGeo, wallMat);
  stageMesh.receiveShadow = true;
  stageMesh.castShadow = true;
  stageMesh.position.set(0, stageHeight / 2, STAGE_Z);
  scene.add(stageMesh);

  // Rapier collider for the stage cylinder
  const stageBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, stageHeight / 2, STAGE_Z);
  const stageRb = world.createRigidBody(stageBodyDesc);
  const stageCd = RAPIER.ColliderDesc.cylinder(stageHeight / 2, stageRadius)
    .setRestitution(0.0)
    .setFriction(0.8);
  world.createCollider(stageCd, stageRb);

  // Wall wash lights replaced by back-wall downlights in init()
}

// ── Altar Table (slab on pedestal, foreground at z: 14) ──────────────
function createAltar() {

  const altarMat = new THREE.MeshStandardMaterial({
    color: 0x151618,
    roughness: 1.0,
    metalness: 0.0,
    bumpMap: concreteBumpTexture,
    bumpScale: 0.015,
  });

  const pz = 14; // foreground altar position

  // Pedestal — tapered heavy stone pillar
  const pedWTop = 1.4;
  const pedWBot = 1.9;
  const pedH = 1.15;
  const pedD = 1.4;
  const pedY = pedH / 2;

  const pedShape = new THREE.Shape();
  pedShape.moveTo(-pedWBot / 2, 0);
  pedShape.lineTo(pedWBot / 2, 0);
  pedShape.lineTo(pedWTop / 2, pedH);
  pedShape.lineTo(-pedWTop / 2, pedH);
  pedShape.closePath();
  const pedGeo = new THREE.ExtrudeGeometry(pedShape, { depth: pedD, bevelEnabled: false });
  pedGeo.translate(0, 0, -pedD / 2);
  const pedMesh = new THREE.Mesh(pedGeo, altarMat);
  pedMesh.receiveShadow = true;
  pedMesh.castShadow = true;
  pedMesh.position.set(0, pedY, pz);
  scene.add(pedMesh);

  const pedBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, pedY, pz);
  const pedRb = world.createRigidBody(pedBodyDesc);
  const pedCd = RAPIER.ColliderDesc.cuboid(pedWBot / 2, pedH / 2, pedD / 2)
    .setRestitution(0.0)
    .setFriction(0.8);
  world.createCollider(pedCd, pedRb);

  // Slab — thick stone slab on top of the pedestal
  const slabW = 7.2;
  const slabH = 1.5;
  const slabD = 0.8;
  const slabY = pedH + slabH / 2;

  const slabGeo = new THREE.BoxGeometry(slabW, slabH, slabD);
  const slabMesh = new THREE.Mesh(slabGeo, altarMat);
  slabMesh.receiveShadow = true;
  slabMesh.castShadow = true;
  slabMesh.position.set(0, slabY, pz);
  scene.add(slabMesh);

  const slabBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, slabY, pz);
  const slabRb = world.createRigidBody(slabBodyDesc);
  const slabCd = RAPIER.ColliderDesc.cuboid(slabW / 2, slabH / 2, slabD / 2)
    .setRestitution(0.0)
    .setFriction(0.8);
  world.createCollider(slabCd, slabRb);

  createPrimeDex();
}

// ── PrimeDex (sliding slab with recessed wells 1–12) ────────────────
function createPrimeDex() {
  const slabW = PRIMEDEX_SLOT_SPACING * (NUM_CUBES + 1);
  const slabH = 1.1;
  const slabD = 4.4;
  const wellRadius = 0.42;
  const wellDepth = 0.72;
  const wallThickness = 0.08;
  const topY = slabH / 2;
  const wellBottomY = topY - wellDepth;

  primeDexGroup = new THREE.Group();
  primeDexGroup.position.set(0, PRIMEDEX_Y, PRIMEDEX_Z);
  scene.add(primeDexGroup);

  const slabMat = new THREE.MeshStandardMaterial({
    color: 0x202020,
    roughness: 0.96,
    metalness: 0.02,
    map: concreteTexture,
    bumpMap: concreteBumpTexture,
    bumpScale: 0.08,
  });

  const slabGeo = new THREE.BoxGeometry(slabW, slabH, slabD);
  const slabMesh = new THREE.Mesh(slabGeo, slabMat);
  slabMesh.castShadow = true;
  slabMesh.receiveShadow = true;
  primeDexGroup.add(slabMesh);

  const zoneGeo = new THREE.RingGeometry(0.5, 0.75, 40);
  const zoneMat = new THREE.MeshBasicMaterial({
    color: 0xbdd7cc,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
  });
  const zoneMesh = new THREE.Mesh(zoneGeo, zoneMat);
  zoneMesh.position.set(PRIMEDEX_LANDING_X, PRIMEDEX_Y + topY + 0.03, PRIMEDEX_Z);
  zoneMesh.rotation.x = -Math.PI / 2;
  scene.add(zoneMesh);

  const dexBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, PRIMEDEX_Y, PRIMEDEX_Z);
  primeDexBody = world.createRigidBody(dexBodyDesc);
  primeDexWells = [];

  const baseCd = RAPIER.ColliderDesc.cuboid(slabW / 2, 0.2, slabD / 2).setTranslation(0, wellBottomY - 0.24, 0);
  world.createCollider(baseCd, primeDexBody);

  for (let i = 1; i <= NUM_CUBES; i++) {
    const localX = (i - (NUM_CUBES + 1) / 2) * PRIMEDEX_SLOT_SPACING;

    const ringGeo = new THREE.CylinderGeometry(wellRadius + 0.06, wellRadius + 0.06, 0.1, 28, 1, true);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a2a,
      roughness: 0.85,
      metalness: 0.05,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.set(localX, topY - 0.06, 0);
    ringMesh.castShadow = true;
    ringMesh.receiveShadow = true;
    primeDexGroup.add(ringMesh);

    const cavityGeo = new THREE.CylinderGeometry(wellRadius, wellRadius, wellDepth, 28);
    const cavityMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      roughness: 1.0,
      metalness: 0.0,
    });
    const cavityMesh = new THREE.Mesh(cavityGeo, cavityMat);
    cavityMesh.position.set(localX, wellBottomY + wellDepth / 2, 0);
    cavityMesh.receiveShadow = true;
    primeDexGroup.add(cavityMesh);

    // Four thin walls + base plate approximate a recessed capture well.
    const wallHalf = wellRadius + wallThickness / 2;
    const wallHeight = wellDepth / 2;
    world.createCollider(RAPIER.ColliderDesc.cuboid(wallThickness / 2, wallHeight, wellRadius).setTranslation(localX - wallHalf, wellBottomY + wallHeight, 0), primeDexBody);
    world.createCollider(RAPIER.ColliderDesc.cuboid(wallThickness / 2, wallHeight, wellRadius).setTranslation(localX + wallHalf, wellBottomY + wallHeight, 0), primeDexBody);
    world.createCollider(RAPIER.ColliderDesc.cuboid(wellRadius, wallHeight, wallThickness / 2).setTranslation(localX, wellBottomY + wallHeight, -wallHalf), primeDexBody);
    world.createCollider(RAPIER.ColliderDesc.cuboid(wellRadius, wallHeight, wallThickness / 2).setTranslation(localX, wellBottomY + wallHeight, wallHalf), primeDexBody);
    world.createCollider(RAPIER.ColliderDesc.cuboid(wellRadius * 0.95, 0.06, wellRadius * 0.95).setTranslation(localX, wellBottomY + 0.06, 0), primeDexBody);

    primeDexWells.push({
      index: i,
      localX,
      localY: wellBottomY + 0.24,
      localZ: 0,
    });
  }
}

function autoSlideDex(targetIndex) {
  if (!primeDexGroup || !primeDexBody || primeDexWells.length === 0) {
    return Promise.resolve();
  }

  const clamped = Math.max(1, Math.min(NUM_CUBES, targetIndex));
  const targetWell = primeDexWells[clamped - 1];
  const targetX = PRIMEDEX_LANDING_X - targetWell.localX;

  playMechanicalSlide();

  return new Promise((resolve) => {
    gsap.to(primeDexGroup.position, {
      x: targetX,
      duration: 0.85,
      ease: "power3.inOut",
      onUpdate: () => {
        primeDexBody.setNextKinematicTranslation({
          x: primeDexGroup.position.x,
          y: PRIMEDEX_Y,
          z: PRIMEDEX_Z,
        });
      },
      onComplete: () => {
        primeDexBody.setNextKinematicTranslation({ x: targetX, y: PRIMEDEX_Y, z: PRIMEDEX_Z });
        resolve();
      },
    });
  });
}

function getLandingDropTarget() {
  const centeredWell = primeDexWells.find((w) => Math.abs(primeDexGroup.position.x + w.localX - PRIMEDEX_LANDING_X) < 0.01) || primeDexWells[0];
  return {
    x: PRIMEDEX_LANDING_X,
    y: PRIMEDEX_Y + centeredWell.localY,
    z: PRIMEDEX_Z + centeredWell.localZ,
  };
}

// ── Primary Obelisk — replaced by Cold Open sequence ─────────────────

// ── Create Trinket on Altar ──────────────────────────────────────────
function createTrinket(label, materialType) {
  const trinketSize = 0.4;
  const geo = new THREE.BoxGeometry(trinketSize, trinketSize, trinketSize);
  let mat;

  if (materialType === "mirror") {
    mat = getOrCreateMirrorMaterial().clone();
  } else if (materialType === "prime") {
    mat = createPrimeMaterial();
  } else {
    mat = createCompositeMaterial();
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Place trinkets left-to-right along the altar
  const xOffset = (altarTrinkets.length - 2) * 0.8;
  mesh.position.set(xOffset, ALTAR_Y + trinketSize / 2 + 0.01, ALTAR_Z);
  scene.add(mesh);

  if (materialType === "prime") {
    primeShaderMeshes.push(mesh);
    const pl = new THREE.PointLight(0xff6600, 5, 4, 2);
    mesh.add(pl);
  }

  // Floating label
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 40px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(label), 32, 32);
  const labelTex = new THREE.CanvasTexture(canvas);
  const labelMat = new THREE.SpriteMaterial({ map: labelTex, transparent: true, opacity: 0.9 });
  const sprite = new THREE.Sprite(labelMat);
  sprite.scale.set(0.5, 0.5, 0.5);
  sprite.position.y = trinketSize / 2 + 0.35;
  mesh.add(sprite);

  altarTrinkets.push({ mesh, label, materialType });

  // Entry animation
  mesh.scale.set(0, 0, 0);
  gsap.to(mesh.scale, { x: 1, y: 1, z: 1, duration: 0.5, ease: "back.out(2)" });

  return mesh;
}

// ── Heavy Thud Audio ─────────────────────────────────────────────────
function playThud() {
  const ctx = ensureAudioContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 55; // deep bass
  gain.gain.setValueAtTime(0.4, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.3);
}

function playMechanicalSlide() {
  const ctx = ensureAudioContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(180, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(95, ctx.currentTime + 0.34);

  filter.type = "bandpass";
  filter.frequency.setValueAtTime(720, ctx.currentTime);
  filter.Q.value = 0.9;

  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.04, ctx.currentTime + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.36);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.38);
}

function ensureAudioContext() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

// ── Camera Shake ─────────────────────────────────────────────────────
function cameraShake(intensity = 0.15, duration = 0.2) {
  const origPos = camera.position.clone();
  const tl = gsap.timeline();
  const steps = 6;
  for (let i = 0; i < steps; i++) {
    const factor = 1 - i / steps;
    tl.to(camera.position, {
      x: origPos.x + (Math.random() - 0.5) * intensity * factor,
      y: origPos.y + (Math.random() - 0.5) * intensity * factor,
      duration: duration / steps,
      ease: "none",
    });
  }
  tl.to(camera.position, { x: origPos.x, y: origPos.y, duration: 0.05 });
}

// ── Fusion Flash ─────────────────────────────────────────────────────
function createFlash(position) {
  const flashGeo = new THREE.SphereGeometry(2, 16, 16);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1.0,
  });
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.position.copy(position);
  scene.add(flash);

  gsap.to(flash.scale, { x: 4, y: 4, z: 4, duration: 0.4, ease: "power2.out" });
  gsap.to(flashMat, {
    opacity: 0,
    duration: 0.6,
    ease: "power2.out",
    onComplete: () => {
      scene.remove(flash);
      flashGeo.dispose();
      flashMat.dispose();
    },
  });
}

// ── #12 Cold Open Sequence ───────────────────────────────────────────
function startColdOpen() {
  // Spawn '1' trinket on altar at start
  createTrinket(1, "mirror");

  const dropCubes = [];
  const baseY = STAGE_Y;

  const tl = gsap.timeline({
    onComplete: () => {
      fuseCubes(dropCubes, baseY);
    },
  });

  for (let i = 0; i < NUM_CUBES; i++) {
    const geo = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
    const mat = getOrCreateMirrorMaterial().clone();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const targetY = baseY + CUBE_SIZE / 2 + i * CUBE_SIZE;
    const startY = 18; // ceiling area

    mesh.position.set(0, startY, STAGE_Z);
    scene.add(mesh);
    dropCubes.push(mesh);

    // Stagger each cube drop
    tl.to(
      mesh.position,
      {
        y: targetY,
        duration: 0.35,
        ease: "bounce.out",
        onComplete: () => {
          playThud();
          cameraShake(0.05, 0.1);
        },
      },
      i * 0.15
    );
  }
}

// ── Fusion: 12 cubes → 1 Composite Obelisk ──────────────────────────
function fuseCubes(cubes, baseY) {
  const centerY = baseY + (NUM_CUBES * CUBE_SIZE) / 2;
  createFlash(new THREE.Vector3(0, centerY, STAGE_Z));
  playThud();
  cameraShake(0.3, 0.3);

  // Remove individual cubes
  gsap.delayedCall(0.2, () => {
    for (const cube of cubes) {
      scene.remove(cube);
      cube.geometry.dispose();
      if (cube.material !== mirrorMaterial) cube.material.dispose();
    }

    // Create composite obelisk
    createCompositeObelisk(baseY);

    // Spawn '12' composite trinket on altar
    createTrinket(12, "composite");

    coldOpenComplete = true;
    lastInteractionTime = performance.now() / 1000;
  });
}

// ── Composite Obelisk (12 units tall, segmented for folding) ─────────
function createCompositeObelisk(baseY) {
  obeliskGroup = null;
  obeliskSegments = [];
  obeliskJointByHeight = new Map();
  obeliskAnchorJoint = null;

  const anchorDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, baseY, STAGE_Z);
  const anchorBody = world.createRigidBody(anchorDesc);

  // Each segment is a standalone dynamic rigid body.
  for (let i = 0; i < NUM_CUBES; i++) {
    const geo = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
    const mat = createCompositeMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const y = baseY + CUBE_SIZE / 2 + i * CUBE_SIZE;
    mesh.position.set(0, y, STAGE_Z);
    scene.add(mesh);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, y, STAGE_Z)
      .setLinearDamping(0.55)
      .setAngularDamping(0.75);
    const rigidBody = world.createRigidBody(bodyDesc);

    const cd = RAPIER.ColliderDesc.cuboid(CUBE_SIZE / 2, CUBE_SIZE / 2, CUBE_SIZE / 2)
      .setRestitution(0.0)
      .setFriction(0.9)
      .setDensity(1.4);
    world.createCollider(cd, rigidBody);

    bodies.push({ mesh, rigidBody });

    obeliskSegments.push({
      mesh,
      rigidBody,
      index: i,
      heightStart: i,
      heightEnd: i + 1,
    });
  }

  // Anchor the bottom segment to preserve the tower's staged posture.
  const anchorJointData = RAPIER.JointData.revolute(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: -CUBE_SIZE / 2, z: 0 },
    { x: 1, y: 0, z: 0 }
  );
  obeliskAnchorJoint = world.createImpulseJoint(anchorJointData, anchorBody, obeliskSegments[0].rigidBody, true);
  if (obeliskAnchorJoint.setLimits) {
    obeliskAnchorJoint.setLimits(0, 0);
  }
  if (obeliskAnchorJoint.configureMotorPosition) {
    obeliskAnchorJoint.configureMotorPosition(0, 70, 8);
  }

  // Joint each neighboring segment with a locked revolute hinge.
  for (let i = 0; i < obeliskSegments.length - 1; i++) {
    const lower = obeliskSegments[i];
    const upper = obeliskSegments[i + 1];
    const jointData = RAPIER.JointData.revolute(
      { x: 0, y: CUBE_SIZE / 2, z: 0 },
      { x: 0, y: -CUBE_SIZE / 2, z: 0 },
      { x: 1, y: 0, z: 0 }
    );
    const joint = world.createImpulseJoint(jointData, lower.rigidBody, upper.rigidBody, true);
    if (joint.setLimits) {
      joint.setLimits(0, 0);
    }
    if (joint.configureMotorPosition) {
      joint.configureMotorPosition(0, 90, 10);
    }
    obeliskJointByHeight.set(i + 1, joint);
  }

  // Create hinge points at heights 2, 3, 4, 6
  createHingePoints(baseY);
}

// ── Hinge Point Markers ──────────────────────────────────────────────
function createHingePoints(baseY) {
  const hingeHeights = [2, 3, 4, 6];
  hingePoints = [];

  for (const h of hingeHeights) {
    const hingeY = baseY + h * CUBE_SIZE;

    // Visual marker — small glowing ring
    const ringGeo = new THREE.TorusGeometry(0.7, 0.05, 8, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.6,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, hingeY, STAGE_Z);
    scene.add(ring);

    // Label
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#00ff88";
    ctx.font = "bold 28px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("÷" + h, 32, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.0 });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(0.6, 0.6, 0.6);
    sprite.position.set(1.2, hingeY, STAGE_Z);
    scene.add(sprite);

    hingePoints.push({
      height: h,
      hingeY,
      ring,
      label: sprite,
      labelMat: spriteMat,
      activated: false,
      baseY,
    });
  }
}

// ── Breathing Hints (Idle Pulse) ─────────────────────────────────────
function updateBreathingHints(elapsed) {
  if (!coldOpenComplete || foldingActive || foldingComplete) return;

  const timeSinceInteraction = elapsed - lastInteractionTime;

  for (const hp of hingePoints) {
    if (hp.activated) continue;

    if (timeSinceInteraction > 3.0) {
      // Pulse green light
      const pulse = 0.4 + 0.3 * Math.sin(elapsed * 3.0);
      hp.ring.material.opacity = pulse;
      hp.labelMat.opacity = pulse * 0.8;
    } else {
      hp.ring.material.opacity = 0.3;
      hp.labelMat.opacity = 0.0;
    }
  }
}

// ── Hinge Click Detection ────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function onPointerDown(event) {
  if (!coldOpenComplete || foldingActive) return;

  // Check for handle drag (unspooling)
  if (foldingComplete && handleMesh) {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(handleMesh, true);
    if (hits.length > 0) {
      startUnspooling();
      return;
    }
  }

  // Check for hinge clicks
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  // Find next available hinge (in order: 6, 4, 3, 2)
  const hingeOrder = [6, 4, 3, 2];
  let nextHinge = null;
  for (const h of hingeOrder) {
    const hp = hingePoints.find((p) => p.height === h && !p.activated);
    if (hp) {
      nextHinge = hp;
      break;
    }
  }

  if (!nextHinge) return;

  // Check if clicked near the hinge
  const ringHits = raycaster.intersectObject(nextHinge.ring);
  // Also check if clicked on obelisk segments
  const segMeshes = obeliskSegments.map((s) => s.mesh);
  const segHits = raycaster.intersectObjects(segMeshes);

  if (ringHits.length > 0 || segHits.length > 0) {
    lastInteractionTime = performance.now() / 1000;
    activateHinge(nextHinge);
  }
}

// ── Hinge Activation & Fold Animation ────────────────────────────────
let handleMesh = null;
const foldHistory = []; // for unspooling

function activateHinge(hingePoint) {
  if (foldingActive) return;
  foldingActive = true;
  hingePoint.activated = true;

  const h = hingePoint.height;

  // Hide the hinge ring
  gsap.to(hingePoint.ring.material, { opacity: 0, duration: 0.3 });
  gsap.to(hingePoint.labelMat, { opacity: 0, duration: 0.3 });

  // Determine fold direction based on hinge height
  const isCCWFold = [6, 3].includes(h); // zig-zag: 6 and 3 fold counter-clockwise
  const rotationTarget = isCCWFold ? -Math.PI + 0.08 : Math.PI - 0.08;
  const hingeJoint = obeliskJointByHeight.get(h);

  // Spawn factor trinket
  const factorNum = h;
  const matType = isPrime(factorNum) ? "prime" : factorNum === 1 ? "mirror" : "composite";
  createTrinket(factorNum, matType);

  if (hingeJoint) {
    if (hingeJoint.setLimits) {
      hingeJoint.setLimits(Math.min(0, rotationTarget), Math.max(0, rotationTarget));
    }
    if (hingeJoint.configureMotorPosition) {
      hingeJoint.configureMotorPosition(rotationTarget, 28, 6);
    }
    if (hingeJoint.configureMotorVelocity) {
      hingeJoint.configureMotorVelocity(isCCWFold ? -6.5 : 6.5, 10);
    }
  }

  const sourceSegment = obeliskSegments[Math.min(obeliskSegments.length - 1, h)];
  if (isPrime(h) && sourceSegment) {
    triggerPrimeDiscovery(h, sourceSegment);
  }

  gsap.delayedCall(0.9, () => {
    playThud();
    cameraShake(0.2, 0.25);
    foldingActive = false;

    // Check if all hinges activated
    if (hingePoints.every((hp) => hp.activated)) {
      foldingComplete = true;
    }
  });
}

async function triggerPrimeDiscovery(primeNumber, segment) {
  const startPos = new THREE.Vector3();
  segment.mesh.getWorldPosition(startPos);

  const cloneMesh = new THREE.Mesh(segment.mesh.geometry.clone(), segment.mesh.material.clone());
  cloneMesh.castShadow = true;
  cloneMesh.receiveShadow = true;
  cloneMesh.position.copy(startPos);
  scene.add(cloneMesh);

  const rbDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(startPos.x, startPos.y, startPos.z);
  const rigidBody = world.createRigidBody(rbDesc);
  rigidBody.setGravityScale(0.0, true);
  rigidBody.setLinearDamping(0.15);
  rigidBody.setAngularDamping(0.35);

  const cd = RAPIER.ColliderDesc.cuboid(CUBE_SIZE / 2, CUBE_SIZE / 2, CUBE_SIZE / 2)
    .setRestitution(0.0)
    .setFriction(0.92)
    .setDensity(1.6);
  world.createCollider(cd, rigidBody);

  bodies.push({ mesh: cloneMesh, rigidBody });

  const slidePromise = autoSlideDex(primeNumber);
  const compressPromise = runCompressionAnimation(cloneMesh, rigidBody);
  await Promise.all([slidePromise, compressPromise]);

  const target = getLandingDropTarget();
  rigidBody.setTranslation(
    {
      x: target.x,
      y: PRIMEDEX_Y + PRIMEDEX_DROP_HEIGHT,
      z: target.z,
    },
    true
  );
  rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  rigidBody.setGravityScale(1.0, true);

  gsap.delayedCall(0.55, () => {
    playThud();
    cameraShake(0.08, 0.12);
  });
}

function runCompressionAnimation(mesh, rigidBody) {
  const start = rigidBody.translation();
  const state = {
    x: start.x,
    y: start.y,
    z: start.z,
    sx: 1,
    sy: 1,
    sz: 1,
  };

  return new Promise((resolve) => {
    const tl = gsap.timeline({
      onUpdate: () => {
        rigidBody.setTranslation({ x: state.x, y: state.y, z: state.z }, true);
        rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        mesh.scale.set(state.sx, state.sy, state.sz);
      },
      onComplete: () => {
        mesh.scale.set(1, 1, 1);
        resolve();
      },
    });

    tl.to(state, {
      y: start.y + 0.85,
      duration: 0.22,
      ease: "power2.out",
    });

    tl.to(
      state,
      {
        x: PRIMEDEX_LANDING_X,
        y: PRIMEDEX_Y + PRIMEDEX_DROP_HEIGHT,
        z: PRIMEDEX_Z,
        duration: 0.72,
        ease: "power2.inOut",
      },
      0.12
    );

    tl.to(
      state,
      {
        sx: 1.25,
        sy: 0.62,
        sz: 1.25,
        duration: 0.2,
        repeat: 1,
        yoyo: true,
        ease: "power2.inOut",
      },
      0.2
    );
  });
}

// ── Reveal Handle (after all folds complete) ─────────────────────────
function revealHandle() {
  // Find the topmost visible segment
  let maxY = -Infinity;
  let topSeg = null;
  for (const seg of obeliskSegments) {
    const worldPos = new THREE.Vector3();
    seg.mesh.getWorldPosition(worldPos);
    if (worldPos.y > maxY) {
      maxY = worldPos.y;
      topSeg = seg;
    }
  }

  if (!topSeg) return;

  // Create a handle on top
  const handleGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.6, 12);
  const handleMat = new THREE.MeshStandardMaterial({
    color: 0x00ff88,
    metalness: 0.9,
    roughness: 0.1,
    emissive: 0x004422,
    emissiveIntensity: 0.5,
  });
  handleMesh = new THREE.Mesh(handleGeo, handleMat);
  handleMesh.castShadow = true;

  const worldPos = new THREE.Vector3();
  topSeg.mesh.getWorldPosition(worldPos);
  handleMesh.position.set(worldPos.x, worldPos.y + CUBE_SIZE / 2 + 0.3, worldPos.z);
  scene.add(handleMesh);

  // Breathing animation
  gsap.to(handleMesh.scale, {
    y: 1.2,
    duration: 1.0,
    repeat: -1,
    yoyo: true,
    ease: "sine.inOut",
  });
  gsap.to(handleMat, {
    emissiveIntensity: 1.2,
    duration: 1.0,
    repeat: -1,
    yoyo: true,
    ease: "sine.inOut",
  });

  // Entry animation
  handleMesh.scale.set(0, 0, 0);
  gsap.to(handleMesh.scale, { x: 1, y: 1, z: 1, duration: 0.5, ease: "back.out(2)" });
}

// ── Unspooling (reverse folding) ─────────────────────────────────────
function startUnspooling() {
  if (foldHistory.length === 0 || foldingActive) return;
  foldingActive = true;

  // Remove handle
  if (handleMesh) {
    gsap.killTweensOf(handleMesh.scale);
    gsap.killTweensOf(handleMesh.material);
    scene.remove(handleMesh);
    handleMesh.geometry.dispose();
    handleMesh.material.dispose();
    handleMesh = null;
  }

  const reverseTl = gsap.timeline({
    onComplete: () => {
      foldingActive = false;
      foldingComplete = false;
      // Reset hinge points
      for (const hp of hingePoints) {
        hp.activated = false;
        hp.ring.material.opacity = 0.3;
      }
      lastInteractionTime = performance.now() / 1000;
    },
  });

  // Reverse each fold in reverse order
  const reversedHistory = [...foldHistory].reverse();
  foldHistory.length = 0;

  for (const record of reversedHistory) {
    const { segsAbove, rotationAngle, pivotY } = record;

    reverseTl.add(() => {
      const pivotGroup = new THREE.Group();
      pivotGroup.position.set(0, pivotY, 0);
      obeliskGroup.add(pivotGroup);

      for (const seg of segsAbove) {
        const worldPos = new THREE.Vector3();
        seg.mesh.getWorldPosition(worldPos);
        obeliskGroup.remove(seg.mesh);
        pivotGroup.add(seg.mesh);
        seg.mesh.position.set(worldPos.x - pivotGroup.position.x - obeliskGroup.position.x, worldPos.y - pivotGroup.position.y - obeliskGroup.position.y, worldPos.z - obeliskGroup.position.z);
      }

      gsap.to(pivotGroup.rotation, {
        x: -rotationAngle,
        duration: 0.6,
        ease: "power2.inOut",
        onComplete: () => {
          for (const seg of segsAbove) {
            const wp = new THREE.Vector3();
            seg.mesh.getWorldPosition(wp);
            pivotGroup.remove(seg.mesh);
            obeliskGroup.add(seg.mesh);
            seg.mesh.position.set(
              wp.x - obeliskGroup.position.x,
              wp.y - obeliskGroup.position.y,
              wp.z - obeliskGroup.position.z
            );
          }
          obeliskGroup.remove(pivotGroup);
          playThud();
          cameraShake(0.1, 0.15);
        },
      });
    });

    reverseTl.add(() => {}, "+=0.7"); // spacing between reverse folds
  }
}

// ── Sync & Render Loop ──────────────────────────────────────────────
const clock = new THREE.Clock();

function loop() {
  requestAnimationFrame(loop);

  const elapsed = clock.getElapsedTime();

  // Step the physics world (fixed timestep)
  world.step();

  // Sync every dynamic body
  for (const { mesh, rigidBody } of bodies) {
    const pos = rigidBody.translation();
    mesh.position.set(pos.x, pos.y, pos.z);

    const rot = rigidBody.rotation();
    mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
  }

  // Update supernova shader time uniforms
  for (const mesh of primeShaderMeshes) {
    if (mesh.material.uniforms && mesh.material.uniforms.uTime) {
      mesh.material.uniforms.uTime.value = elapsed;
    }
  }

  // Update mirror cube camera for '1' block (if it exists)
  if (mirrorCubeCamera && mirrorMesh) {
    mirrorMesh.visible = false;
    mirrorCubeCamera.position.copy(mirrorMesh.position);
    mirrorCubeCamera.update(renderer, scene);
    mirrorMesh.visible = true;
  }

  // Update breathing hints on idle hinges
  updateBreathingHints(elapsed);

  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// ── Resize Handler ──────────────────────────────────────────────────
function onResize() {
  if (!camera || !renderer) return;

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    composer.setSize(window.innerWidth, window.innerHeight);
    if (bloomPass) bloomPass.setSize(window.innerWidth, window.innerHeight);
  }
  compositeScreenSize.w = window.innerWidth;
  compositeScreenSize.h = window.innerHeight;
}

// ── Mobile Initialization (gated behind user gesture) ───────────────
const startBtn = document.getElementById("startBtn");
if (startBtn) {
  startBtn.addEventListener("pointerdown", async () => {
    try {
      // Resume Audio Context for the "Thud" sounds
      if (audioCtx && audioCtx.state === "suspended") {
        await audioCtx.resume();
      }

      // Attempt to initialize the world
      await init();

      // Only remove the button if we successfully reached the loop
      startBtn.style.display = "none";
      console.log("Ignition successful.");
    } catch (err) {
      console.error("Critical Ignition Failure:", err);
      alert("App failed to start. Check console for details.");
    }
  });
}