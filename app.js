import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import RAPIER from "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js";

// ── Mobile Debugger ──────────────────────────────────────────────────
window.onerror = function (msg, src, line, col, err) {
  alert("Error: " + msg + "\nSource: " + src + "\nLine: " + line);
};

// ── Globals ──────────────────────────────────────────────────────────
let scene, camera, renderer, world;
let concreteTexture, concreteBumpTexture;
let mirrorCubeCamera, mirrorRenderTarget, mirrorMaterial;
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

let obeliskGroup = null;       // THREE.Group holding the composite obelisk segments
let obeliskSegments = [];      // array of { mesh, heightStart, heightEnd }
let hingePoints = [];          // interactive hinge point objects
let altarTrinkets = [];        // trinkets placed on the altar
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

// ── Procedural Concrete Texture ──────────────────────────────────────
function createConcreteTexture(size = 512) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;

  for (let i = 0; i < size * size; i++) {
    const v = 90 + Math.random() * 50; // temperature-neutral grayscale 90–140
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  return texture;
}

function createConcreteBumpTexture(size = 512) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;

  for (let i = 0; i < size * size; i++) {
    const v = Math.random() * 255; // full-range noise for visible grain
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
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
        vec3 whiteHot = vec3(1.0, 1.0, 0.95);
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

        // Emissive glow intensity
        float glow = max(0.0, 1.0 - dist) * 2.0 + combinedNoise * 0.3;
        color *= (1.0 + glow);

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}

// ── Composite Brushed Aluminum Material ──────────────────────────────
const compositeScreenSize = { w: window.innerWidth, h: window.innerHeight };

function createCompositeMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xc8c8c8,
    metalness: 0.8,
    roughness: 0.4,
    envMap: mirrorRenderTarget.texture,
  });

  // Triple-layer logic via onBeforeCompile:
  // bright specular highlight top-left, subtle shadow bottom-right
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uScreenSize = { value: new THREE.Vector2(compositeScreenSize.w, compositeScreenSize.h) };
    shader.fragmentShader = 'uniform vec2 uScreenSize;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <output_fragment>',
      `
      #include <output_fragment>

      // Triple-Layer: specular highlight (top-left) and shadow (bottom-right)
      vec2 screenUV = gl_FragCoord.xy / uScreenSize;
      float highlightFactor = smoothstep(0.3, 0.9, 1.0 - length(screenUV - vec2(0.2, 0.8)));
      float shadowFactor = smoothstep(0.3, 0.9, 1.0 - length(screenUV - vec2(0.8, 0.2)));
      gl_FragColor.rgb += vec3(0.15) * highlightFactor;
      gl_FragColor.rgb -= vec3(0.08) * shadowFactor;
      `
    );
  };

  return mat;
}

// ── Mirror '1' Material (CubeCamera) ─────────────────────────────────
function getOrCreateMirrorMaterial() {
  if (mirrorMaterial) return mirrorMaterial;

  // Render target and cube camera are created in init(); just build the material
  mirrorMaterial = new THREE.MeshStandardMaterial({
    envMap: mirrorRenderTarget.texture,
    metalness: 1.0,
    roughness: 0.0,
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

  // Volumetric 'Dust' — dusty cavern feel
  scene.fog = new THREE.FogExp2(0x000000, 0.015);

  // Generate shared concrete textures
  concreteTexture = createConcreteTexture();
  concreteBumpTexture = createConcreteBumpTexture();

  // 3. Camera — low-angle, monumental perspective
  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    200
  );
  camera.position.set(0, 6, 25);
  camera.lookAt(0, 2, 0);

  // 4. Renderer with shadows
  renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  document.body.appendChild(renderer.domElement);

  // 5. Shared CubeCamera / RenderTarget (used by mirror '1' and composite envMaps)
  mirrorRenderTarget = new THREE.WebGLCubeRenderTarget(256, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  mirrorCubeCamera = new THREE.CubeCamera(0.1, 100, mirrorRenderTarget);
  scene.add(mirrorCubeCamera);

  // 6. Lighting — No ambient light. Two spotlights only.
  // Primary SpotLight hitting the Altar
  const altarSpot = new THREE.SpotLight(0xffffff, 500);
  altarSpot.position.set(5, 12, 10);
  altarSpot.target.position.set(0, 1, 14);
  altarSpot.angle = Math.PI / 4;
  altarSpot.penumbra = 0.9;
  altarSpot.decay = 1.0;
  altarSpot.distance = 100;
  altarSpot.castShadow = true;
  altarSpot.shadow.mapSize.width = 1024;
  altarSpot.shadow.mapSize.height = 1024;
  altarSpot.shadow.camera.near = 1;
  altarSpot.shadow.camera.far = 50;
  altarSpot.shadow.bias = -0.001;
  scene.add(altarSpot);
  scene.add(altarSpot.target);

  // Secondary SpotLight hitting the background stage
  const stageSpot = new THREE.SpotLight(0xffffff, 200);
  stageSpot.position.set(0, 15, -28);
  stageSpot.target.position.set(0, 0, -10);
  stageSpot.angle = Math.PI / 5;
  stageSpot.penumbra = 0.8;
  stageSpot.decay = 1.5;
  stageSpot.distance = 60;
  stageSpot.castShadow = true;
  stageSpot.shadow.mapSize.width = 1024;
  stageSpot.shadow.mapSize.height = 1024;
  stageSpot.shadow.camera.near = 1;
  stageSpot.shadow.camera.far = 50;
  stageSpot.shadow.bias = -0.001;
  scene.add(stageSpot);
  scene.add(stageSpot.target);

  // 6. Room, Altar & Cold Open
  createRoom();
  createAltar();

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
    color: 0x1a1a1a,
    roughness: 0.92,
    metalness: 0.0,
    map: concreteTexture,
    bumpMap: concreteBumpTexture,
    bumpScale: 0.1,
  });

  const roomW = 30; // width  (x)
  const roomH = 20; // height (y)
  const roomD = 61; // depth  (z) — larger to accommodate z:14 altar and z:-10 stage
  const thick = 1;  // wall thickness
  const roomZCenter = 0; // room centered at z=0

  // Helper: create a static box with mesh + Rapier collider
  function addStaticBox(w, h, d, px, py, pz) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, wallMat);
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

  // Floor
  addStaticBox(roomW, thick, roomD, 0, -thick / 2, roomZCenter);

  // Ceiling
  addStaticBox(roomW, thick, roomD, 0, roomH + thick / 2, roomZCenter);

  // Back Wall
  addStaticBox(roomW, roomH, thick, 0, roomH / 2, roomZCenter - roomD / 2 + thick / 2);

  // Left Wall
  addStaticBox(thick, roomH, roomD, -roomW / 2 + thick / 2, roomH / 2, roomZCenter);

  // Right Wall
  addStaticBox(thick, roomH, roomD, roomW / 2 - thick / 2, roomH / 2, roomZCenter);

  // Stage — thin cylinder at z: -10
  const stageRadius = 4;
  const stageHeight = 0.2;
  const stageGeo = new THREE.CylinderGeometry(stageRadius, stageRadius, stageHeight, 48);
  const stageMesh = new THREE.Mesh(stageGeo, wallMat);
  stageMesh.receiveShadow = true;
  stageMesh.castShadow = true;
  stageMesh.position.set(0, stageHeight / 2, -10);
  scene.add(stageMesh);

  // Rapier collider for the stage cylinder
  const stageBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, stageHeight / 2, -10);
  const stageRb = world.createRigidBody(stageBodyDesc);
  const stageCd = RAPIER.ColliderDesc.cylinder(stageHeight / 2, stageRadius)
    .setRestitution(0.0)
    .setFriction(0.8);
  world.createCollider(stageCd, stageRb);
}

// ── Altar Table (slab on pedestal, foreground at z: 14) ──────────────
function createAltar() {

  const altarMat = new THREE.MeshStandardMaterial({
    color: 0x1e1e1e,
    roughness: 0.95,
    metalness: 0.0,
    map: concreteTexture,
    bumpMap: concreteBumpTexture,
    bumpScale: 0.1,
  });

  const pz = 14; // foreground altar position

  // Pedestal — slightly narrower base
  const pedW = 6;
  const pedH = 1;
  const pedD = 3;
  const pedY = pedH / 2;

  const pedGeo = new THREE.BoxGeometry(pedW, pedH, pedD);
  const pedMesh = new THREE.Mesh(pedGeo, altarMat);
  pedMesh.receiveShadow = true;
  pedMesh.castShadow = true;
  pedMesh.position.set(0, pedY, pz);
  scene.add(pedMesh);

  const pedBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, pedY, pz);
  const pedRb = world.createRigidBody(pedBodyDesc);
  const pedCd = RAPIER.ColliderDesc.cuboid(pedW / 2, pedH / 2, pedD / 2)
    .setRestitution(0.0)
    .setFriction(0.8);
  world.createCollider(pedCd, pedRb);

  // Slab — thick stone slab on top of the pedestal
  const slabW = 8;
  const slabH = 1.5;
  const slabD = 4;
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
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = 55; // deep bass
  gain.gain.setValueAtTime(0.4, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.3);
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
  obeliskGroup = new THREE.Group();
  obeliskGroup.position.set(0, 0, STAGE_Z);
  scene.add(obeliskGroup);

  obeliskSegments = [];

  // Create 12 unit segments
  for (let i = 0; i < NUM_CUBES; i++) {
    const geo = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
    const mat = createCompositeMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(0, baseY + CUBE_SIZE / 2 + i * CUBE_SIZE, 0);
    obeliskGroup.add(mesh);

    obeliskSegments.push({
      mesh,
      index: i,
      heightStart: i,
      heightEnd: i + 1,
    });
  }

  // Anchor bottom segment as fixed Rapier body
  const bottomSeg = obeliskSegments[0];
  const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, baseY + CUBE_SIZE / 2, STAGE_Z);
  const rb = world.createRigidBody(bodyDesc);
  const cd = RAPIER.ColliderDesc.cuboid(CUBE_SIZE / 2, CUBE_SIZE / 2, CUBE_SIZE / 2)
    .setRestitution(0.0)
    .setFriction(0.8);
  world.createCollider(cd, rb);

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
    ring.position.set(0, hingeY, 0);
    obeliskGroup.add(ring);

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
    sprite.position.set(1.2, hingeY, 0);
    obeliskGroup.add(sprite);

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
  const baseY = hingePoint.baseY;

  // Hide the hinge ring
  gsap.to(hingePoint.ring.material, { opacity: 0, duration: 0.3 });
  gsap.to(hingePoint.labelMat, { opacity: 0, duration: 0.3 });

  // Determine which segments are above the hinge
  const segsAbove = obeliskSegments.filter((s) => s.mesh.position.y > baseY + h * CUBE_SIZE - 0.01);

  // Create a pivot group for the fold
  const pivotY = baseY + h * CUBE_SIZE;
  const pivotGroup = new THREE.Group();
  pivotGroup.position.set(0, pivotY, 0);
  obeliskGroup.add(pivotGroup);

  // Reparent segments above hinge into the pivot
  for (const seg of segsAbove) {
    const worldPos = new THREE.Vector3();
    seg.mesh.getWorldPosition(worldPos);
    obeliskGroup.remove(seg.mesh);
    pivotGroup.add(seg.mesh);
    // Adjust position relative to pivot
    seg.mesh.position.set(worldPos.x - pivotGroup.position.x - obeliskGroup.position.x, worldPos.y - pivotGroup.position.y - obeliskGroup.position.y, worldPos.z - obeliskGroup.position.z);
  }

  // Determine fold direction based on hinge height
  // Hinge at 6: CCW (negative rotation around X)
  // Hinge at 4: CCW first, then CW together
  // Hinge at 3: follows zig-zag
  // Hinge at 2: follows zig-zag
  const isCCWFold = [6, 3].includes(h); // zig-zag: 6 and 3 fold counter-clockwise
  const rotationAngle = isCCWFold ? -Math.PI : Math.PI;

  // Spawn factor trinket
  const factorNum = h;
  const matType = isPrime(factorNum) ? "prime" : factorNum === 1 ? "mirror" : "composite";
  createTrinket(factorNum, matType);

  // Animate the fold
  const tl = gsap.timeline({
    onComplete: () => {
      // Reparent segments back
      for (const seg of segsAbove) {
        const worldPos = new THREE.Vector3();
        seg.mesh.getWorldPosition(worldPos);
        pivotGroup.remove(seg.mesh);
        obeliskGroup.add(seg.mesh);
        seg.mesh.position.set(
          worldPos.x - obeliskGroup.position.x,
          worldPos.y - obeliskGroup.position.y,
          worldPos.z - obeliskGroup.position.z
        );
      }
      obeliskGroup.remove(pivotGroup);

      // Material transformation: if the hinge height is prime (2 or 3),
      // transform the folded segments to Supernova material
      if (isPrime(h)) {
        transformToPrime(segsAbove);
      }

      // Record fold for unspooling
      foldHistory.push({
        hingePoint,
        segsAbove: [...segsAbove],
        rotationAngle,
        pivotY,
      });

      foldingActive = false;

      // Check if all hinges activated
      if (hingePoints.every((hp) => hp.activated)) {
        foldingComplete = true;
        revealHandle();
      }
    },
  });

  tl.to(pivotGroup.rotation, {
    x: rotationAngle,
    duration: 0.8,
    ease: "power2.inOut",
    onComplete: () => {
      playThud();
      cameraShake(0.2, 0.25);
    },
  });
}

// ── Material Transformation to Supernova ─────────────────────────────
function transformToPrime(segments) {
  const reusableVec = new THREE.Vector3();
  for (const seg of segments) {
    const oldMat = seg.mesh.material;
    seg.mesh.material = createPrimeMaterial();
    primeShaderMeshes.push(seg.mesh);

    // Add point light for glow
    const pl = new THREE.PointLight(0xff6600, 15, 6, 2);
    seg.mesh.add(pl);

    // Flash effect
    seg.mesh.getWorldPosition(reusableVec);
    createFlash(reusableVec.clone());

    if (oldMat.dispose) oldMat.dispose();
  }
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

  renderer.render(scene, camera);
}

// ── Resize Handler ──────────────────────────────────────────────────
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  compositeScreenSize.w = window.innerWidth;
  compositeScreenSize.h = window.innerHeight;
}

// ── Mobile Initialization (gated behind user gesture) ───────────────
const startBtn = document.getElementById("startBtn");
if (startBtn) {
  startBtn.addEventListener("pointerdown", async () => {
    startBtn.remove();
    await init();
  });
} else {
  init();
}
