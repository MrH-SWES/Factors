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
let spawnCounter = 0; // tracks next number to spawn

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
    metalness: 0.9,
    roughness: 0.4,
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

  mirrorRenderTarget = new THREE.WebGLCubeRenderTarget(256, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  mirrorCubeCamera = new THREE.CubeCamera(0.1, 100, mirrorRenderTarget);
  scene.add(mirrorCubeCamera);

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
  scene.fog = new THREE.FogExp2(0x1a1b1a, 0.015);

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

  // 5. Lighting — No ambient light. Two spotlights only.
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

  // 6. Room, Altar & Stage Obelisk
  createRoom();
  createAltar();
  createObelisk();

  // 7. Events (pointerdown for mobile touch support)
  window.addEventListener("pointerdown", onClickSpawn);
  window.addEventListener("resize", onResize);

  // 8. Start loop
  loop();
}

// ── Room (Brutalist Concrete) ────────────────────────────────────────
function createRoom() {
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.92,
    metalness: 0.0,
    map: concreteTexture,
    bumpMap: concreteBumpTexture,
    bumpScale: 0.08,
  });

  const roomW = 30; // width  (x)
  const roomH = 20; // height (y)
  const roomD = 60; // depth  (z) — larger to accommodate z:14 altar and z:-10 stage
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
  const stageHeight = 0.3;
  const stageGeo = new THREE.CylinderGeometry(stageRadius, stageRadius, stageHeight, 48);
  const stageMesh = new THREE.Mesh(stageGeo, wallMat);
  stageMesh.receiveShadow = true;
  stageMesh.castShadow = false;
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

// ── Altar Table (Foreground at z: 14) ────────────────────────────────
function createAltar() {
  const altarW = 8;
  const altarH = 2;
  const altarD = 4;
  const px = 0;
  const py = altarH / 2;
  const pz = 14; // foreground altar position

  const altarMat = new THREE.MeshStandardMaterial({
    color: 0x1e1e1e,
    roughness: 0.95,
    metalness: 0.0,
    map: concreteTexture,
    bumpMap: concreteBumpTexture,
    bumpScale: 0.08,
  });

  const geo = new THREE.BoxGeometry(altarW, altarH, altarD);
  const mesh = new THREE.Mesh(geo, altarMat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.position.set(px, py, pz);
  scene.add(mesh);

  const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(px, py, pz);
  const rb = world.createRigidBody(bodyDesc);
  const cd = RAPIER.ColliderDesc.cuboid(altarW / 2, altarH / 2, altarD / 2)
    .setRestitution(0.0)
    .setFriction(0.8);
  world.createCollider(cd, rb);
}

// ── Primary Obelisk on Stage ─────────────────────────────────────────
function createObelisk() {
  const obeliskMat = new THREE.MeshStandardMaterial({
    color: 0x222222,
    roughness: 0.85,
    metalness: 0.05,
    map: concreteTexture,
    bumpMap: concreteBumpTexture,
    bumpScale: 0.08,
  });

  // Tapered obelisk shape using a cylinder with a smaller top radius
  const geo = new THREE.CylinderGeometry(0.4, 1.0, 6, 4);
  const mesh = new THREE.Mesh(geo, obeliskMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set(0, 3.3, -10); // sits on stage at z:-10
  mesh.rotation.y = Math.PI / 4; // rotate 45° for diamond cross-section
  scene.add(mesh);
}

// ── Spawn Block on Click (Trinkets / Factors) ────────────────────────
function onClickSpawn(event) {
  // Increment the spawn counter
  spawnCounter++;
  const num = spawnCounter;

  // Map click X to a horizontal spawn offset above the altar
  const ndcX = (event.clientX / window.innerWidth) * 2 - 1;

  const spawnX = ndcX * 5;
  const spawnY = 14; // drop from height inside the room
  const spawnZ = 14 + (Math.random() - 0.5) * 3; // over the altar area (altar at z:14)

  const size = 1;
  const halfSize = size / 2;

  const geo = new THREE.BoxGeometry(size, size, size);
  let mat;
  let pointLight = null;

  if (num === 1) {
    // ── '1' — Mirror Cube (CubeCamera real-time env map) ──
    mat = getOrCreateMirrorMaterial();
  } else if (isPrime(num)) {
    // ── Prime — Supernova ShaderMaterial ──
    mat = createPrimeMaterial();
  } else {
    // ── Composite — Brushed Aluminum ──
    mat = createCompositeMaterial();
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Track the '1' mirror mesh explicitly
  if (num === 1) {
    mirrorMesh = mesh;
  }

  // Add PointLight inside prime blocks for glow
  if (num > 1 && isPrime(num)) {
    pointLight = new THREE.PointLight(0xff6600, 30, 8, 2);
    mesh.add(pointLight);
  }

  // Track supernova shader meshes for time uniform updates
  if (num > 1 && isPrime(num)) {
    primeShaderMeshes.push(mesh);
  }

  // Rapier dynamic body – heavy with zero bounciness, solid 'dead thud'
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spawnX, spawnY, spawnZ);
  const rigidBody = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.cuboid(
    halfSize,
    halfSize,
    halfSize
  )
    .setRestitution(0.0)
    .setFriction(0.8)
    .setDensity(10.0);
  world.createCollider(colliderDesc, rigidBody);

  bodies.push({ mesh, rigidBody, pointLight });
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
