import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import RAPIER from "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js";

// ── Globals ──────────────────────────────────────────────────────────
let scene, camera, renderer, world;
const bodies = []; // { mesh, rigidBody } pairs for sync

// ── Bootstrap ────────────────────────────────────────────────────────
async function init() {
  // 1. Rapier WASM initialisation
  await RAPIER.init();
  world = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });

  // 2. Three.js scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1b1a);

  // 3. Camera
  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    200
  );
  camera.position.set(0, 12, 20);
  camera.lookAt(0, 0, 0);

  // 4. Renderer with shadows
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  // 5. Lighting — top-down directional light
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 20, 5);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 60;
  dirLight.shadow.camera.left = -20;
  dirLight.shadow.camera.right = 20;
  dirLight.shadow.camera.top = 20;
  dirLight.shadow.camera.bottom = -20;
  scene.add(dirLight);

  // Subtle ambient fill so shadows aren't pitch-black
  scene.add(new THREE.AmbientLight(0x404040, 0.6));

  // 6. Ground
  createGround();

  // 7. Events
  window.addEventListener("click", onClickSpawn);
  window.addEventListener("resize", onResize);

  // 8. Start loop
  loop();
}

// ── Ground ───────────────────────────────────────────────────────────
function createGround() {
  const width = 40;
  const height = 1;
  const depth = 40;

  // Three.js mesh
  const geo = new THREE.BoxGeometry(width, height, depth);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2b2a });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.position.set(0, -0.5, 0);
  scene.add(mesh);

  // Rapier static body (fixed)
  const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0);
  const rigidBody = world.createRigidBody(bodyDesc);
  const colliderDesc = RAPIER.ColliderDesc.cuboid(
    width / 2,
    height / 2,
    depth / 2
  ).setRestitution(0.1);
  world.createCollider(colliderDesc, rigidBody);
}

// ── Spawn Block on Click ─────────────────────────────────────────────
function onClickSpawn(event) {
  // Map click X to a horizontal spawn offset across the ground
  const ndcX = (event.clientX / window.innerWidth) * 2 - 1;

  // Spawn above the camera look-target with a slight horizontal offset
  const spawnX = ndcX * 8; // spread across the ground
  const spawnY = 15; // drop from height
  const spawnZ = (Math.random() - 0.5) * 6;

  const size = 1;
  const halfSize = size / 2;

  // Three.js mesh
  const hue = Math.random();
  const color = new THREE.Color().setHSL(hue, 0.5, 0.35);
  const geo = new THREE.BoxGeometry(size, size, size);
  const mat = new THREE.MeshStandardMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Rapier dynamic body – heavy with low bounciness
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spawnX, spawnY, spawnZ);
  const rigidBody = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.cuboid(
    halfSize,
    halfSize,
    halfSize
  )
    .setRestitution(0.1) // low bounce
    .setFriction(0.8)
    .setDensity(10.0); // high density for a heavy "thud" feel
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

// ── Go ──────────────────────────────────────────────────────────────
init();
