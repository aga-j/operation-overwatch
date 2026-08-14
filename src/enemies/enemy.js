import * as THREE from 'three';

// ---- Tunables -------------------------------------------------------------
const DETECT_RANGE   = 40;    // distance at which an enemy can spot the player
const ATTACK_RANGE   = 22;    // distance at which an enemy opens fire
const ENEMY_RADIUS   = 0.45;  // used for slide-collision against blockers
const CHASE_SPEED    = 3.4;   // movement speed while chasing
const PATROL_SPEED   = 1.2;   // wander speed
const ATTACK_COOLDOWN = 0.85; // seconds between shots
const SHOT_DAMAGE     = 8;    // damage dealt per shot
const ARENA          = 70;    // half-extent of the play area (keeps enemies in bounds)
const DEATH_TIME     = 4;     // seconds before a corpse is removed
const HITREACT_DUR   = 0.4;   // Round 8: flinch/stagger duration after a non-lethal hit
const ARM_HOLD       = THREE.MathUtils.degToRad(70); // arms raised forward to grip the rifle

// ---- Round 12: combat rebalance --------------------------------------------
// Real shooters don't have N enemies firing in lockstep at 100% accuracy at
// 22m. The old numbers produced "die in 3 seconds before the trigger-down
// animation even finishes" runs (see play_session-report.json 2026-08-04).
// Tuning here mirrors CoD/Halo pacing: enemies miss most of the time, ramp in
// over a beat, and cap how many can pour fire on the player simultaneously.
const ATTACK_COOLDOWN_MIN = 1.05;       // base seconds between shots (was 0.85)
const ATTACK_COOLDOWN_JITTER = 0.55;    // per-enemy ±0.55s
const SHOT_DAMAGE_V2 = 6;               // per connected shot (was 8)
const FIRST_SHOT_GRACE = 0.7;           // seconds a hostile holds fire after first spotting you
const MAX_ACTIVE_ATTACKERS = 3;         // hard cap on enemies simultaneously firing
const ACCURACY_NEAR   = 0.55;           // < 18m hit rate
const ACCURACY_FAR    = 0.18;           // > 28m hit rate
const PLAYER_REGEN_DELAY = 4.0;         // s since last hit before regen kicks in
const PLAYER_REGEN_RATE = 9;            // hp/s

// ---- Round 9: tactical cover behaviour ------------------------------------
const COVER_HEALTH   = 0.6;   // break for cover once health drops below 60%
const COVER_SEARCH   = 22;    // max distance to consider a cover box
const COVER_STAND    = 0.8;   // how far behind the box the enemy plants itself
const COVER_MAX      = 7.5;   // seconds to stay pinned before pushing out again
const COVER_SEEK_MAX = 6;     // give up running to cover after this long
const COVER_COOLDOWN = 5;     // seconds before the same enemy may take cover again
const PEEK_CYCLE     = 3.0;   // full hide->peek period while in cover
const PEEK_HIDE      = 1.9;   // first part of the cycle is spent fully hidden
const CROUCH_DROP    = 0.28;  // body drop (m) at full crouch
const CROUCH_LEG     = 1.35;  // hip/knee bend (rad) at full crouch

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class EnemyManager {
  constructor(scene, colliders, solids) {
    this.scene = scene;
    this.colliders = colliders || [];   // THREE.Box3[] movement blockers
    this.solids = solids || [];         // THREE.Mesh[] line-of-sight blockers
    this.enemies = [];
    this.raycaster = new THREE.Raycaster();
    this.simTime = 0;                   // Round 12: monotonic sim clock (used for first-shot grace)

    // scratch objects (avoid per-frame allocations)
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpDir = new THREE.Vector3();
    this._tmpUp = new THREE.Vector3(0, 1, 0);
    this._eye = new THREE.Vector3();
    this._muzzlePos = new THREE.Vector3();

    this._mat = this._buildMaterials();
    this._initEffectPools();
    // Round 9: pre-filter the world colliders down to boxes an enemy can
    // actually hide behind (waist/chest high, wide enough, not a building).
    this._coverBoxes = this._buildCoverBoxes();
  }

  // ---- Round 9: cover extraction -----------------------------------------
  // A usable cover box is chest-high-ish and at least half a meter across on
  // both horizontal axes. Perimeter walls / building shells are far too big and
  // get rejected, so enemies only ever duck behind crates, barriers, barrels
  // and sandbag stacks — exactly the props a CoD level designer places.
  _buildCoverBoxes() {
    const out = [];
    for (const b of this.colliders) {
      const sx = b.max.x - b.min.x;
      const sz = b.max.z - b.min.z;
      if (b.max.y < 0.6 || b.max.y > 2.0) continue; // too low to hide / too tall to shoot over
      if (sx < 0.5 || sz < 0.5) continue;           // too thin to actually cover a body
      if (sx > 8 || sz > 8) continue;               // a wall, not a prop
      out.push({
        cx: (b.min.x + b.max.x) * 0.5,
        cz: (b.min.z + b.max.z) * 0.5,
        r: Math.max(sx, sz) * 0.5,
        top: b.max.y,
      });
    }
    return out;
  }

  // Pick the cheapest reachable box and return the standing spot on its far
  // side relative to the player (so the prop ends up between the two).
  _findCoverSpot(e, playerPos) {
    const pos = e.group.position;
    let best = null;
    let bestScore = Infinity;
    for (const c of this._coverBoxes) {
      const dEx = c.cx - pos.x;
      const dEz = c.cz - pos.z;
      const dE = Math.hypot(dEx, dEz);
      if (dE > COVER_SEARCH) continue;
      let px = playerPos.x - c.cx;
      let pz = playerPos.z - c.cz;
      const pd = Math.hypot(px, pz);
      if (pd < 1.0) continue; // player is basically standing on the prop
      px /= pd; pz /= pd;
      const off = c.r + COVER_STAND;
      const sx = c.cx - px * off;
      const sz = c.cz - pz * off;
      if (Math.abs(sx) > ARENA || Math.abs(sz) > ARENA) continue;
      if (this._pointBlocked(sx, sz, e.radius)) continue;
      // prefer close boxes that don't require running toward the player
      const runD = Math.hypot(sx - pos.x, sz - pos.z);
      const score = runD + dE * 0.3;
      if (score < bestScore) { bestScore = score; best = { x: sx, z: sz, box: c }; }
    }
    return best;
  }

  _buildMaterials() {
    // Fatigue palette: the two lightest former colors (0xc4a882 sand, 0x9c8a5a tan)
    // are DROPPED so uniforms no longer blend into the sandy arena. The remaining set
    // is darker and slightly more saturated. Vests/helmets stay darker than EVERY
    // uniform color for contrast (see vest/helmet colors below).
    // ENEMY2-1: the lightest color (0x646a57) is lifted to 0x7a7e65 so enemies keep a
    // readable silhouette in shadowed mid-ground instead of collapsing into dark blobs.
    const fatigueColors = [0x4f5238, 0x53585f, 0x7a7e65, 0x3e4a2b, 0x474e3a];
    const fatigues = fatigueColors.map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0.0 })
    );
    const skin = new THREE.MeshStandardMaterial({ color: 0xb98b6b, roughness: 0.85 });
    const gun  = new THREE.MeshStandardMaterial({ color: 0x222228, roughness: 0.6, metalness: 0.4 });
    // helmet + vest forced darker than the lightest fatigue (0x7a7e65) for contrast.
    // ENEMY2-1: helmet gets a small emissive rim bias + brighter metalness/lower roughness
    // so it catches highlights and stays readable at distance (silver/dark military look).
    const helmet = new THREE.MeshStandardMaterial({
      color: 0x232428, roughness: 0.25, metalness: 0.75, emissive: 0x1a1c1e,
    });
    const visor  = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5, metalness: 0.3 });
    // vest also gets a faint emissive so the torso band reads against shadow.
    const vest   = new THREE.MeshStandardMaterial({
      color: 0x2a291f, roughness: 0.7, metalness: 0.05, emissive: 0x141308,
    });
    // shared gear materials (reused across every enemy, matching the pooling pattern)
    const gear   = new THREE.MeshStandardMaterial({ color: 0x2e2f25, roughness: 0.8, metalness: 0.1 });
    const pad    = new THREE.MeshStandardMaterial({ color: 0x3a3b32, roughness: 0.7, metalness: 0.15 });
    return { fatigues, skin, gun, helmet, visor, vest, gear, pad };
  }

  // weighted fatigue picker that avoids repeating the previous enemy's color
  _pickFatigueIndex(prev) {
    const n = this._mat.fatigues.length;
    const weights = [3, 2, 2, 2, 2];
    let total = 0;
    const cum = [];
    for (let i = 0; i < n; i++) {
      const w = i === prev ? 0 : (weights[i] || 1);
      total += w;
      cum.push(total);
    }
    if (total <= 0) return (Math.random() * n) | 0;
    const r = Math.random() * total;
    for (let i = 0; i < n; i++) if (r <= cum[i]) return i;
    return n - 1;
  }

  // ---- Spawning -----------------------------------------------------------
  spawn(count, spawnPoints) {
    // Round 11: consume the points IN ORDER. buildSpawnPoints now emits them
    // tiered near -> far (contact / mid field / overwatch); shuffling threw
    // that structure away and could stack every hostile at max range or bunch
    // them all into the first tier. The ordering IS the level design.
    const pts = spawnPoints.slice();
    for (let i = 0; i < count; i++) {
      let p;
      if (i < pts.length) {
        p = pts[i];
      } else {
        // more enemies than points: jitter around a distinct point so none overlap exactly
        const base = pts[i % pts.length];
        p = {
          x: base.x + (Math.random() * 2 - 1) * 1.5,
          y: base.y,
          z: base.z + (Math.random() * 2 - 1) * 1.5,
        };
      }
      this.enemies.push(this._createEnemy(p));
    }
  }

  _createEnemy(point) {
    const group = new THREE.Group();
    group.position.set(point.x, point.y || 0, point.z);

    const fatigueIdx = this._pickFatigueIndex(this._lastFatigue);
    this._lastFatigue = fatigueIdx;
    const fatigueMat = this._mat.fatigues[fatigueIdx];
    const parts = {};

    // torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.35), fatigueMat);
    torso.position.y = 1.15;
    torso.castShadow = torso.receiveShadow = true;
    group.add(torso);
    parts.torso = torso;

    // head (cranial sphere, slightly squashed along Y)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), this._mat.skin);
    head.scale.y = 0.92;
    head.position.y = 1.72;
    head.castShadow = head.receiveShadow = true;
    group.add(head);
    parts.head = head;

    // neck (bridges torso and head)
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.08, 8), fatigueMat);
    neck.position.y = 1.5;
    neck.castShadow = true;
    group.add(neck);
    parts.neck = neck;

    // helmet: closed hemisphere dome + rim + side rails + ballistic visor band.
    // Reads as a soldier's kevlar lid, not a featureless ball.
    const helmet = new THREE.Group();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.205, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      this._mat.helmet
    );
    dome.position.y = 1.72; // hemisphere caps the crown of the head sphere
    dome.castShadow = true;
    const brim = new THREE.Mesh(new THREE.TorusGeometry(0.205, 0.015, 6, 18), this._mat.helmet);
    brim.rotation.x = Math.PI / 2;
    brim.position.y = 1.72;
    const railL = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.24), this._mat.helmet);
    railL.position.set(-0.2, 1.8, 0);
    const railR = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.24), this._mat.helmet);
    railR.position.set(0.2, 1.8, 0);
    // ballistic visor plate at the front (-Z), leaving a small eye gap below it
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.04), this._mat.visor);
    visor.position.set(0, 1.74, -0.17);
    helmet.add(dome, brim, railL, railR, visor);
    group.add(helmet);
    parts.helmet = helmet;

    // optional equipment variation: torso-wrapping vest (~40% chance)
    if (Math.random() < 0.4) {
      const vest = new THREE.Mesh(new THREE.BoxGeometry(0.63, 0.7, 0.37), this._mat.vest);
      vest.position.y = 1.15;
      vest.castShadow = true;
      group.add(vest);
      parts.vest = vest;
    }

    // limbs (pivot groups at shoulders/hips so rotation swings from the joint)
    parts.leftArm  = this._makeLimb(0.18, 0.7, 0.18, fatigueMat,  0.4, 1.45);
    parts.rightArm = this._makeLimb(0.18, 0.7, 0.18, fatigueMat, -0.4, 1.45);
    // legs split into upper + lower segments with a knee joint for a human gait
    const lLeg = this._makeLeg(fatigueMat,  0.16);
    const rLeg = this._makeLeg(fatigueMat, -0.16);
    parts.leftLeg = lLeg.hip;
    parts.rightLeg = rLeg.hip;
    parts.leftLegKnee = lLeg.knee;
    parts.rightLegKnee = rLeg.knee;
    group.add(parts.leftArm, parts.rightArm, lLeg.hip, rLeg.hip);

    // ---- tactical gear (silhouette interest; shared materials, pooled per-enemy) ----
    const gearMat = this._mat.gear;
    const padMat  = this._mat.pad;

    // backpack on the torso rear (+Z is the back; rifle/hands sit at -Z front)
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.16), gearMat);
    pack.position.set(0, 1.2, 0.24);
    pack.castShadow = true;
    group.add(pack);

    // chest pouches across the front of the torso
    const pouch1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.07), gearMat);
    pouch1.position.set(0, 1.32, -0.2);
    pouch1.castShadow = true;
    const pouch2 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.07), gearMat);
    pouch2.position.set(0, 1.16, -0.2);
    pouch2.castShadow = true;
    group.add(pouch1, pouch2);

    // knee pads at the top of each lower leg (front of the knee joint)
    for (const k of [lLeg.knee, rLeg.knee]) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.12), padMat);
      pad.position.set(0, -0.02, 0.12);
      pad.castShadow = true;
      k.add(pad);
    }

    // elbow pads on the outer side of each upper arm
    for (const a of [parts.leftArm, parts.rightArm]) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.14), padMat);
      pad.position.set(0, -0.34, 0.06);
      pad.castShadow = true;
      a.add(pad);
    }

    // arms held forward so the hands come up to grip the rifle
    parts.leftArm.rotation.x = ARM_HOLD;
    parts.rightArm.rotation.x = ARM_HOLD;

    // "hands" node the arms reach toward; the rifle is mounted on it
    const hands = new THREE.Group();
    hands.position.set(0, 1.2, -0.55);
    group.add(hands);
    parts.hands = hands;

    // weapon held in front (parented to the hands node so it tracks the arms)
    const weapon = new THREE.Group();
    weapon.position.set(0.22, -0.05, 0.2); // local to hands node -> same world spot as before
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, 0.34), this._mat.gun);
    receiver.castShadow = true;
    weapon.add(receiver);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.42, 8), this._mat.gun);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, -0.34);
    barrel.castShadow = true;
    weapon.add(barrel);
    // handguard around the barrel (forward of the receiver)
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.22), this._mat.gun);
    guard.position.set(0, 0, -0.2);
    weapon.add(guard);
    // magazine (angled forward-down so it reads as a curved box mag)
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.09), this._mat.gun);
    mag.position.set(0, -0.12, 0.02);
    mag.rotation.x = 0.25;
    weapon.add(mag);
    // pistol grip (angled back-down)
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.07), this._mat.gun);
    grip.position.set(0, -0.11, 0.11);
    grip.rotation.x = -0.4;
    weapon.add(grip);
    // stock (extends back toward the shoulder)
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.2), this._mat.gun);
    stock.position.set(0, -0.01, 0.26);
    weapon.add(stock);
    hands.add(weapon);
    parts.weapon = weapon;

    const enemy = {
      group,
      parts,
      health: 100,
      maxHealth: 100,
      state: 'PATROL',
      alive: true,
      radius: ENEMY_RADIUS,
      baseY: point.y || 0,
      cooldown: 0,
      losCache: false,
      losTimer: 0,
      animTime: Math.random() * 10,
      patrolTarget: this._randomPatrolPoint(),
      deathTimer: 0,
      moving: false,
      hitReact: 0,       // Round 8: >0 while reeling from a non-lethal hit
      // Round 12: combat rebalance bookkeeping
      firstSeenAt: -1,   // sim time at which this enemy FIRST obtained LOS (used for first-shot grace)
      shotJitter: ATTACK_COOLDOWN_MIN + (Math.random() - 0.5) * 2 * ATTACK_COOLDOWN_JITTER,
      suppressed: false, // true when MAX_ACTIVE_ATTACKERS is full and this one is held back
      // Round 9: tactical cover state
      coverSpot: null,   // {x,z,box} the enemy is running to / holding
      coverTimer: 0,     // time spent seeking / pinned
      coverCooldown: 0,  // blocks re-entering cover immediately after leaving
      crouchTarget: 0,   // 0 = standing, 1 = fully ducked behind the prop
      crouchAmt: 0,      // smoothed crouch used by the animation
      peeking: false,
      hitboxes: [],
    };

    // collect every body mesh as a hittable, tagged with its owning enemy
    enemy.hitboxes = [
      torso, head, neck, dome, brim, visor,
      parts.leftArm.children[0], parts.rightArm.children[0],
      lLeg.upper, rLeg.upper, lLeg.lower, rLeg.lower,
    ];
    if (parts.vest) enemy.hitboxes.push(parts.vest);
    for (const m of enemy.hitboxes) m.userData.enemy = enemy;

    this.scene.add(group);
    return enemy;
  }

  _makeLimb(w, h, d, mat, x, yPivot) {
    const pivot = new THREE.Group();
    pivot.position.set(x, yPivot, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.y = -h / 2; // hang downward from the joint
    mesh.castShadow = mesh.receiveShadow = true;
    pivot.add(mesh);
    return pivot;
  }

  // leg with a knee joint: hip pivot -> upper segment -> knee pivot -> lower segment + foot
  _makeLeg(mat, x) {
    const yPivot = 0.7;          // hip pivot so the foot rests at y=0 when straight
    const upperLen = 0.35, lowerLen = 0.30;
    const hip = new THREE.Group();
    hip.position.set(x, yPivot, 0);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.22, upperLen, 0.22), mat);
    upper.position.y = -upperLen / 2;
    upper.castShadow = upper.receiveShadow = true;
    hip.add(upper);
    const knee = new THREE.Group();
    knee.position.y = -upperLen;
    hip.add(knee);
    const lower = new THREE.Mesh(new THREE.BoxGeometry(0.2, lowerLen, 0.2), mat);
    lower.position.y = -lowerLen / 2;
    lower.castShadow = lower.receiveShadow = true;
    knee.add(lower);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.34), mat);
    foot.position.set(0, -lowerLen - 0.025, 0.07);
    foot.castShadow = true;
    knee.add(foot);
    return { hip, knee, upper, lower, foot };
  }

  _randomPatrolPoint() {
    return new THREE.Vector3(
      (Math.random() * 2 - 1) * ARENA * 0.8,
      0,
      (Math.random() * 2 - 1) * ARENA * 0.8
    );
  }

  // ---- Per-frame update ---------------------------------------------------
  update(dt, playerPos, onPlayerHit) {
    this._updateEffects(dt);
    this.simTime += dt;

    const dead = [];
    // Round 12: pre-pass — clear the suppression flag, then re-elect up to
    // MAX_ACTIVE_ATTACKERS enemies (the closest alive + LOS enemies in
    // ATTACK/COVER states). This is the single most important pacing knob:
    // without it, every enemy with a cooldown of 0 fires the same frame.
    for (const e of this.enemies) e.suppressed = false;
    {
      const candidates = this.enemies
        .filter((e) => e.alive && (e.state === 'ATTACK' || e.state === 'COVER')
          && e.firstSeenAt > 0 && this.simTime - e.firstSeenAt >= FIRST_SHOT_GRACE)
        .map((e) => {
          const dx = playerPos.x - e.group.position.x;
          const dz = playerPos.z - e.group.position.z;
          return { e, d: Math.hypot(dx, dz) };
        })
        .sort((a, b) => a.d - b.d);
      for (let i = 0; i < candidates.length; i++) {
        if (i >= MAX_ACTIVE_ATTACKERS) candidates[i].e.suppressed = true;
      }
    }

    for (const e of this.enemies) {
      if (!e.alive) {
        this._updateDeath(e, dt);
        if (e.deathTimer >= DEATH_TIME) dead.push(e);
        continue;
      }
      // Round 12: stamp firstSeenAt the moment this enemy first gains LOS.
      // Driven from here (not from the AI) so it captures the player's true
      // reveal moment, not the enemy's state-machine transition.
      this._stampFirstSeen(e, playerPos);
      this._updateAI(e, dt, playerPos, onPlayerHit);
      this._updateAnim(e, dt);
    }

    if (dead.length) {
      this.enemies = this.enemies.filter((e) => !dead.includes(e));
    }
  }

  // Round 12: track the moment an enemy FIRST gains LOS to the player, used
  // to delay their opening shot so the player has a beat to react. Re-runs
  // every frame but is cheap (a single distance check + LOS cache lookup).
  _stampFirstSeen(e, playerPos) {
    if (e.firstSeenAt > 0) return; // already locked
    const pos = e.group.position;
    const dx = playerPos.x - pos.x;
    const dz = playerPos.z - pos.z;
    if (Math.hypot(dx, dz) > DETECT_RANGE) return;
    if (!e.losCache) return;
    e.firstSeenAt = this.simTime;
  }

  _updateAI(e, dt, playerPos, onPlayerHit) {
    if (e.hitReact > 0) e.hitReact -= dt; // Round 8: flinch timer
    if (e.coverCooldown > 0) e.coverCooldown -= dt; // Round 9
    const pos = e.group.position;
    const dx = playerPos.x - pos.x;
    const dz = playerPos.z - pos.z;
    const dist = Math.hypot(dx, dz);

    // Line of sight only matters once the player is within hearing/sight range.
    // Throttle recomputation to ~0.2s and cache the result to avoid per-frame thrash.
    let los = false;
    if (dist < DETECT_RANGE) {
      e.losTimer -= dt;
      if (e.losTimer <= 0) {
        this._eye.set(pos.x, pos.y + 1.5, pos.z);
        e.losCache = this._hasLOS(this._eye, playerPos);
        e.losTimer = 0.2;
      }
      los = e.losCache;
    } else {
      los = false;
    }

    // --- state transitions ---
    switch (e.state) {
      case 'PATROL':
        if (dist < DETECT_RANGE && los) e.state = 'CHASE';
        break;
      case 'CHASE':
        if (dist > DETECT_RANGE) e.state = 'PATROL';
        else if (dist < ATTACK_RANGE && los) e.state = 'ATTACK';
        break;
      case 'ATTACK':
        if (!los || dist > ATTACK_RANGE * 1.4) { e.state = 'CHASE'; break; }
        // Round 9: wounded hostiles break contact and run for hard cover
        // instead of standing in the open trading shots.
        if (e.health < e.maxHealth * COVER_HEALTH && e.coverCooldown <= 0) {
          const spot = this._findCoverSpot(e, playerPos);
          if (spot) {
            e.coverSpot = spot;
            e.coverTimer = 0;
            e.state = 'SEEK_COVER';
          } else {
            e.coverCooldown = 3; // nothing usable nearby; retry later
          }
        }
        break;
      case 'SEEK_COVER': {
        e.coverTimer += dt;
        if (!e.coverSpot || e.coverTimer > COVER_SEEK_MAX) {
          e.state = 'ATTACK'; e.coverCooldown = COVER_COOLDOWN; e.coverSpot = null;
          break;
        }
        const cd = Math.hypot(e.coverSpot.x - pos.x, e.coverSpot.z - pos.z);
        if (cd < 0.6) { e.state = 'COVER'; e.coverTimer = 0; }
        break;
      }
      case 'COVER':
        e.coverTimer += dt;
        // pushed off the position: player flanked in close, or held long enough
        if (dist < 6 || e.coverTimer > COVER_MAX) {
          e.state = 'ATTACK'; e.coverCooldown = COVER_COOLDOWN; e.coverSpot = null;
        }
        break;
    }

    // --- behaviour ---
    e.moving = false;
    e.crouchTarget = 0;
    e.peeking = false;
    // Round 8: while reeling from a hit the enemy staggers in place and holds
    // fire — the flinch pose is applied in _updateAnim. This sells "you shot him".
    if (e.hitReact > 0) {
      // reel only: no move, no fire
    } else if (e.state === 'PATROL') {
      this._patrol(e, dt);
    } else if (e.state === 'CHASE') {
      this._chase(e, dt, dx, dz, dist);
    } else if (e.state === 'ATTACK') {
      this._attack(e, dt, los, playerPos, onPlayerHit);
    } else if (e.state === 'SEEK_COVER') {
      // sprint to the spot in a half-crouch, weapon down
      e.crouchTarget = 0.4;
      this._moveTo(e, e.coverSpot.x, e.coverSpot.z, CHASE_SPEED, dt);
    } else if (e.state === 'COVER') {
      // hold the position and run a hide -> peek -> fire -> hide cycle
      const phase = e.coverTimer % PEEK_CYCLE;
      e.peeking = phase > PEEK_HIDE;
      e.crouchTarget = e.peeking ? 0.28 : 1.0;
      if (e.peeking) {
        this._attack(e, dt, los, playerPos, onPlayerHit);
      } else {
        // stay down: don't let the cooldown bank up while hidden
        e.cooldown = Math.max(e.cooldown, 0.3);
      }
    }

    // --- facing (smoothly turn toward the player when engaged) ---
    if (e.state === 'CHASE' || e.state === 'ATTACK' || e.state === 'COVER') {
      const desired = Math.atan2(-dx, -dz);
      e.group.rotation.y = lerpAngle(e.group.rotation.y, desired, 1 - Math.exp(-dt * 8));
    }
  }

  // Round 9: walk toward an explicit world point (used by SEEK_COVER).
  _moveTo(e, tx, tz, speed, dt) {
    const pos = e.group.position;
    const dx = tx - pos.x;
    const dz = tz - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    const nx = dx / d, nz = dz / d;
    this._move(e, nx, nz, speed, dt);
    e.moving = true;
    const desired = Math.atan2(-nx, -nz);
    e.group.rotation.y = lerpAngle(e.group.rotation.y, desired, 1 - Math.exp(-dt * 7));
  }

  _patrol(e, dt) {
    const t = e.patrolTarget;
    const pos = e.group.position;
    const dx = t.x - pos.x;
    const dz = t.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1) {
      e.patrolTarget = this._randomPatrolPoint();
      return;
    }
    const nx = dx / d;
    const nz = dz / d;
    this._move(e, nx, nz, PATROL_SPEED, dt);
    e.moving = true;
    const desired = Math.atan2(-nx, -nz);
    e.group.rotation.y = lerpAngle(e.group.rotation.y, desired, 1 - Math.exp(-dt * 6));
  }

  _chase(e, dt, dx, dz, dist) {
    if (dist < 0.001) return;
    const nx = dx / dist;
    const nz = dz / dist;
    this._move(e, nx, nz, CHASE_SPEED, dt);
    e.moving = true;
  }

  _attack(e, dt, los, playerPos, onPlayerHit) {
    e.cooldown -= dt;
    if (los && e.cooldown <= 0) {
      // First-shot grace: an enemy that just spotted the player holds fire for
      // a beat so the player can react, react to the threat, and not be
      // dropped during the trigger-down animation.
      if (e.firstSeenAt > 0 && this.simTime - e.firstSeenAt < FIRST_SHOT_GRACE) {
        e.cooldown = 0.05;
        return;
      }
      // Active-attacker cap: if the budget is full, the surplus enemies
      // suppress (still face the player, still tick the chamber, but hold fire
      // until a slot opens up). This is the single most important pacing fix.
      if (e.suppressed) { e.cooldown = 0.05; return; }
      // Distance-based accuracy: 55% at close range falling to 18% at 30m.
      // Real shooters don't land every round at long range — and the player
      // is rarely lucky enough to close the gap instantly, so this is what
      // gives the engagement a "ramp" instead of an instant kill.
      const dx = playerPos.x - e.group.position.x;
      const dz = playerPos.z - e.group.position.z;
      const dist = Math.hypot(dx, dz);
      const t = Math.max(0, Math.min(1, (dist - 18) / (ATTACK_RANGE - 18)));
      const acc = ACCURACY_NEAR + (ACCURACY_FAR - ACCURACY_NEAR) * t;
      if (Math.random() > acc) {
        // miss: still consumes cooldown, still spawns a tracer (so the player
        // can READ incoming fire and react), but no damage
        e.cooldown = e.shotJitter;
        this._fireVisualOnly(e, playerPos);
        return;
      }
      e.cooldown = e.shotJitter;
      this._fire(e, playerPos, onPlayerHit);
    }
  }

  // Spawn a tracer + muzzle flash but skip the onPlayerHit call (used for
  // visible misses so the player can see incoming fire and react).
  _fireVisualOnly(e, playerPos) {
    e.group.updateMatrixWorld(true);
    this._eye.set(e.group.position.x, e.group.position.y + 1.5, e.group.position.z);
    if (this._losDist(this._eye, playerPos) === null) return; // still blocked
    const muzzlePos = e.parts.weapon.localToWorld(this._muzzlePos.set(0, 0, -0.72));
    this._spawnMuzzleFlash(muzzlePos);
    this._spawnTracer(muzzlePos, playerPos);
  }

  _fire(e, playerPos, onPlayerHit) {
    e.group.updateMatrixWorld(true);
    // verify LOS at the instant of firing so the tracer never renders through walls
    this._eye.set(e.group.position.x, e.group.position.y + 1.5, e.group.position.z);
    if (this._losDist(this._eye, playerPos) !== null) return; // blocked: no shot, no tracer
    const muzzlePos = e.parts.weapon.localToWorld(this._muzzlePos.set(0, 0, -0.72));
    onPlayerHit(SHOT_DAMAGE_V2, muzzlePos);
    this._spawnMuzzleFlash(muzzlePos);
    this._spawnTracer(muzzlePos, playerPos);
  }

  // slide-style collision: cancel the blocked axis so the enemy glances off walls
  _move(e, nx, nz, speed, dt) {
    const pos = e.group.position;
    const r = e.radius;
    let nxPos = pos.x + nx * speed * dt;
    let nzPos = pos.z + nz * speed * dt;
    // cheap enemy-enemy separation: push out of nearby bodies (O(n^2), n is small)
    const minD = 0.9;
    for (const o of this.enemies) {
      if (o === e || !o.alive) continue;
      const dx = nxPos - o.group.position.x;
      const dz = nzPos - o.group.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD) {
        if (d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const push = (minD - d) * 0.5; // ease apart a few cm per frame
          nxPos += (dx / d) * push;
          nzPos += (dz / d) * push;
        } else {
          // exactly overlapping: nudge deterministically so they never stack
          nxPos += minD * 0.5;
        }
      }
    }
    if (this._pointBlocked(nxPos, pos.z, r)) nxPos = pos.x;
    if (this._pointBlocked(pos.x, nzPos, r)) nzPos = pos.z;
    nxPos = Math.max(-ARENA, Math.min(ARENA, nxPos));
    nzPos = Math.max(-ARENA, Math.min(ARENA, nzPos));
    pos.x = nxPos;
    pos.z = nzPos;
  }

  _pointBlocked(x, z, r) {
    for (const b of this.colliders) {
      if (
        x > b.min.x - r && x < b.max.x + r &&
        z > b.min.z - r && z < b.max.z + r
      ) return true;
    }
    return false;
  }

  _hasLOS(eye, target) {
    return this._losDist(eye, target) === null;
  }

  // returns distance to the first solid blocking the ray, or null if LOS is clear
  _losDist(eye, target) {
    const dir = this._tmpDir.subVectors(target, eye);
    const dist = dir.length();
    if (dist < 0.001) return null;
    dir.normalize();
    this.raycaster.set(eye, dir);
    this.raycaster.far = dist - 0.2; // only solids nearer than the player block LOS
    const hits = this.raycaster.intersectObjects(this.solids, false);
    if (hits.length === 0) return null;
    return hits[0].distance;
  }

  // ---- Visual life (bob + limb swing) ------------------------------------
  _updateAnim(e, dt) {
    e.animTime += dt;
    const pos = e.group.position;
    // Round 9: ease toward the requested crouch depth
    e.crouchAmt += (e.crouchTarget - e.crouchAmt) * Math.min(1, dt * 7);
    let bob = 0;

    // Round 8: hit reaction — the hostile throws its arms out to the sides
    // (detaching from the rifle), leans its torso back and snaps its head up,
    // with a brief whole-body stagger shudder. Classic readable flinch silhouette.
    // k goes 1 -> 0 over HITREACT_DUR so it peaks on impact and eases out.
    if (e.hitReact > 0) {
      const k = e.hitReact / HITREACT_DUR;
      // arms out to the sides — clearly separates the arms from the torso
      // (and from the rifle, which is parented to a fixed hands group).
      e.parts.leftArm.rotation.z  = -0.65 * k;
      e.parts.rightArm.rotation.z = +0.65 * k;
      // relax the forward grip slightly so the arms don't read as locked on
      e.parts.leftArm.rotation.x  = ARM_HOLD - 0.35 * k;
      e.parts.rightArm.rotation.x = ARM_HOLD - 0.35 * k;
      // torso jerks backward (away from impact), head snaps up
      e.parts.torso.rotation.x = -0.28 * k;
      e.parts.head.rotation.x  = -0.35 * k;
      e.group.rotation.z       = Math.sin(e.animTime * 26) * 0.06 * k; // shudder
      pos.y = e.baseY;
      this._applyCrouch(e, 0); // keep the crouch while reeling
      return; // skip the normal gait this frame
    }
    // ease any residual flinch transforms back to neutral
    e.parts.torso.rotation.x   += (0 - e.parts.torso.rotation.x)   * Math.min(1, dt * 10);
    e.parts.torso.rotation.z   += (0 - e.parts.torso.rotation.z)   * Math.min(1, dt * 10);
    e.parts.head.rotation.x    += (0 - e.parts.head.rotation.x)    * Math.min(1, dt * 10);
    e.parts.leftArm.rotation.z += (0 - e.parts.leftArm.rotation.z) * Math.min(1, dt * 10);
    e.parts.rightArm.rotation.z+= (0 - e.parts.rightArm.rotation.z)* Math.min(1, dt * 10);
    e.group.rotation.z         += (0 - e.group.rotation.z)         * Math.min(1, dt * 10);

    if (e.moving) {
      const swing = Math.sin(e.animTime * 10) * 0.5;
      e.parts.leftLeg.rotation.x = swing;
      e.parts.rightLeg.rotation.x = -swing;
      // bend the lower leg (knee) so the gait looks human instead of a windmill
      e.parts.leftLegKnee.rotation.x  = Math.max(0, -swing) * 0.9;
      e.parts.rightLegKnee.rotation.x = Math.max(0,  swing) * 0.9;
      // arms stay forward gripping the rifle, with a small holding-gait swing
      e.parts.leftArm.rotation.x = ARM_HOLD - swing * 0.3;
      e.parts.rightArm.rotation.x = ARM_HOLD + swing * 0.3;
      // non-negative bob so feet never dip below y=0
      bob = Math.max(0, Math.sin(e.animTime * 10)) * 0.05;
      pos.y = e.baseY + bob;
    } else {
      const k = 1 - Math.exp(-dt * 6);
      e.parts.leftLeg.rotation.x *= 1 - k;
      e.parts.rightLeg.rotation.x *= 1 - k;
      e.parts.leftLegKnee.rotation.x *= 1 - k;
      e.parts.rightLegKnee.rotation.x *= 1 - k;
      // ease arms back to the forward grip pose instead of hanging down
      e.parts.leftArm.rotation.x += (ARM_HOLD - e.parts.leftArm.rotation.x) * k;
      e.parts.rightArm.rotation.x += (ARM_HOLD - e.parts.rightArm.rotation.x) * k;
      bob = Math.max(0, Math.sin(e.animTime * 2)) * 0.02;
      pos.y = e.baseY + bob;
    }

    this._applyCrouch(e, bob);
  }

  // Round 9: fold the legs and drop the body so the hostile reads as ducked
  // behind a prop. Applied AFTER the gait so it overrides the leg swing; the
  // torso pitches forward and the head stays level (looking over the cover).
  _applyCrouch(e, bob) {
    const c = e.crouchAmt;
    if (c < 0.01) return;
    const bend = CROUCH_LEG * c;
    e.parts.leftLeg.rotation.x = bend;        // thigh forward
    e.parts.rightLeg.rotation.x = bend;
    e.parts.leftLegKnee.rotation.x = -bend;   // shin back to vertical
    e.parts.rightLegKnee.rotation.x = -bend;
    e.parts.torso.rotation.x += 0.24 * c;     // hunch over the cover
    e.parts.head.rotation.x -= 0.18 * c;      // keep the eyes on the player
    // arms tuck the rifle in tighter while ducked
    e.parts.leftArm.rotation.x += 0.22 * c;
    e.parts.rightArm.rotation.x += 0.22 * c;
    e.group.position.y = e.baseY + bob * (1 - c) - CROUCH_DROP * c;
  }

  _updateDeath(e, dt) {
    e.deathTimer += dt;
    const t = Math.min(1, e.deathTimer / 0.6);
    // fall about the HIP (top of torso), not the feet: tip backward ~85° and drop down
    if (e.deathBase === undefined) {
      e.deathBase = { x: e.group.position.x, z: e.group.position.z };
      e.deathDroop = {
        la: (Math.random() * 2 - 1) * 0.5,
        ra: (Math.random() * 2 - 1) * 0.5,
        lk: 0.3 + Math.random() * 0.6,
        rk: 0.3 + Math.random() * 0.6,
      };
    }
    const theta = -1.48 * t;          // ~85° backward
    const HIP_Y = 1.4;                // pivot height (top of torso) in group-local space
    const pivotY = e.baseY + HIP_Y * (1 - t) + 0.15 * t; // hip drops from standing to ground
    e.group.rotation.x = theta;
    e.group.position.x = e.deathBase.x;
    e.group.position.z = e.deathBase.z - HIP_Y * Math.sin(theta);
    e.group.position.y = pivotY - HIP_Y * Math.cos(theta);
    // limbs relax / dangle with a small random droop as the body goes down
    const k = Math.min(1, dt * 4);
    e.parts.leftArm.rotation.x  = lerpAngle(e.parts.leftArm.rotation.x,  ARM_HOLD + e.deathDroop.la, k);
    e.parts.rightArm.rotation.x = lerpAngle(e.parts.rightArm.rotation.x, ARM_HOLD + e.deathDroop.ra, k);
    e.parts.leftLeg.rotation.x  = lerpAngle(e.parts.leftLeg.rotation.x,  e.deathDroop.la * 0.6, k);
    e.parts.rightLeg.rotation.x = lerpAngle(e.parts.rightLeg.rotation.x, e.deathDroop.ra * 0.6, k);
    e.parts.leftLegKnee.rotation.x  = lerpAngle(e.parts.leftLegKnee.rotation.x,  e.deathDroop.lk, k);
    e.parts.rightLegKnee.rotation.x = lerpAngle(e.parts.rightLegKnee.rotation.x, e.deathDroop.rk, k);
  }

  // ---- Effects (pooled muzzle flash + tracer) -----------------------------
  // All effect geometry/materials/lights are built ONCE (here / in
  // _initEffectPools) and reused; recycling never disposes — only reset() does.
  _initEffectPools() {
    this._lastFatigue = -1; // reset anti-repeat tracker for the picker
    // flash light pool (shared PointLight, grows to at most 3)
    this._flashLightPool = [];
    this._flashes = [];
    this._flashLightCount = 0;
    const seed = new THREE.PointLight(0xffd27a, 0, 6, 2);
    this.scene.add(seed);
    this._flashLightPool.push(seed);
    this._flashLightCount = 1;
    // ENEMY2-2: muzzle flash is now a small canvas-textured star SPRITE (same approach as
    // the player's rifle _makeFlashTexture) instead of a glowing orange sphere. The texture
    // is built once and shared by every pooled sprite — no per-shot allocation.
    this._flashTex = this._makeFlashTexture();
    this._tracerGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 6);
    // muzzle-flash sprite pool
    this._flashMeshPool = [];
    this._flashMeshes = [];
    // tracer pool
    this._tracerPool = [];
    this._tracers = [];
  }

  _disposeEffectPools() {
    for (const f of this._flashes) this.scene.remove(f.light);
    for (const l of this._flashLightPool) this.scene.remove(l);
    for (const f of this._flashMeshes) { this.scene.remove(f.mesh); f.mesh.material.dispose(); }
    for (const m of this._flashMeshPool) m.material.dispose();
    for (const f of this._tracers) { this.scene.remove(f.mesh); f.mesh.material.dispose(); }
    for (const m of this._tracerPool) m.material.dispose();
    if (this._flashTex) this._flashTex.dispose();
    if (this._tracerGeo) this._tracerGeo.dispose();
    this._flashLightPool = [];
    this._flashes = [];
    this._flashMeshPool = [];
    this._flashMeshes = [];
    this._tracerPool = [];
    this._tracers = [];
  }

  _acquireFlashLight() {
    let light = this._flashLightPool.pop();
    if (!light && this._flashLightCount < 3) {
      light = new THREE.PointLight(0xffd27a, 0, 6, 2);
      this.scene.add(light);
      this._flashLightCount++;
    }
    // ENEMY2-2: reduced from 6 -> 4 so the flash light no longer blows out the scene
    if (light) light.intensity = 4;
    return light;
  }

  _acquireFlashMesh() {
    let mesh = this._flashMeshPool.pop();
    if (!mesh) {
      // small additive star sprite sharing the single built-once texture
      const mat = new THREE.SpriteMaterial({
        map: this._flashTex,
        color: 0xffd27a,
        transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      mesh = new THREE.Sprite(mat);
      mesh.visible = false;
      mesh.scale.setScalar(0.22); // small star
    }
    mesh.visible = true;
    mesh.material.opacity = 1;
    this.scene.add(mesh);
    return mesh;
  }

  _acquireTracer() {
    let mesh = this._tracerPool.pop();
    if (!mesh) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffd070, emissive: 0xffd070, emissiveIntensity: 1.5,
        transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      mesh = new THREE.Mesh(this._tracerGeo, mat);
      mesh.visible = false;
    }
    mesh.visible = true;
    mesh.material.opacity = 0.9;
    this.scene.add(mesh);
    return mesh;
  }

  _spawnMuzzleFlash(pos) {
    const light = this._acquireFlashLight();
    if (light) {
      light.position.copy(pos);
      light.intensity = 4;
      this._flashes.push({ light, life: 0.05, ttl: 0.05 });
    }
    const flash = this._acquireFlashMesh();
    if (flash) {
      flash.position.copy(pos);
      // small star: slight per-shot size + rotation variety so it reads as a flash
      const s = 0.2 + Math.random() * 0.08;
      flash.scale.setScalar(s);
      flash.material.rotation = Math.random() * Math.PI;
      this._flashMeshes.push({ mesh: flash, life: 0.07, ttl: 0.07, opacity: 1 });
    }
  }

  _spawnTracer(from, to) {
    const dir = this._tmpB.subVectors(to, from);
    const len = dir.length();
    if (len < 0.001) return;
    const mesh = this._acquireTracer();
    if (!mesh) return;
    dir.normalize();
    mesh.position.copy(from).addScaledVector(dir, len * 0.5);
    mesh.quaternion.setFromUnitVectors(this._tmpUp, dir);
    mesh.scale.set(1, len, 1);
    this._tracers.push({ mesh, life: 0.09, ttl: 0.09, opacity: 0.9 });
  }

  _updateEffects(dt) {
    // pooled flash lights: fade intensity to 0, then recycle
    for (let i = this._flashes.length - 1; i >= 0; i--) {
      const f = this._flashes[i];
      f.life -= dt;
      f.light.intensity = 4 * Math.max(0, f.life / f.ttl);
      if (f.life <= 0) {
        f.light.intensity = 0;
        this._flashLightPool.push(f.light);
        this._flashes.splice(i, 1);
      }
    }
    // muzzle-flash sprites
    for (let i = this._flashMeshes.length - 1; i >= 0; i--) {
      const f = this._flashMeshes[i];
      f.life -= dt;
      f.mesh.material.opacity = f.opacity * Math.max(0, f.life / f.ttl);
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        f.mesh.visible = false;
        this._flashMeshPool.push(f.mesh);
        this._flashMeshes.splice(i, 1);
      }
    }
    // tracers
    for (let i = this._tracers.length - 1; i >= 0; i--) {
      const f = this._tracers[i];
      f.life -= dt;
      f.mesh.material.opacity = f.opacity * Math.max(0, f.life / f.ttl);
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        f.mesh.visible = false;
        this._tracerPool.push(f.mesh);
        this._tracers.splice(i, 1);
      }
    }
  }

  // canvas-textured asymmetric star/streak flash (mirrors the player rifle's approach):
  // a bright core plus directional spikes. Built ONCE and shared by every pooled sprite.
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

  // ---- Public API ---------------------------------------------------------
  getHitboxes() {
    const out = [];
    for (const e of this.enemies) {
      if (!e.alive) continue;
      for (const m of e.hitboxes) out.push(m);
    }
    return out;
  }

  // Round 4: minimap snapshot — returns world (x,z) for every alive enemy.
  getEnemyPositions() {
    const out = [];
    const v = this._tmpA;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.group.getWorldPosition(v);
      out.push({ x: v.x, z: v.z });
    }
    return out;
  }

  damage(enemy, amount) {
    if (!enemy.alive) return false;
    enemy.health -= amount;
    if (enemy.health <= 0) {
      enemy.health = 0;
      enemy.alive = false;
      enemy.state = 'DEAD';
      enemy.deathTimer = 0;
      return true;
    }
    // Round 8: non-lethal hit -> start the flinch/stagger reaction.
    enemy.hitReact = HITREACT_DUR;
    return false;
  }

  remaining() {
    let n = 0;
    for (const e of this.enemies) if (e.alive) n++;
    return n;
  }

  // Round 8 debug: apply a non-lethal hit to the nearest alive enemy so the
  // headless harness can screenshot the flinch/stagger pose deterministically
  // (no need to land a precise raycast through the world).
  debugFlinchNearest(pos) {
    let best = null, bestD = Infinity;
    const p = pos || { x: 0, y: 0, z: 0 };
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.group.position.x - p.x;
      const dz = e.group.position.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) return null;
    this.damage(best, 20); // non-lethal -> sets hitReact (flinch)
    return {
      x: best.group.position.x,
      y: best.group.position.y,
      z: best.group.position.z,
      killed: !best.alive,
    };
  }

  // Round 9 debug: stage the nearest hostile fully ducked behind a real cover
  // prop relative to `pos`, so the headless harness can screenshot the crouch
  // deterministically. Returns the enemy spot + the cover box it is using.
  debugForceCover(pos) {
    let best = null, bestD = Infinity;
    const p = pos || { x: 0, y: 0, z: 0 };
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.group.position.x - p.x;
      const dz = e.group.position.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best || !this._coverBoxes.length) return null;

    // choose the cover box nearest to the PLAYER so the shot frames both.
    // Prefer a chest-high prop (top <= 1.7m): the peeking enemy's head sits at
    // ~1.7m, so a taller box would fully occlude it and the crouch wouldn't
    // read. Fall back to the nearest box of any height if none qualify.
    let box = null, boxD = Infinity;
    let boxLow = null, boxLD = Infinity;
    for (const c of this._coverBoxes) {
      const d = Math.hypot(c.cx - p.x, c.cz - p.z);
      if (d <= 3) continue;
      if (d < boxD) { boxD = d; box = c; }
      if (c.top <= 1.7 && d < boxLD) { boxLD = d; boxLow = c; }
    }
    box = boxLow || box;
    if (!box) return null;

    // stand the enemy on the far side of that box from the player
    let ux = p.x - box.cx, uz = p.z - box.cz;
    const ud = Math.hypot(ux, uz) || 1;
    ux /= ud; uz /= ud;
    const off = box.r + COVER_STAND;
    best.group.position.set(box.cx - ux * off, best.baseY, box.cz - uz * off);
    best.group.rotation.y = Math.atan2(-(p.x - best.group.position.x), -(p.z - best.group.position.z));
    best.health = Math.min(best.health, best.maxHealth * 0.4);
    best.state = 'COVER';
    best.coverSpot = { x: best.group.position.x, z: best.group.position.z, box };
    best.coverTimer = 0;
    best.hitReact = 0;
    best.crouchTarget = 1;
    best.crouchAmt = 1;
    this._applyCrouch(best, 0);
    return {
      x: best.group.position.x, z: best.group.position.z,
      boxX: box.cx, boxZ: box.cz, boxTop: box.top, boxR: box.r,
    };
  }

  reset() {
    for (const e of this.enemies) {
      this.scene.remove(e.group);
      this._disposeGroup(e.group);
    }
    this._disposeEffectPools();
    this._initEffectPools();
    this.enemies.length = 0;
  }

  _disposeGroup(group) {
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      // materials are shared across enemies — leave them intact
    });
  }
}
