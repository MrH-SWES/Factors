import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import RAPIER from "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js";

// ── Mobile Debugger ──────────────────────────────────────────────────
window.onerror = function (msg, src, line, col, err) {
  alert("Error: " + msg + "\nSource: " + src + "\nLine: " + line);
};

// ── Globals ──────────────────────────────────────────────────────────
let scene, camera, renderer, world;
let concreteTexture; // shared procedural concrete texture
const bodies = []; // { mesh, rigidBody } pairs for sync

// ── Procedural Concrete Texture ──────────────────────────────────────
function createConcreteTexture(size = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;

  for (let i = 0; i < size * size; i++) {
    const v = 100 + Math.random() * 60; // grayscale range 100–160
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

// ── Bootstrap ────────────────────────────────────────────────────────
async function init() {
  // 1. Rapier WASM initialisation (async/await for mobile WASM memory)
  await RAPIER.init();
  world = new RAPIER.World({ x: 0.0, y: -15.0, z: 0.0 });

  // 2. Three.js scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);

  // Volumetric 'Dust' — dusty cavern feel
  scene.fog = new THREE.FogExp2(0x1a1b1a, 0.02);

  // Generate shared concrete texture
  concreteTexture = createConcreteTexture();

  // 3. Camera — low angle, tilted slightly upward
  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    200
  );
  camera.position.set(0, 5, 20);
  camera.lookAt(0, 6, 0);

  // 4. Renderer with shadows (antialias disabled for mobile performance)
  renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  document.body.appendChild(renderer.domElement);

  // 5. Lighting — 'Holy Grail' vibe
  // Primary spotlight: directly above the altar table
  const altarSpot = new THREE.SpotLight(0xffffff, 500);
  altarSpot.position.set(5, 12, 10);
  altarSpot.target.position.set(0, 1, 6);
  altarSpot.angle = Math.PI / 4;
  altarSpot.penumbra = 0.9;
  altarSpot.decay = 1.0;
  altarSpot.distance = 100;
  altarSpot.castShadow = true;
  altarSpot.shadow.mapSize.width = 512;
  altarSpot.shadow.mapSize.height = 512;
  altarSpot.shadow.camera.near = 1;
  altarSpot.shadow.camera.far = 40;
  scene.add(altarSpot);
  scene.add(altarSpot.target);

  // Secondary spotlight: dimmer, hitting a stage area on the back floor
  const stageSpot = new THREE.SpotLight(0xffffff, 30);
  stageSpot.position.set(0, 18, -15);
  stageSpot.target.position.set(0, 0, -15);
  stageSpot.angle = Math.PI / 4;
  stageSpot.penumbra = 0.8;
  stageSpot.decay = 2;
  stageSpot.distance = 40;
  stageSpot.castShadow = true;
  stageSpot.shadow.mapSize.width = 512;
  stageSpot.shadow.mapSize.height = 512;
  stageSpot.shadow.camera.near = 1;
  stageSpot.shadow.camera.far = 40;
  scene.add(stageSpot);
  scene.add(stageSpot.target);

  // Hemisphere 'bounce' light — simulates light bouncing off concrete floor
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x222222, 0.3);
  scene.add(hemiLight);

  // Rim light behind altar — cool blue/white for edge definition
  const rimLight = new THREE.PointLight(0xe0e0ff, 50);
  rimLight.position.set(0, 3, 3); // slightly behind the altar (altar is at z=6, back wall is further back)
  scene.add(rimLight);

  // 6. Room & Altar
  createRoom();
  createAltar();

  // 7. Events (pointerdown for mobile touch support)
  window.addEventListener("pointerdown", onClickSpawn);
  window.addEventListener("resize", onResize);

  // 8. Start loop
  loop();
}

// ── Room (Brutalist Altar Room) ──────────────────────────────────────
function createRoom() {
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.9,
    metalness: 0.0,
    map: concreteTexture,
    bumpMap: concreteTexture,
    bumpScale: 0.08,
  });

  const roomW = 30; // width  (x)
  const roomH = 20; // height (y)
  const roomD = 40; // depth  (z)
  const thick = 1;  // wall thickness

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
  addStaticBox(roomW, thick, roomD, 0, -thick / 2, 0);

  // Ceiling
  addStaticBox(roomW, thick, roomD, 0, roomH + thick / 2, 0);

  // Back Wall
  addStaticBox(roomW, roomH, thick, 0, roomH / 2, -roomD / 2 + thick / 2);

  // Left Wall
  addStaticBox(thick, roomH, roomD, -roomW / 2 + thick / 2, roomH / 2, 0);

  // Right Wall
  addStaticBox(thick, roomH, roomD, roomW / 2 - thick / 2, roomH / 2, 0);

  // Stage — thin cylinder on the far back floor
  const stageRadius = 4;
  const stageHeight = 0.3;
  const stageGeo = new THREE.CylinderGeometry(stageRadius, stageRadius, stageHeight, 48);
  const stageMesh = new THREE.Mesh(stageGeo, wallMat);
  stageMesh.receiveShadow = true;
  stageMesh.castShadow = false;
  stageMesh.position.set(0, stageHeight / 2, -roomD / 2 + 5);
  scene.add(stageMesh);

  // Rapier collider for the stage cylinder (approximated as a cylinder)
  const stageBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, stageHeight / 2, -roomD / 2 + 5);
  const stageRb = world.createRigidBody(stageBodyDesc);
  const stageCd = RAPIER.ColliderDesc.cylinder(stageHeight / 2, stageRadius)
    .setRestitution(0.0)
    .setFriction(0.8);
  world.createCollider(stageCd, stageRb);
}

// ── Altar Table ──────────────────────────────────────────────────────
function createAltar() {
  const altarW = 8;
  const altarH = 2;
  const altarD = 4;
  const px = 0;
  const py = altarH / 2;
  const pz = 6; // foreground position

  const altarMat = new THREE.MeshStandardMaterial({
    color: 0x1e1e1e,
    roughness: 0.95,
    metalness: 0.0,
    map: concreteTexture,
    bumpMap: concreteTexture,
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

// ── Spawn Block on Click (Soapstone look) ────────────────────────────
function onClickSpawn(event) {
  // Map click X to a horizontal spawn offset above the altar
  const ndcX = (event.clientX / window.innerWidth) * 2 - 1;

  const spawnX = ndcX * 5;
  const spawnY = 14; // drop from height inside the room
  const spawnZ = 6 + (Math.random() - 0.5) * 3; // over the altar area

  const size = 1;
  const halfSize = size / 2;

  // Soapstone material: dark matte #2a2a2a
  const geo = new THREE.BoxGeometry(size, size, size);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.9,
    metalness: 0.0,
    map: concreteTexture,
    bumpMap: concreteTexture,
    bumpScale: 0.08,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Rapier dynamic body – heavy with zero bounciness
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spawnX, spawnY, spawnZ);
  const rigidBody = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.cuboid(
    halfSize,
    halfSize,
    halfSize
  )
    .setRestitution(0.0) // zero bounciness
    .setFriction(0.8)
    .setDensity(10.0);
  world.createCollider(colliderDesc, rigidBody);

  bodies.push({ mesh, rigidBody });
}

// ── Sync & Render Loop ──────────────────────────────────────────────
function loop() {
  requestAnimationFrame(loop);

  // Step the physics world (fixed timestep)
  world.step();

  // Sync every dynamic body
  for (const { mesh, rigidBody } of bodies) {
    const pos = rigidBody.translation();
    mesh.position.set(pos.x, pos.y, pos.z);

    const rot = rigidBody.rotation();
    mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
  }

  renderer.render(scene, camera);
}

// ── Resize Handler ──────────────────────────────────────────────────
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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
