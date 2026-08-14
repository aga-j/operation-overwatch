import * as THREE from 'three';

// ----- shared scratch vectors (module scope; single-file module, modest usage) -----
const _tmpMuzzle = new THREE.Vector3();
const _tmpDir = new THREE.Vector3();
const _tmpMid = new THREE.Vector3();
const _tmpFar = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Vector3(0, 0, 0);
// Round 5: shell-ejection scratch vectors (module scope, no per-shot alloc)
const _tmpPort = new THREE.Vector3();
const _tmpLeft = new THREE.Vector3();
const _tmpUp = new THREE.Vector3();
const _tmpVel = new THREE.Vector3();

/**
 * First-person assault rifle built entirely from primitive meshes.
 * The view model is parented to the camera so it tracks the player's view.
 */
export class Rifle {
  constructor(camera, scene, sfx = null) {
    this.camera = camera;
    this.scene = scene;
    this._sfx = sfx; // optional Round 5 synth SFX (null in headless/demo)

    // ---- magazine / ammo state (read by HUD) ----
    this.magSize = 30;
    this.ammo = 30;
    this.reserve = 120;
    this.reloading = false;

    // ---- timing ----
    this.fireRate = 0.095;      // seconds between auto shots
    this.reloadTime = 2.0;      // seconds for a full reload
    this._fireCooldown = 0;     // counts down to 0 when ready
    this._reloadTimer = 0;      // counts down during reload

    // ---- view model ----
    this.viewModel = new THREE.Group();
    // z=-0.62 (was -0.38): stock pieces live at local z≈+0.48, so their camera-space
    // z is -0.62 + 0.48 = -0.14, just past the near plane (0.1). Previously z=-0.38
    // put the stock at camera z≈+0.10, *behind* the camera, clipping it out entirely.
    this.viewModel.position.set(0.28, -0.24, -0.62);
    this.viewModel.rotation.set(-0.03, 0.05, 0.0);
    camera.add(this.viewModel);

    // rest pose so we can spring/dip back to it
    this._restPos = this.viewModel.position.clone();
    this._restRot = this.viewModel.rotation.clone();

    // recoil offsets applied on top of the rest pose (decayed each frame)
    this._recoilPos = new THREE.Vector3();
    this._recoilRot = new THREE.Euler();

    // ---- shared resources (reused across shots) ----
    this._initShared();

    // ---- persistent muzzle flash + light (created ONCE, never added/removed
    //      per shot, so NUM_POINT_LIGHTS never changes → no material recompile) ----
    this._muzzleLight = new THREE.PointLight(0xffd27a, 0, 6);
    this.scene.add(this._muzzleLight);

    this._muzzleFlash = new THREE.Sprite(this._flashSpriteMat);
    this._muzzleFlash.visible = false;
    this.scene.add(this._muzzleFlash);

    // tiny smoke puff (WPN-4 optional) — same persistent-sprite pattern
    this._muzzleSmoke = new THREE.Sprite(this._smokeSpriteMat);
    this._muzzleSmoke.visible = false;
    this.scene.add(this._muzzleSmoke);
    this._smokeLife = 0;
    this._smokeMax = 0.1;

    this._flashLife = 0;
    this._flashMax = 0.04;
    this._flashBase = 1;

    // ---- build the gun ----
    this._build();

    // muzzle anchor: a child Object3D at the barrel tip,
    // queried for its WORLD position each shot via localToWorld.
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.012, -0.71);
    this.viewModel.add(this.muzzle);

    // Round 5: ejection-port anchor — brass shells fly out of here on fire.
    this.ejectPort = new THREE.Object3D();
    this.ejectPort.position.set(-0.046, 0.02, -0.02);
    this.viewModel.add(this.ejectPort);

    // active transient effects (muzzle flashes, tracers, impacts)
    this._effects = [];

    // Round 5: brass-shell object pool is built inside _initShared() above.
  }

  // ---------------------------------------------------------------- resources
  _initShared() {
    // quality materials
    this._matGunmetal = new THREE.MeshStandardMaterial({
      color: 0x2a2d31, metalness: 0.85, roughness: 0.35,
    });
    this._matGunmetalWorn = new THREE.MeshStandardMaterial({
      color: 0x33373c, metalness: 0.8, roughness: 0.5,
    });
    this._matPlastic = new THREE.MeshStandardMaterial({
      color: 0x1b1d20, metalness: 0.1, roughness: 0.7,
    });
    this._matSight = new THREE.MeshStandardMaterial({
      color: 0x14161a, metalness: 0.6, roughness: 0.4,
    });
    // dark recessed material for ejection port / interior details
    this._matDark = new THREE.MeshStandardMaterial({
      color: 0x050506, metalness: 0.3, roughness: 0.9,
    });
    // tactical-glove / skin material for the two hand meshes (P1#15)
    this._matGlove = new THREE.MeshStandardMaterial({
      color: 0x2a2218, metalness: 0.1, roughness: 0.6,
    });
    // WPN-1: polymer frame material — slight metallic sheen so the gun reads
    // as metal/polymer, not flat plastic toy.
    this._matPolymer = new THREE.MeshStandardMaterial({
      color: 0x23262b, metalness: 0.3, roughness: 0.55,
    });
    // brighter polished metal for moving/detail parts (bolt, rail teeth, latch)
    this._matMetalBright = new THREE.MeshStandardMaterial({
      color: 0x3c4046, metalness: 0.9, roughness: 0.25,
    });

    // additive effects materials / geometries (shared)
    // muzzle flash: a billboard Sprite with a canvas-generated additive map,
    // so it reads as a flash from any camera angle.
    this._flashSpriteMat = new THREE.SpriteMaterial({
      map: this._makeFlashTexture(),
      color: 0xffd27a,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // tiny smoke puff (0.1s) on fire — WPN-4 optional
    this._smokeSpriteMat = new THREE.SpriteMaterial({
      map: this._makeSmokeTexture(),
      color: 0xbdbdbd,
      transparent: true,
      opacity: 0,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });

    this._sparkGeo = new THREE.PlaneGeometry(0.12, 0.12);
    this._sparkMatBase = new THREE.MeshBasicMaterial({
      color: 0xffb060, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._tracerGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6, 1, true);
    this._tracerMatBase = new THREE.MeshBasicMaterial({
      color: 0xbfe8ff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    // Round 5: brass shell pool. One shared geometry + material so recycling
    // shells never changes the render/material set (no shader recompile).
    this._shellGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.03, 8);
    this._shellGeo.rotateX(Math.PI / 2); // lie along z so it reads as a casing
    this._shellMat = new THREE.MeshStandardMaterial({
      color: 0xd9a441, metalness: 0.9, roughness: 0.3,
    });
    this._shellFree = [];
    this._shells = [];
    const SHELL_POOL = 28;
    for (let i = 0; i < SHELL_POOL; i++) {
      const sh = new THREE.Mesh(this._shellGeo, this._shellMat);
      sh.visible = false;
      this.scene.add(sh);
      this._shellFree.push(sh);
    }

    // Round 7: blood-splatter pool (shared geo + material → no recompile).
    // Droplets fall with gravity and shrink; a faint red puff sells the impact.
    this._bloodGeo = new THREE.SphereGeometry(0.012, 6, 4);
    this._bloodMat = new THREE.MeshBasicMaterial({ color: 0x6e0d0d });
    this._bloodFree = [];
    this._bloods = [];
    const BLOOD_POOL = 40;
    for (let i = 0; i < BLOOD_POOL; i++) {
      const b = new THREE.Mesh(this._bloodGeo, this._bloodMat);
      b.visible = false;
      this.scene.add(b);
      this._bloodFree.push(b);
    }
    this._bloodPuffMat = new THREE.SpriteMaterial({
      map: this._makeBloodTexture(),
      color: 0xc01818,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });

    // ---- Round 9: persistent bullet holes + impact dust --------------------
    // Rounds used to leave nothing behind — a 0.08s spark and the wall was
    // pristine again. Now every surface hit stamps a pooled decal (FIFO, so the
    // oldest hole is recycled) and kicks up an expanding dust puff. One shared
    // geometry + one shared material for the decals, one shared texture for the
    // dust sprites: no per-shot allocation, no shader recompiles.
    this._decalGeo = new THREE.PlaneGeometry(0.17, 0.17);
    this._decalMat = new THREE.MeshBasicMaterial({
      map: this._makeHoleTexture(),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this._decalPool = [];
    this._decalIdx = 0;
    const DECAL_POOL = 32;
    for (let i = 0; i < DECAL_POOL; i++) {
      const d = new THREE.Mesh(this._decalGeo, this._decalMat);
      d.visible = false;
      d.renderOrder = 3;
      this.scene.add(d);
      this._decalPool.push(d);
    }

    const dustTex = this._makeSmokeTexture();
    this._dustFree = [];
    this._dusts = [];
    const DUST_POOL = 14;
    for (let i = 0; i < DUST_POOL; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: dustTex,
        color: 0xbdb29a, // dusty sand, matches the arena palette
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }));
      s.visible = false;
      this.scene.add(s);
      this._dustFree.push(s);
    }
  }

  // ------------------------------------------------- bullet-hole texture
  // A dark pit with a lighter cratered rim and a few radial cracks, so the
  // decal reads as punched material rather than a flat black dot.
  _makeHoleTexture() {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2;
    // blown-out lighter rim
    const rim = ctx.createRadialGradient(cx, cx, size * 0.12, cx, cx, cx);
    rim.addColorStop(0.0, 'rgba(150,138,116,0.75)');
    rim.addColorStop(0.55, 'rgba(120,110,92,0.30)');
    rim.addColorStop(1.0, 'rgba(120,110,92,0)');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(cx, cx, cx, 0, Math.PI * 2);
    ctx.fill();
    // dark pit
    const pit = ctx.createRadialGradient(cx, cx, 0, cx, cx, size * 0.2);
    pit.addColorStop(0.0, 'rgba(12,10,8,0.95)');
    pit.addColorStop(0.7, 'rgba(20,17,13,0.8)');
    pit.addColorStop(1.0, 'rgba(30,26,20,0)');
    ctx.fillStyle = pit;
    ctx.beginPath();
    ctx.arc(cx, cx, size * 0.2, 0, Math.PI * 2);
    ctx.fill();
    // radial spall cracks
    ctx.strokeStyle = 'rgba(28,24,18,0.5)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2;
      const len = size * (0.2 + Math.random() * 0.2);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * size * 0.16, cx + Math.sin(a) * size * 0.16);
      ctx.lineTo(cx + Math.cos(a) * len, cx + Math.sin(a) * len);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  // ----------------------------------------------------- blood texture (canvas)
  _makeBloodTexture() {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2;
    const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    g.addColorStop(0.0, 'rgba(180,24,24,0.95)');
    g.addColorStop(0.5, 'rgba(120,12,12,0.5)');
    g.addColorStop(1.0, 'rgba(90,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  // Round 7: spawn a blood burst at a world point — a fading red puff plus a
  // short-lived cluster of droplets that fly out and fall under gravity.
  _spawnBlood(point) {
    const puffMat = this._bloodPuffMat.clone();
    const puff = new THREE.Sprite(puffMat);
    puff.position.copy(point);
    puff.scale.setScalar(0.14);
    this.scene.add(puff);
    this._effects.push({ kind: 'bloodpuff', obj: puff, life: 0.4, max: 0.4 });

    for (let i = 0; i < 10 && this._bloodFree.length; i++) {
      const b = this._bloodFree.pop();
      b.position.copy(point);
      b.scale.setScalar(1);
      b.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      const v = new THREE.Vector3(
        (Math.random() - 0.5) * 3.2,
        Math.random() * 2.2 + 0.6,
        (Math.random() - 0.5) * 3.2
      );
      b.visible = true;
      this._bloods.push({ obj: b, vel: v, life: 0.6 + Math.random() * 0.3 });
    }
  }

  // Round 5: spawn a single brass casing from the ejection port. Reused from a
  // fixed pool; physics integrated in update().
  _ejectShell() {
    if (!this._shellFree.length) return;
    const sh = this._shellFree.pop();
    this.ejectPort.getWorldPosition(_tmpPort);
    sh.position.copy(_tmpPort);

    // velocity: out to the shooter's LEFT and UP (ejectPort is on the left side
    // of the receiver), with a little forward/back jitter.
    _tmpLeft.set(-1, 0, 0).applyQuaternion(this.camera.quaternion);
    _tmpUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    _tmpVel.copy(_tmpLeft).multiplyScalar(2.4 + Math.random() * 0.8);
    _tmpVel.addScaledVector(_tmpUp, 1.4 + Math.random() * 0.7);
    _tmpVel.x += (Math.random() - 0.5) * 0.6;
    _tmpVel.y += (Math.random() - 0.5) * 0.4;
    _tmpVel.z += (Math.random() - 0.5) * 0.6;

    sh.visible = true;
    sh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    this._shells.push({
      obj: sh,
      vel: _tmpVel.clone(),
      av: new THREE.Vector3((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18),
      life: 1.6,
    });
  }

  // ------------------------------------------------------- flash texture (canvas)
  _makeFlashTexture() {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;

    // small bright core (no big soft blob obscuring the barrel)
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.16);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,224,160,0.9)');
    g.addColorStop(1.0, 'rgba(255,150,50,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.16, 0, Math.PI * 2);
    ctx.fill();

    // asymmetric star with directional spikes (one long spike + shorter ones)
    const spikes = [
      { a: -Math.PI / 2, len: size * 0.5 },   // long forward spike (up)
      { a: -Math.PI / 2 + 0.55, len: size * 0.3 },
      { a: -Math.PI / 2 - 0.55, len: size * 0.3 },
      { a: Math.PI / 2, len: size * 0.22 },
      { a: Math.PI, len: size * 0.2 },
      { a: 0, len: size * 0.2 },
    ];
    ctx.strokeStyle = 'rgba(255,232,184,0.9)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const s of spikes) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(s.a) * s.len, cy + Math.sin(s.a) * s.len);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  // ------------------------------------------------------- smoke texture (canvas)
  _makeSmokeTexture() {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2;
    const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    g.addColorStop(0, 'rgba(200,200,200,0.55)');
    g.addColorStop(1, 'rgba(180,180,180,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  // ------------------------------------------------------------------- build
  _build() {
    const vm = this.viewModel;
    const M = this._matGunmetal;
    const MW = this._matGunmetalWorn;
    const MP = this._matPlastic;

    // Round 7: charging-handle group — both the handle cylinder (below) and its
    // T-latch (in _addGunDetails) are parented here so the reload animation can
    // pull the whole handle back and snap it forward as one unit.
    this._chargeGroup = new THREE.Group();
    vm.add(this._chargeGroup);

    // Receiver (main body) — P0#4: lowered height, slightly lengthened along z.
    const receiver = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.085, 0.5), M
    );
    receiver.position.set(0, 0, 0.0);
    vm.add(receiver);

    // Top rail — sits on the lowered receiver; lengthened to match.
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.025, 0.42), MW
    );
    rail.position.set(0, 0.058, 0.0);
    vm.add(rail);

    // Handguard — P0#4: CURVED, slightly tapered tube (top radius < bottom),
    // open-ended, axis horizontal along z. Top radius 0.045 (rear), bottom
    // 0.055 (front/muzzle).
    const hgGeo = new THREE.CylinderGeometry(0.032, 0.04, 0.19, 8, 1, true);
    hgGeo.rotateX(Math.PI / 2); // axis -> z; +y end (radiusTop) maps to +z (rear)
    const handguard = new THREE.Mesh(hgGeo, this._matPolymer);
    handguard.position.set(0, 0.012, -0.40);
    vm.add(handguard);

    // Barrel (thin cylinder, lies along -Z)
    const barrelGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.5, 12);
    barrelGeo.rotateX(Math.PI / 2);
    const barrel = new THREE.Mesh(barrelGeo, M);
    barrel.position.set(0, 0.012, -0.45);
    vm.add(barrel);

    // P0#4 — Front sight post: taller than the receiver rail, tiny vertical
    // box on top of the receiver near the barrel.
    const frontSight = new THREE.Mesh(
      new THREE.BoxGeometry(0.025, 0.04, 0.01), MW
    );
    frontSight.position.set(0, 0.09, -0.2);
    vm.add(frontSight);

    // Magazine (WPN-3): tapered, slightly curved profile built as a group so
    // the reload animation can drop it as one unit. 4-sided prism with soft
    // edges reads as a curved banana mag; scaled to width/depth of the STANAG.
    const magGroup = new THREE.Group();
    magGroup.position.set(0, -0.135, -0.02);
    magGroup.rotation.x = 0.28;

    const magBodyGeo = new THREE.CylinderGeometry(0.03, 0.035, 0.17, 4, 1);
    magBodyGeo.rotateY(Math.PI / 4); // flat faces front/back
    const magBody = new THREE.Mesh(magBodyGeo, this._matPolymer);
    magBody.scale.set(1.0, 1, 1.25); // width ~0.05, depth ~0.0625
    magGroup.add(magBody);

    // vertical ribs on the front face (+z in mag-local)
    const ribGeo = new THREE.BoxGeometry(0.006, 0.13, 0.006);
    for (let i = 0; i < 4; i++) {
      const rx = -0.015 + i * 0.01;
      const rib = new THREE.Mesh(ribGeo, this._matPolymer);
      rib.position.set(rx, 0.0, 0.046);
      magGroup.add(rib);
    }
    // base plate (wider short box at the bottom)
    const basePlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.02, 0.07), MW
    );
    basePlate.position.set(0, -0.088, 0);
    magGroup.add(basePlate);

    vm.add(magGroup);
    this._magMesh = magGroup;
    this._magBaseY = magGroup.position.y;

    // Pistol grip (angled back)
    const grip = new THREE.Mesh(
      new THREE.BoxGeometry(0.045, 0.12, 0.06), this._matPolymer
    );
    grip.position.set(0, -0.12, 0.12);
    grip.rotation.x = -0.32;
    vm.add(grip);
    this._gripMesh = grip;

    // P0#4 — Stock: 3 progressively smaller angled boxes going from the
    // receiver back toward camera-right-bottom, reading as a shoulder-stock
    // silhouette instead of one big box.
    const stockA = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.09), MP);
    stockA.position.set(0.0, -0.005, 0.30);
    stockA.rotation.x = 0.12;
    vm.add(stockA);

    const stockB = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.07, 0.09), MP);
    stockB.position.set(0.03, -0.03, 0.40);
    stockB.rotation.set(0.16, 0, -0.10);
    vm.add(stockB);

    const stockC = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.05), MP);
    stockC.position.set(0.06, -0.06, 0.48);
    stockC.rotation.set(0.22, 0, -0.14);
    vm.add(stockC);

    // Stock tube connecting receiver to stock
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.2, 8), MW
    );
    tube.rotation.x = Math.PI / 2;
    tube.position.set(0, -0.005, 0.22);
    vm.add(tube);

    // Round 4: holographic-style sight (large housing + dark lens plane + small
    // emissive reticle). Reads as an EOTech/holo sight, not the small reflex
    // housing from earlier rounds. Mounted on the top rail, lens centered.
    const sightHousing = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, 0.06, 0.10), this._matSight
    );
    sightHousing.position.set(0, 0.105, -0.06);
    vm.add(sightHousing);

    // dark recessed lens (circular plane facing back toward the camera)
    const lensGeo = new THREE.CircleGeometry(0.028, 24);
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0x080a0d, metalness: 0.2, roughness: 0.35,
      emissive: 0x000000,
    });
    const lens = new THREE.Mesh(lensGeo, lensMat);
    lens.rotation.y = Math.PI;       // face the camera (-Z direction in view-local)
    lens.position.set(0, 0.105, -0.111); // just in front of housing back face
    vm.add(lens);

    // red dot reticle — a tiny emissive sphere at the lens center
    const reticleGeo = new THREE.SphereGeometry(0.0035, 8, 6);
    const reticleMat = new THREE.MeshBasicMaterial({ color: 0xff2a18 });
    const reticle = new THREE.Mesh(reticleGeo, reticleMat);
    reticle.position.set(0, 0.105, -0.1115);
    vm.add(reticle);

    // small power LED on the housing side (faint red glow)
    const ledGeo = new THREE.SphereGeometry(0.003, 6, 4);
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xff4030 });
    const led = new THREE.Mesh(ledGeo, ledMat);
    led.position.set(0.038, 0.11, -0.10);
    vm.add(led);

    // P0#7 — the always-on emissive red dot is removed (no ADS mode); the 2D
    // HUD crosshair is the only reticle now. Sight housing (sightBody) kept.

    // ---- P0#4 detail parts ----

    // Rear iron sight: small box near the back of the rail + a recessed dark
    // notch box on its top face.
    const rearSight = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.025, 0.02), MW
    );
    rearSight.position.set(0, 0.0825, 0.18);
    vm.add(rearSight);
    const rearNotch = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, 0.01, 0.012), this._matDark
    );
    rearNotch.position.set(0, 0.096, 0.18);
    vm.add(rearNotch);

    // Charging handle: small cylinder protruding from the upper rear of the
    // receiver (lies along X).
    const charge = new THREE.Mesh(
      new THREE.CylinderGeometry(0.011, 0.011, 0.07, 8), MW
    );
    charge.rotation.z = Math.PI / 2;
    charge.position.set(0, 0.06, 0.21);
    this._chargeGroup.add(charge);

    // ---- P2#26: trigger guard as an angular half-torus (stamped-metal U) ----
    // Geometry pre-rotated so the semicircle opens upward (finger inserts from
    // the top). Torus arc spans 0..PI; rotateY puts axis along X, rotateX(PI)
    // flips the upper half to a lower U.
    const guardGeo = new THREE.TorusGeometry(0.04, 0.016, 8, 16, Math.PI);
    guardGeo.rotateY(Math.PI / 2);
    guardGeo.rotateX(Math.PI);
    const guard = new THREE.Mesh(guardGeo, M);
    guard.position.set(0, -0.075, 0.02);
    vm.add(guard);

    // P2#27 — Muzzle brake / flash hider: a slightly wider short cylinder
    // sitting FLUSH at the muzzle end.
    const brakeGeo = new THREE.CylinderGeometry(0.024, 0.024, 0.045, 12);
    brakeGeo.rotateX(Math.PI / 2);
    const brake = new THREE.Mesh(brakeGeo, M);
    brake.position.set(0, 0.012, -0.69);
    vm.add(brake);

    // P2#27 — Four compensator vent notches around the brake at 0/90/180/270.
    const ventGeo = new THREE.BoxGeometry(0.008, 0.012, 0.014);
    const ventR = 0.026;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const vent = new THREE.Mesh(ventGeo, MW);
      vent.position.set(
        Math.cos(a) * ventR,
        0.012 + Math.sin(a) * ventR,
        -0.705
      );
      vm.add(vent);
    }

    // Fire selector: tiny box on the right side of the receiver.
    const selector = new THREE.Mesh(
      new THREE.BoxGeometry(0.014, 0.022, 0.012), M
    );
    selector.position.set(0.05, -0.03, 0.04);
    vm.add(selector);

    // Ejection port: dark recessed box on the left side of the receiver.
    const port = new THREE.Mesh(
      new THREE.BoxGeometry(0.006, 0.05, 0.13), this._matDark
    );
    port.position.set(-0.046, 0.015, -0.05);
    vm.add(port);

    // Sling loop: small torus at the rear of the stock.
    const slingLoop = new THREE.Mesh(
      new THREE.TorusGeometry(0.02, 0.006, 6, 14), MW
    );
    slingLoop.rotation.x = Math.PI / 2;
    slingLoop.position.set(0.06, 0.0, 0.5);
    vm.add(slingLoop);

    // ---- WPN-1: surface detail (rail slots, panel lines, bolt, grip texture) ----
    this._addGunDetails();

    // ---- P1#15: two low-detail hand meshes so the gun reads as held ----
    this._buildHands();
  }

  // --------------------------------------------------- WPN-1 surface detail
  _addGunDetails() {
    const vm = this.viewModel;
    const MW = this._matGunmetalWorn;
    const D = this._matDark;
    const MB = this._matMetalBright;

    // ---- handguard top rail: picatinny base strip + repeated teeth (slots
    //      are the gaps between teeth) ----
    const railBase = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.012, 0.2), MW);
    railBase.position.set(0, 0.064, -0.40);
    vm.add(railBase);
    const teeth = 9;
    for (let i = 0; i < teeth; i++) {
      const tz = -0.49 + (i / (teeth - 1)) * 0.18;
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.014, 0.016), MB);
      tooth.position.set(0, 0.072, tz);
      vm.add(tooth);
    }

    // ---- handguard MLOK slots: dark insets on right / left / bottom ----
    const slotGeo = new THREE.BoxGeometry(0.014, 0.005, 0.022);
    const r = 0.036;
    for (const z of [-0.34, -0.46]) {
      for (const ang of [0, Math.PI, -Math.PI / 2]) {
        const slot = new THREE.Mesh(slotGeo, D);
        slot.position.set(
          Math.cos(ang) * r,
          0.012 + Math.sin(ang) * r,
          z
        );
        slot.rotation.z = ang + Math.PI / 2;
        vm.add(slot);
      }
    }

    // ---- receiver panel lines (thin inset boxes on the sides) ----
    const seamV = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.07, 0.002), D);
    seamV.position.set(0.045, 0.0, -0.02);
    vm.add(seamV);
    const seamH = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.002, 0.42), D);
    seamH.position.set(0.045, 0.012, 0.0);
    vm.add(seamH);
    const seamL = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.06, 0.002), D);
    seamL.position.set(-0.045, -0.01, -0.05);
    vm.add(seamL);

    // ---- visible bolt carrier: polished block on top of receiver, with
    //      serrations on its rear face (reads as a reciprocating bolt) ----
    const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.03, 0.14), MB);
    bolt.position.set(0, 0.052, 0.08);
    vm.add(bolt);
    for (let i = 0; i < 6; i++) {
      const ser = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.006, 0.006), D);
      ser.position.set(0, 0.052, 0.155 + i * 0.012);
      vm.add(ser);
    }

    // ---- charging-handle T-latch (upgrades the existing cylinder) ----
    const latch = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.014, 0.012), MB);
    latch.position.set(0.035, 0.06, 0.21);
    this._chargeGroup.add(latch);

    // ---- grip texturing: recessed grooves on front + both sides ----
    const grip = this._gripMesh;
    if (grip) {
      const grooveGeo = new THREE.BoxGeometry(0.046, 0.005, 0.008);
      for (let i = 0; i < 5; i++) {
        const grv = new THREE.Mesh(grooveGeo, D);
        grv.position.set(0, -0.04 + i * 0.02, 0.031);
        grip.add(grv);
      }
      const sideGeo = new THREE.BoxGeometry(0.008, 0.005, 0.04);
      for (let i = 0; i < 4; i++) {
        const sz = -0.03 + i * 0.02;
        const sg = new THREE.Mesh(sideGeo, D);
        sg.position.set(0.031, 0, sz);
        grip.add(sg);
        const sg2 = new THREE.Mesh(sideGeo, D);
        sg2.position.set(-0.031, 0, sz);
        grip.add(sg2);
      }
    }
  }

  // ------------------------------------------------------------------ hands
  // WPN-2: replace LEGO palm+finger blocks with low-poly glove meshes — a
  // curved (scaled-sphere) palm, a single merged "fist" block with knuckle
  // ridges for the gripping fingers, and a thumb wrapping the grip.
  // Round 4: bumped scale 0.8 -> 1.05 so hands read clearly in screenshots;
  // added more knuckle ridges + thumb knuckle for visible glove detail.
  _buildHands() {
    const vm = this.viewModel;
    const G = this._matGlove;

    // ---- BACK hand: wraps the pistol grip ----
    const backHand = new THREE.Group();
    backHand.position.set(0, -0.1, 0.12);
    backHand.rotation.x = -0.32;
    backHand.scale.setScalar(1.05);

    // curved palm (squashed sphere = heel of the hand)
    const backPalm = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), G);
    backPalm.scale.set(1.0, 1.25, 1.3);
    backPalm.position.set(0, 0.0, 0.04);
    backHand.add(backPalm);

    // fingers merged into a gripping curl (one rounded block, knuckle ridges)
    const backFingers = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.05, 0.12), G);
    backFingers.position.set(0, 0.03, -0.05);
    backFingers.rotation.x = 0.35;
    backHand.add(backFingers);
    // Round 4: more knuckle ridges so the back of the hand reads as a glove
    for (let i = 0; i < 5; i++) {
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.006, 0.006), G);
      ridge.position.set(0, 0.05, -0.085 + i * 0.034);
      backHand.add(ridge);
    }
    // thumb wrapping the grip (angled, scaled sphere across the front-left)
    const backThumb = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), G);
    backThumb.scale.set(1.6, 0.9, 1.0);
    backThumb.position.set(-0.035, 0.02, -0.02);
    backThumb.rotation.z = 0.6;
    backHand.add(backThumb);
    // Round 4: visible thumb knuckle
    const backThumbKnuckle = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), G);
    backThumbKnuckle.position.set(-0.025, 0.03, -0.05);
    backHand.add(backThumbKnuckle);
    vm.add(backHand);

    // ---- FRONT hand: wraps the handguard ----
    const frontHand = new THREE.Group();
    frontHand.position.set(0, 0.0, -0.40);
    frontHand.rotation.x = -0.1;
    frontHand.scale.setScalar(1.05);

    const frontPalm = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 10), G);
    frontPalm.scale.set(1.0, 1.2, 1.4);
    frontPalm.position.set(0, -0.01, 0.05);
    frontHand.add(frontPalm);

    const frontFingers = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.05, 0.13), G);
    frontFingers.position.set(0, 0.04, -0.05);
    frontFingers.rotation.x = 0.5; // curl over the top of the handguard
    frontHand.add(frontFingers);
    // Round 4: more knuckle ridges on the front hand so it reads as gripping
    for (let i = 0; i < 5; i++) {
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.006, 0.006), G);
      ridge.position.set(0, 0.06, -0.085 + i * 0.036);
      frontHand.add(ridge);
    }
    const frontThumb = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), G);
    frontThumb.scale.set(1.6, 0.9, 1.0);
    frontThumb.position.set(-0.04, 0.0, -0.01);
    frontThumb.rotation.z = 0.6;
    frontHand.add(frontThumb);
    // visible thumb knuckle for the front hand too
    const frontThumbKnuckle = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), G);
    frontThumbKnuckle.position.set(-0.03, 0.02, -0.04);
    frontHand.add(frontThumbKnuckle);
    vm.add(frontHand);
  }

  // ------------------------------------------------------------------ update
  update(dt, input, raycastFn, onEnemyHit, onRecoil) {
    // ---- consume reload request ----
    if (input.reloadQueued) {
      input.reloadQueued = false;
      if (!this.reloading && this.ammo < this.magSize && this.reserve > 0) {
        this._startReload();
      }
    }
    // auto-reload when dry and still holding fire
    if (!this.reloading && this.ammo === 0 && input.fireDown && this.reserve > 0) {
      this._startReload();
    }

    // ---- reload progress ----
    if (this.reloading) {
      this._reloadTimer -= dt;
      if (this._reloadTimer <= 0) {
        this.reloading = false;
        const take = Math.min(this.magSize, this.reserve);
        this.ammo = take;
        this.reserve -= take;
        this._fireCooldown = Math.max(this._fireCooldown, 0.1);
      }
    }

    // ---- firing cadence ----
    this._fireCooldown -= dt;
    if (!this.reloading && input.fireDown && this.ammo > 0 && this._fireCooldown <= 0) {
      this._fire(raycastFn, onEnemyHit, onRecoil);
      this._fireCooldown = this.fireRate;
    }

    // ---- spring recoil offsets back to rest (snappier return) ----
    const decay = Math.exp(-dt * 18);
    this._recoilPos.multiplyScalar(decay);
    this._recoilRot.x *= decay;
    this._recoilRot.y *= decay;
    this._recoilRot.z *= decay;

    // ---- reload animation (P1#13): magazine drops out then re-inserts, plus a
    //      small bolt-pull tilt — replaces the old sine "dip" ----
    let magDrop = 0, boltTilt = 0, chargePull = 0;
    if (this.reloading) {
      const p = 1 - this._reloadTimer / this.reloadTime; // 0..1
      const down = 0.18;
      if (p < 0.35) {
        magDrop = -down * (p / 0.35);            // drop out
      } else if (p < 0.6) {
        magDrop = -down;                          // hang
      } else {
        magDrop = -down * (1 - (p - 0.6) / 0.4);  // re-insert
      }
      // brief upward bolt-pull tilt while the mag is out
      boltTilt = Math.sin(Math.min(Math.max(p, 0), 1) * Math.PI) * 0.12;
      // Round 7: pull the charging handle back (~+0.06z) peaking mid-reload,
      // then snap it forward as the bolt chambers a round.
      chargePull = Math.sin(Math.min(Math.max(p, 0), 1) * Math.PI) * 0.06;
      // eject one spent casing when the bolt is back
      if (p > 0.5 && !this._reloadShellEjected) this._rejectReloadShell();
    }
    this._magMesh.position.y = this._magBaseY + magDrop;
    if (this._chargeGroup) this._chargeGroup.position.z = chargePull;

    // ---- apply pose ----
    this.viewModel.position.set(
      this._restPos.x + this._recoilPos.x,
      this._restPos.y + this._recoilPos.y,
      this._restPos.z + this._recoilPos.z
    );
    this.viewModel.rotation.set(
      this._restRot.x + this._recoilRot.x + boltTilt,
      this._restRot.y + this._recoilRot.y,
      this._restRot.z + this._recoilRot.z
    );

    // ---- advance transient effects ----
    this._updateEffects(dt);

    // ---- Round 5: brass shell physics (gravity + spin + ground settle) ----
    for (let i = this._shells.length - 1; i >= 0; i--) {
      const s = this._shells[i];
      s.life -= dt;
      s.vel.y -= 9.8 * dt;
      s.obj.position.addScaledVector(s.vel, dt);
      s.obj.rotation.x += s.av.x * dt;
      s.obj.rotation.y += s.av.y * dt;
      s.obj.rotation.z += s.av.z * dt;
      // settle on the ground; fade out the last 0.3s so it doesn't pop
      if (s.obj.position.y < 0.015) {
        s.obj.position.y = 0.015;
        s.vel.set(0, 0, 0);
        s.av.set(0, 0, 0);
      }
      if (s.life < 0.3) {
        const f = Math.max(0, s.life / 0.3);
        s.obj.scale.setScalar(f);
      }
      if (s.life <= 0) {
        s.obj.visible = false;
        s.obj.scale.setScalar(1);
        this._shellFree.push(s.obj);
        this._shells.splice(i, 1);
      }
    }

    // ---- Round 7: blood droplets (gravity + ground settle + shrink) ----
    for (let i = this._bloods.length - 1; i >= 0; i--) {
      const b = this._bloods[i];
      b.life -= dt;
      b.vel.y -= 9.8 * dt;
      b.obj.position.addScaledVector(b.vel, dt);
      if (b.obj.position.y < 0.02) {
        b.obj.position.y = 0.02;
        b.vel.set(0, 0, 0);
      }
      if (b.life < 0.3) b.obj.scale.setScalar(Math.max(0, b.life / 0.3));
      if (b.life <= 0) {
        b.obj.visible = false;
        b.obj.scale.setScalar(1);
        this._bloodFree.push(b.obj);
        this._bloods.splice(i, 1);
      }
    }

    // ---- persistent muzzle flash + light fade ----
    if (this._flashLife > 0) {
      this._flashLife -= dt;
      const t = this._flashLife > 0 ? this._flashLife / this._flashMax : 0;
      this._muzzleFlash.scale.setScalar(this._flashBase * t);
      this._muzzleFlash.material.opacity = t;
      this._muzzleLight.intensity = 6 * t;
      if (this._flashLife <= 0) {
        this._muzzleFlash.visible = false;
        this._muzzleLight.intensity = 0;
      }
    }

    // ---- tiny smoke puff fade (0.1s) ----
    if (this._smokeLife > 0) {
      this._smokeLife -= dt;
      const t = this._smokeLife > 0 ? this._smokeLife / this._smokeMax : 0;
      this._muzzleSmoke.material.opacity = 0.5 * t;
      this._muzzleSmoke.scale.setScalar(0.07 * (1 + (1 - t) * 0.6)); // grows
      if (this._smokeLife <= 0) this._muzzleSmoke.visible = false;
    }
  }

  // ------------------------------------------------------------------- fire
  _fire(raycastFn, onEnemyHit, onRecoil) {
    this.ammo--;

    // muzzle world position
    this.muzzle.getWorldPosition(_tmpMuzzle);

    // view-model kick: push back harder (toward camera) and rotate up more
    this._recoilPos.z += 0.08;
    this._recoilRot.x -= 0.09;

    // notify player camera of muzzle climb (felt recoil bumped up)
    onRecoil(0.02);

    // raycast for the landing point
    const hit = raycastFn();
    if (hit && hit.point) {
      this._spawnTracer(_tmpMuzzle, hit.point);
      this._spawnImpact(hit.point, hit.normal);
      if (hit.enemy) {
        onEnemyHit(hit.enemy, hit.point, hit.distance);
        // Round 7: blood spray + scream when a round connects.
        this._spawnBlood(hit.point);
        if (this._sfx) this._sfx.enemyHit();
      }
    } else {
      // no surface hit: fire tracer to a far point along the view
      this.camera.getWorldDirection(_tmpDir);
      _tmpFar.copy(_tmpMuzzle).addScaledVector(_tmpDir, 200);
      this._spawnTracer(_tmpMuzzle, _tmpFar);
    }

    this._spawnMuzzleFlash(_tmpMuzzle);
    this._ejectShell();
    if (this._sfx) this._sfx.shot();
  }

  // ----------------------------------------------------------------- reload
  _startReload() {
    this.reloading = true;
    this._reloadTimer = this.reloadTime;
    this._reloadShellEjected = false;
    if (this._sfx) this._sfx.reload();
  }

  // Round 7: pop a casing out the port during a reload (the bolt cycling).
  _rejectReloadShell() {
    this._reloadShellEjected = true;
    this._ejectShell();
  }

  // ---------------------------------------------------------------- effects
  _spawnMuzzleFlash(pos) {
    // Reposition the SINGLE persistent light (no add/remove → no recompile) and
    // show the SINGLE persistent billboard sprite at the muzzle.
    this._muzzleLight.position.copy(pos);
    this._muzzleLight.intensity = 6;

    const s = 0.16 + Math.random() * 0.08; // WPN-4: much smaller than before
    this._muzzleFlash.position.copy(pos);
    this._muzzleFlash.scale.set(s, s, 1);
    this._muzzleFlash.material.opacity = 1;
    this._muzzleFlash.visible = true;

    this._flashLife = 0.04;
    this._flashMax = 0.04;
    this._flashBase = s;

    // tiny smoke puff (WPN-4 optional) — fades over 0.1s
    this._muzzleSmoke.position.copy(pos);
    this._muzzleSmoke.scale.setScalar(0.07);
    this._muzzleSmoke.material.opacity = 0.5;
    this._muzzleSmoke.visible = true;
    this._smokeLife = this._smokeMax;
  }

  _spawnTracer(a, b) {
    _tmpDir.subVectors(b, a);
    const len = _tmpDir.length();
    if (len < 0.001) return;
    _tmpDir.normalize();
    _tmpMid.copy(a).addScaledVector(_tmpDir, len * 0.5);

    const mat = this._tracerMatBase.clone(); // per-tracer opacity fade
    const mesh = new THREE.Mesh(this._tracerGeo, mat);
    mesh.position.copy(_tmpMid);
    mesh.quaternion.setFromUnitVectors(_up, _tmpDir);
    mesh.scale.set(1, len, 1);
    this.scene.add(mesh);

    this._effects.push({ kind: 'tracer', obj: mesh, life: 0.12, max: 0.12 });
  }

  _spawnImpact(point, normal) {
    // 1) transient spark — the initial strike flash (kept, reads as the hit)
    const mat = this._sparkMatBase.clone(); // per-impact opacity fade
    const mesh = new THREE.Mesh(this._sparkGeo, mat);
    mesh.position.copy(point);
    if (normal) {
      _tmpDir.copy(point).add(normal);
      mesh.lookAt(_tmpDir);
    }
    const s = 0.7 + Math.random() * 0.5;
    mesh.scale.setScalar(s);
    this.scene.add(mesh);
    this._effects.push({ kind: 'impact', obj: mesh, base: s, life: 0.08, max: 0.08 });

    // 2) persistent bullet hole — pooled decal, FIFO so the oldest is recycled.
    //    Nudged off the surface (along the normal) so even with polygonOffset we
    //    never z-fight, and rolled randomly so repeated hits don't look stencilled.
    const decal = this._decalPool[this._decalIdx];
    this._decalIdx = (this._decalIdx + 1) % this._decalPool.length;
    decal.position.copy(point);
    if (normal) {
      _tmpDir.copy(point).add(normal);
      decal.lookAt(_tmpDir);
      decal.position.addScaledVector(normal, 0.012);
      decal.rotateZ(Math.random() * Math.PI * 2);
    }
    decal.scale.setScalar(0.8 + Math.random() * 0.5);
    decal.visible = true;

    // 3) expanding dust puff from the pool — sells the material being punched
    if (this._dustFree.length) {
      const d = this._dustFree.pop();
      d.position.copy(point);
      if (normal) d.position.addScaledVector(normal, 0.03);
      const ds = 0.12 + Math.random() * 0.05;
      d.scale.setScalar(ds);
      d.material.opacity = 0.85;
      d.visible = true;
      const life = 0.5 + Math.random() * 0.25;
      this._effects.push({ kind: 'dust', obj: d, base: ds, life, max: life });
    }

    if (this._sfx) this._sfx.hit();
  }

  _updateEffects(dt) {
    for (let i = this._effects.length - 1; i >= 0; i--) {
      const e = this._effects[i];
      e.life -= dt;
      const t = e.life > 0 ? e.life / e.max : 0;

      if (e.kind === 'tracer') {
        // fade opacity out over the tracer's life (P2#30)
        e.obj.material.opacity = t;
      } else if (e.kind === 'impact') {
        e.obj.material.opacity = t;
        e.obj.scale.setScalar(e.base * t);
      } else if (e.kind === 'bloodpuff') {
        e.obj.material.opacity = t * 0.9;
        e.obj.scale.setScalar(0.14 * (1 + (1 - t) * 1.1)); // expands as it fades
      } else if (e.kind === 'dust') {
        const k = 1 - t;                       // 0 -> 1 across the puff's life
        e.obj.material.opacity = 0.85 * t;     // fade out
        e.obj.scale.setScalar(e.base * (1 + k * 2.4)); // billow outward
      }

      if (e.life <= 0) {
        if (e.kind === 'dust') {
          // pooled dust sprite: hide and return to the free list, keep both the
          // sprite and its material alive for the next impact
          e.obj.visible = false;
          this._dustFree.push(e.obj);
        } else {
          this.scene.remove(e.obj);
          // only dispose per-instance (cloned) materials; shared geo/mats kept
          if (e.obj.material && e.obj.material !== this._tracerMatBase && e.obj.material !== this._sparkMatBase) {
            e.obj.material.dispose();
          }
        }
        this._effects.splice(i, 1);
      }
    }
  }
}
