import * as THREE from 'three';

const SENS = 0.0022;
// Round 11 — look conditioning. See the "--- look ---" block in update() for
// the full rationale. LOOK_MAX_RATE caps the turn rate actually applied in one
// frame; LOOK_STEP_DT_CAP stops a hitched frame from "earning" a bigger step
// just because more wall-clock time elapsed while nothing was drawn.
const LOOK_MAX_RATE = 24;         // rad/s ≈ 1375 deg/s — above any real flick
const LOOK_STEP_DT_CAP = 1 / 45;  // any frame longer than this is treated as 1/45s
const SPEED = 6.5;
const SPRINT = 10.5;
const GRAVITY = 22;
const JUMP = 8.0;
const EYE = 1.7;          // camera height above feet
const RADIUS = 0.35;
const HEIGHT = 1.8;
const MAX_FALL = 32;
// Round 8: death-cam duration (seconds). The world slows to a crawl and the
// camera tilts/slumps over this window before the "YOU DIED" message lands.
const DEATH_CAM_DUR = 1.8;

export class Player {
  constructor(camera, colliders, input) {
    this.camera = camera;
    this.colliders = colliders; // Array<THREE.Box3>
    this.input = input;
    this.yaw = 0;
    this.pitch = 0;
    this.recoil = 0; // accumulates from weapon muzzle climb, decays each frame
    this.velocity = new THREE.Vector3();
    this.position = new THREE.Vector3(0, EYE, 8);
    this.health = 100;
    this.maxHealth = 100;
    this.grounded = false;
    this.alive = true;
    // Round 11: leftover look rotation carried into the next frame(s) when a
    // single frame's accumulated mouse delta exceeded the per-frame cap.
    this._lookCarryX = 0;
    this._lookCarryY = 0;
    this._t = 0;            // time accumulator (for shake oscillators)
    this.hitKick = 0;       // Round 8: decaying camera-shake magnitude when hit
    this.deathT = 0;        // Round 8: seconds elapsed in the death cam (set by main)
    this._min = new THREE.Vector3();
    this._max = new THREE.Vector3();
  }

  addRecoil(kick) { this.recoil += kick; }

  // Round 8: when the player takes a hit, kick the camera (roll + positional
  // shake) so the damage reads physically. hitKick decays each frame in update.
  addHitKick(amount = 1) {
    this.hitKick = Math.min(1.5, this.hitKick + amount);
  }

  // Roll oscillation driven by the current hit-kick magnitude (kept tiny so the
  // horizon only wobbles a few degrees — reads as impact, not seasickness).
  _shakeRoll() {
    return Math.sin(this._t * 38) * this.hitKick * 0.06;
  }

  takeDamage(n) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - n);
    if (this.health <= 0) this.alive = false;
  }

  update(dt) {
    this._t += dt;
    // Round 8: hit-kick decays toward 0 so the impact shake is a brief jolt.
    this.hitKick = Math.max(0, this.hitKick - dt * 3.2);
    const p = this.position;

    if (this.alive) {
      const input = this.input;

      // --- look (Round 11: hitch-proof) ---
      // Mouse deltas accumulate between frames. When a frame hitches — GC, a
      // first-time shader compile, a texture upload — dozens of mousemove
      // events pile up and are applied in a single step, so the view teleports
      // past where the player was aiming. Worse, dt is clamped to 0.05 for
      // physics, so on that same frame movement crawls while the turn dumps
      // everything: exactly the "walking + turning suddenly overshoots" feel.
      //
      // Fix: cap how far one frame may rotate and CARRY the remainder into the
      // following frames. Total rotation the player's hand asked for is still
      // delivered, just spread over 2-3 frames instead of one snap. The cap is
      // deliberately generous, so ordinary and even fast flicks pass through
      // untouched with zero added latency — only pathological pile-ups clip.
      this._lookCarryX += input.mouseDX * SENS;
      this._lookCarryY += input.mouseDY * SENS;
      input.mouseDX = 0;
      input.mouseDY = 0;

      const maxStep = LOOK_MAX_RATE * Math.min(dt, LOOK_STEP_DT_CAP);
      const stepX = Math.max(-maxStep, Math.min(maxStep, this._lookCarryX));
      const stepY = Math.max(-maxStep, Math.min(maxStep, this._lookCarryY));
      this._lookCarryX -= stepX;
      this._lookCarryY -= stepY;
      if (Math.abs(this._lookCarryX) < 1e-4) this._lookCarryX = 0;
      if (Math.abs(this._lookCarryY) < 1e-4) this._lookCarryY = 0;

      this.yaw -= stepX;
      const wantPitch = this.pitch - stepY;
      this.pitch = Math.max(-1.5, Math.min(1.5, wantPitch));
      // Pegged at the vertical limit: drop the backlog, otherwise pushing into
      // the clamp banks rotation that snaps back the moment you reverse.
      if (this.pitch !== wantPitch) this._lookCarryY = 0;

      this.recoil = Math.max(0, this.recoil - dt * 5.0);
      this.camera.rotation.set(this.pitch + this.recoil, this.yaw, this._shakeRoll(), 'YXZ');

      // --- planar movement ---
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const wish = new THREE.Vector3();
      if (input.keys['KeyW']) wish.add(fwd);
      if (input.keys['KeyS']) wish.sub(fwd);
      if (input.keys['KeyD']) wish.add(right);
      if (input.keys['KeyA']) wish.sub(right);
      const speed = input.sprint ? SPRINT : SPEED;
      if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
      this.velocity.x = wish.x;
      this.velocity.z = wish.z;

      // --- jump + gravity ---
      if (input.jumpQueued && this.grounded) {
        this.velocity.y = JUMP;
        this.grounded = false;
      }
      input.jumpQueued = false;
      this.velocity.y -= GRAVITY * dt;
      if (this.velocity.y < -MAX_FALL) this.velocity.y = -MAX_FALL;

      // --- integrate ---
      p.x += this.velocity.x * dt;
      p.z += this.velocity.z * dt;
      p.y += this.velocity.y * dt;

      // ground plane
      if (p.y <= EYE) { p.y = EYE; this.velocity.y = 0; this.grounded = true; }

      this.resolveCollisions();

      this.camera.position.copy(p);
      // Round 8: positional hit shake (small, only while kicked)
      if (this.hitKick > 0) {
        this.camera.position.x += Math.sin(this._t * 33) * this.hitKick * 0.04;
        this.camera.position.y += Math.cos(this._t * 41) * this.hitKick * 0.045;
      }
    } else {
      // --- Round 8: death cam ---
      // Camera tilts down + rolls + the eye slumps toward the ground as deathT
      // climbs (main.js feeds deathT = prog * DEATH_CAM_DUR during the sequence).
      const f = Math.min(1, this.deathT / DEATH_CAM_DUR);
      this.camera.rotation.set(this.pitch + this.recoil - 0.7 * f, this.yaw, 0.32 * f, 'YXZ');
      this.camera.position.copy(p);
      this.camera.position.y -= 0.5 * f; // slump down as you go down
    }
  }

  resolveCollisions() {
    const p = this.position;
    this._min.set(p.x - RADIUS, p.y - EYE, p.z - RADIUS);
    this._max.set(p.x + RADIUS, p.y - EYE + HEIGHT, p.z + RADIUS);

    for (const box of this.colliders) {
      if (this._max.x < box.min.x || this._min.x > box.max.x) continue;
      if (this._max.y < box.min.y || this._min.y > box.max.y) continue;
      if (this._max.z < box.min.z || this._min.z > box.max.z) continue;

      const px = Math.min(this._max.x - box.min.x, box.max.x - this._min.x);
      const py = Math.min(this._max.y - box.min.y, box.max.y - this._min.y);
      const pz = Math.min(this._max.z - box.min.z, box.max.z - this._min.z);
      const m = Math.min(px, py, pz);

      if (m === py) {
        const pc = p.y - EYE + HEIGHT / 2;
        const bc = (box.min.y + box.max.y) / 2;
        if (pc > bc) { p.y += py; if (this.velocity.y < 0) this.velocity.y = 0; this.grounded = true; }
        else { p.y -= py; if (this.velocity.y > 0) this.velocity.y = 0; }
      } else if (m === px) {
        const cx = (box.min.x + box.max.x) / 2;
        p.x = p.x > cx ? box.max.x + RADIUS : box.min.x - RADIUS;
      } else {
        const cz = (box.min.z + box.max.z) / 2;
        p.z = p.z > cz ? box.max.z + RADIUS : box.min.z - RADIUS;
      }
    }
  }
}
