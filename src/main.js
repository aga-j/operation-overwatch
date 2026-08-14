import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createRenderer, createComposer } from './core/renderer.js';
import { createInput } from './core/input.js';
import { Player } from './player/player.js';
import { buildArena } from './world/environment.js';
import { Rifle } from './weapons/rifle.js';
import { EnemyManager } from './enemies/enemy.js';
import { createHUD } from './ui/hud.js';
import { Sfx } from './audio/sfx.js';

// demo / playtest mode: bypass the pointer-lock gate + start overlay so a
// headless harness can drive the game and read telemetry.
const demoMode = new URLSearchParams(location.search).get('demo') === '1';

// ---------- renderer / scene / camera ----------
const renderer = createRenderer();
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = null; // sky dome (environment.js) provides the backdrop
// Round 6: warm dust-haze fog (exponential) for war-zone depth — matches the
// warm sky-horizon tint so the horizon reads as heat haze, not a gray wall.
scene.fog = new THREE.FogExp2(0xc9b58c, 0.014);

const camera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.rotation.order = 'YXZ';
scene.add(camera); // so the first-person viewmodel (child of camera) renders

// Image-based lighting so the metallic weapon and props read as real metal (not black).
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

// ---------- world ----------
const input = createInput(demoMode);
const env = buildArena(scene, renderer);

const player = new Player(camera, env.colliders, input);
const sfx = new Sfx();
const weapon = new Rifle(camera, scene, sfx);
const enemies = new EnemyManager(scene, env.colliders, env.solids);
enemies.spawn(8, env.spawnPoints);

// Round 11: snapshot where every hostile actually STARTED. Enemies patrol, so
// by the time a test looks at them they have moved — but the thing that has to
// be guaranteed is the spawn itself (nobody behind you at t=0). Captured here,
// asserted by __game.debugSpawnAudit().
const _spawnSnapshot = enemies.enemies.map((en) => ({
  x: +en.group.position.x.toFixed(2),
  z: +en.group.position.z.toFixed(2),
}));

const hud = createHUD();
hud.setEnemies(enemies.remaining());
hud.setHealth(player.health, player.maxHealth);

// Round 11: the allied teammate was REMOVED. It was purely cosmetic (never
// fought, never took cover, never drew fire), its silhouette was too close to
// the hostiles' to read at a glance, and no amount of spacing tuning stopped it
// from drifting around the player and breaking immersion. A lone-operator
// fantasy beats a useless escort. Do not re-add without real combat AI + a
// clearly friendly silhouette (helmet shape / patch / outline).

// ---------- shooting raycast ----------
const raycaster = new THREE.Raycaster();
const center = new THREE.Vector2(0, 0);
const _raycastTargets = [];
function raycastFn() {
  raycaster.setFromCamera(center, camera);
  _raycastTargets.length = 0;
  const hitboxes = enemies.getHitboxes();
  for (let i = 0; i < hitboxes.length; i++) _raycastTargets.push(hitboxes[i]);
  for (let i = 0; i < env.solids.length; i++) _raycastTargets.push(env.solids[i]);
  const hits = raycaster.intersectObjects(_raycastTargets, false);
  if (!hits.length) return null;
  const h = hits[0];
  const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
  return {
    point: h.point.clone(),
    normal,
    distance: h.distance,
    enemy: h.object.userData.enemy || null,
  };
}

// ---------- game state ----------
let gameOver = false;
let won = false;
let lastHealth = -999;
let lastHitAt = -999;          // sim time (s) of last player damage — drives regen delay
let playerHitCount = 0;        // debug telemetry
// Round 8: death-cam sequence state. While active the loop runs a slow-motion
// ramp (red wash + camera tilt) instead of normal play; null when not dying.
// ramp (red wash + camera tilt) instead of normal play; null when not dying.
let deathSeq = null;
const DEATH_CAM_DUR = 1.8;

// demo / playtest mode: hide the start overlay so the scene animates for a
// headless harness (pointer-lock gate is bypassed in the animate loop).
if (demoMode) {
  const _blocker = document.getElementById('blocker');
  if (_blocker) _blocker.style.display = 'none';
}

const blocker = document.getElementById('blocker');
renderer.domElement.addEventListener('click', () => {
  if (gameOver) { window.location.reload(); return; }
  renderer.domElement.requestPointerLock();
});
blocker.addEventListener('click', () => {
  if (gameOver) { window.location.reload(); return; }
  renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (locked) { sfx.init(); sfx.resume(); sfx.startWind(); } // user gesture → safe to start audio
  // While dying (death cam) or after the round ends, the message overlay owns
  // the screen — don't pop the start blocker back up.
  if (gameOver || deathSeq) return;
  blocker.style.display = locked ? 'none' : 'flex';
});

function onEnemyHit(enemy, point, distance) {
  const killed = enemies.damage(enemy, 26);
  hud.hitMarker(killed);
  if (killed) {
    hud.killFeed('HOSTILE ELIMINATED');
    hud.setEnemies(enemies.remaining());
  }
}
function onRecoil(kick) { player.addRecoil(kick); }
function onPlayerHit(dmg, muzzlePos) {
  if (!player.alive) return;
  player.takeDamage(dmg);
  lastHitAt = performance.now() / 1000;
  playerHitCount++;
  hud.setHealth(player.health, player.maxHealth);
  hud.damageFlash(0.9);
  player.addHitKick(0.9);                 // Round 8: camera kick on hit
  if (sfx.enabled) sfx.playerHurt();      // Round 8: pain cue
  if (!player.alive && !deathSeq) {
    // Round 8: begin the death-cam slow-mo sequence (ends in endGame).
    deathSeq = { t: 0, dur: DEATH_CAM_DUR };
    document.exitPointerLock();
  }
}

function endGame(victory) {
  if (gameOver) return;
  gameOver = true;
  won = victory;
  document.exitPointerLock();
  if (deathSeq) { deathSeq = null; hud.clearDeath(); post.setDeathMix(0); }
  hud.showMessage(victory ? 'VICTORY\nAll hostiles eliminated' : 'YOU DIED\nClick to redeploy');
}

// Round 8: advance the death-cam sequence by dt. Shared by the real-play rAF
// loop (non-manual) and the headless tick() harness (manual) so the slow-mo +
// red wash + camera tilt ramp identically in both. Ends by calling endGame.
function advanceDeath(dt) {
  deathSeq.t += dt;
  const prog = Math.min(1, deathSeq.t / deathSeq.dur);
  player.deathT = prog * DEATH_CAM_DUR;
  const slow = Math.max(0.0001, dt * (1 - 0.55 * prog)); // ease into slow-mo
  stepGame(slow);
  hud.rampDeath(prog);
  post.setDeathMix(prog * 0.85);
  if (deathSeq.t >= deathSeq.dur) {
    deathSeq = null;
    hud.clearDeath();
    post.setDeathMix(0);
    endGame(false);
  }
}
function winGame() { endGame(true); }

// ---------- loop ----------
const post = createComposer(renderer, scene, camera);
const clock = new THREE.Clock();

// In demo + ?manual=1 mode the simulation is advanced by an external harness
// calling __game.tick(dt); the rAF loop only renders. This makes headless
// playtests deterministic and immune to requestAnimationFrame throttling.
const manualTick = demoMode && new URLSearchParams(location.search).get('manual') === '1';

function stepGame(dt) {
  player.update(dt);
  weapon.update(dt, input, raycastFn, onEnemyHit, onRecoil);
  enemies.update(dt, player.position, onPlayerHit);
  // Round 12: passive regen after PLAYER_REGEN_DELAY seconds without taking
  // a hit. Real CoD/FPS games do this so a single mistake doesn't snowball
  // into an instant death the moment you peek a second enemy.
  if (player.alive && player.health < player.maxHealth
    && performance.now() / 1000 - lastHitAt > 4.0) {
    const before = player.health;
    player.health = Math.min(player.maxHealth, player.health + 9 * dt);
    if (player.health !== before) hud.setHealth(player.health, player.maxHealth);
  }
  if (player.health !== lastHealth) {
    hud.setHealth(player.health, player.maxHealth);
    lastHealth = player.health;
  }
  hud.setAmmo(weapon.ammo, weapon.reserve);
  hud.setReloading(weapon.reloading);
  if (enemies.remaining() === 0) winGame();
}

let stepAccum = 0; // Round 6: distance traveled since last footstep
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // Round 5: animate flag/beacon regardless of game state (alive on the menu too).
  if (env && env.update) env.update(dt);

  // Round 8: death-cam sequence — slow-mo + red wash + camera tilt ramp, then
  // endGame. Driven by advanceDeath() (below). In real play it runs off rAF here
  // (guarded so it only fires when NOT in manual/test mode, where tick() drives it).
  if (deathSeq && !manualTick) {
    advanceDeath(dt);
    post.render();
    return;
  }

  if (!manualTick && ((demoMode || document.pointerLockElement === renderer.domElement) && !gameOver) && !deathSeq) {
    stepGame(dt);

    // Round 6: footstep cadence from horizontal velocity (audio only — silent in
    // headless/demo because sfx.enabled is false until a real pointer-lock gesture).
    if (sfx.enabled) {
      const speed = Math.hypot(player.velocity.x, player.velocity.z);
      if (speed > 0.6) {
        stepAccum += speed * dt;
        if (stepAccum > 0.9) { stepAccum = 0; sfx.step(); }
      } else {
        stepAccum = Math.max(0, stepAccum - dt * 2); // reset between strides
      }
    }
  }

  post.render();
}

// ---------------------------------------------------------------------------
// Round 11: SHADER / TEXTURE PRE-WARM.
//
// Nothing in this project ever called renderer.compile(). With ~1300 meshes and
// PCF-soft shadow maps, the first time the player turned to face an object
// whose material variant had not been seen yet, Three.js compiled and linked a
// GLSL program on the main thread — a synchronous stall of tens to hundreds of
// milliseconds. Mouse events piled up during that stall and the frame that
// finally landed applied all of them at once. THAT is the real cause of the
// "while walking and turning, the view sometimes suddenly whips past" report:
// a render hitch, not the mouse. (The input-side spike filter and the per-frame
// turn cap are the belt; this is the braces.)
//
// Two passes:
//   1. force every object visible — pooled tracers, impact decals, casings and
//      muzzle flashes all start hidden and compile() only walks VISIBLE objects
//      — then compile the whole graph and restore visibility;
//   2. sweep the camera through a full 360 plus look-up/look-down so the
//      shadow-depth program variants, the post-processing stack and every
//      texture upload happen now, behind the "click to start" blocker.
// ---------------------------------------------------------------------------
function prewarmRenderer() {
  const t0 = performance.now();
  const savedPos = camera.position.clone();
  const savedRot = camera.rotation.clone();

  const hidden = [];
  scene.traverse((o) => { if (o.visible === false) { hidden.push(o); o.visible = true; } });
  camera.position.copy(player.position);
  camera.updateMatrixWorld(true);
  try { renderer.compile(scene, camera); } catch (e) { /* non-fatal: warm-up only */ }
  for (const o of hidden) o.visible = false;

  // A headless run only needs a token sweep — SwiftShader compiles are glacial
  // and the QA harness has timeouts. Real play gets the full turn. Both are
  // capped by a wall-clock budget so a slow machine degrades to "some warming"
  // rather than a multi-second freeze at load.
  const steps = demoMode ? 2 : 8;
  const budgetMs = demoMode ? 2500 : 6000;
  const overBudget = () => performance.now() - t0 > budgetMs;
  for (let i = 0; i < steps && !overBudget(); i++) {
    camera.rotation.set(0, (i / steps) * Math.PI * 2, 0, 'YXZ');
    camera.updateMatrixWorld(true);
    post.render();
  }
  if (!demoMode) {
    for (const p of [-1.2, 1.2]) {
      if (overBudget()) break;
      camera.rotation.set(p, 0, 0, 'YXZ');
      camera.updateMatrixWorld(true);
      post.render();
    }
  }

  camera.position.copy(savedPos);
  camera.rotation.copy(savedRot);
  camera.updateMatrixWorld(true);
  return Math.round(performance.now() - t0);
}
const prewarmMs = prewarmRenderer();

// Warm-up done — the blocker can honestly invite the click now.
{
  const _startline = document.getElementById('startline');
  if (_startline) {
    _startline.textContent = '▶ CLICK TO ENTER THE FIELD';
    _startline.style.opacity = '1';
  }
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight);
});

// ---------- playtest / debug telemetry (demo mode only) ----------
// Exposes live game state so an automated playtest harness can drive inputs
// and sample results, plus a deterministic `aim()` used to line up shots.
if (demoMode) {
  const _v = new THREE.Vector3();
  // Round 4: cache the minimap snapshot so the per-frame HUD canvas doesn't
  // pay for the gather work twice (state + minimap both poll the same arrays).
  const _mmBuildings = (env.buildings || []).map((b) => ({ x: b.x, z: b.z, w: b.w, d: b.d, rot: b.rot }));
  const _mmBounds = { maxX: env.bounds.max.x };
  const _mmEnemies = [];
  let _mmDirty = true;

  function refreshMinimapSnapshot() {
    _mmEnemies.length = 0;
    for (const en of enemies.enemies) {
      if (!en.alive) continue;
      en.group.getWorldPosition(_v);
      _mmEnemies.push({ x: _v.x, z: _v.z });
    }
    _mmDirty = false;
  }

  window.__game = {
    getState() {
      if (_mmDirty) refreshMinimapSnapshot();
      return {
        t: Math.round(performance.now()),
        health: player.health,
        maxHealth: player.maxHealth,
        alive: player.alive,
        pos: [+player.position.x.toFixed(2), +player.position.y.toFixed(2), +player.position.z.toFixed(2)],
        vel: [+player.velocity.x.toFixed(2), +player.velocity.y.toFixed(2), +player.velocity.z.toFixed(2)],
        yaw: +player.yaw.toFixed(4),
        pitch: +player.pitch.toFixed(4),
        recoil: +player.recoil.toFixed(4),
        grounded: player.grounded,
        enemiesAlive: enemies.remaining(),
        enemiesTotal: enemies.enemies.length,
        enemyPos: _mmEnemies.map((p) => [+p.x.toFixed(2), 0, +p.z.toFixed(2)]),
        ammo: weapon.ammo,
        reserve: weapon.reserve,
        reloading: weapon.reloading,
        gameOver,
        won,
        // renderer.info reflects the composer's last pass (often a single
        // fullscreen triangle), which is misleading. Use the actual scene mesh
        // count to confirm geometry was built.
        meshes: (() => { let n = 0; scene.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
      };
    },
    // Round 11: spawn-layout guard. Audits where every hostile STARTED against
    // the same contract buildSpawnPoints used. `behind` must be 0 and `minDist`
    // must clear the safe radius — a hostile spawning at your back is a P0, not
    // a difficulty setting. Angles are degrees off the player's forward (-Z).
    debugSpawnAudit() {
      const R = (env && env.spawnRules) || { playerStart: { x: 0, z: 8 }, safeRadius: 28, rearLine: -6, fanDeg: 61 };
      const rows = _spawnSnapshot.map((p) => {
        const dx = p.x - R.playerStart.x;
        const dz = p.z - R.playerStart.z;
        const dist = Math.hypot(dx, dz);
        // forward is -Z, so cos(angle) = -dz / dist
        const ang = Math.acos(Math.max(-1, Math.min(1, (-dz) / (dist || 1)))) * 180 / Math.PI;
        return {
          x: p.x, z: p.z,
          dist: +dist.toFixed(2),
          ang: +ang.toFixed(1),
          behind: ang > 90 || p.z > R.rearLine,
          outsideFan: ang > R.fanDeg + 0.5,
          tooClose: dist < R.safeRadius - 0.01,
        };
      });
      return {
        rules: R,
        count: rows.length,
        behind: rows.filter((r) => r.behind).length,
        outsideFan: rows.filter((r) => r.outsideFan).length,
        tooClose: rows.filter((r) => r.tooClose).length,
        minDist: rows.length ? +Math.min(...rows.map((r) => r.dist)).toFixed(2) : 0,
        maxAng: rows.length ? +Math.max(...rows.map((r) => r.ang)).toFixed(1) : 0,
        rows,
      };
    },
    // Round 11: mouse-look health. `spikes` counts single mousemove events
    // rejected as browser artifacts (Chrome's pointer-lock re-centre bug);
    // `carry` is rotation deferred by the per-frame turn cap — it should always
    // drain back to 0 within a few frames.
    debugLookStats() {
      return {
        spikes: input.lookSpikes | 0,
        swallowed: input.lookSwallowed | 0,
        carry: [+(player._lookCarryX || 0).toFixed(5), +(player._lookCarryY || 0).toFixed(5)],
        yaw: +player.yaw.toFixed(4),
        pitch: +player.pitch.toFixed(4),
        prewarmMs,
      };
    },
    // Round 11: fire a synthetic pointer-lock spike at the input layer so the
    // rejection filter can be proven in an automated run rather than trusted.
    debugInjectLookSpike(px = 3000) {
      window.dispatchEvent(new MouseEvent('mousemove', { movementX: px, movementY: px }));
    },
    // deterministic aim helper (bypasses the mouse path; mouse-look itself is
    // validated separately in the playtest). Sets yaw/pitch directly.
    aim(yaw, pitch) {
      player.yaw = yaw;
      player.pitch = Math.max(-1.5, Math.min(1.5, pitch));
      // Round 10: also sync the camera immediately so a headless reviewer's
      // frame-read reflects the aimed pose even when stepGame is gated.
      camera.position.copy(player.position);
      camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
      _mmDirty = true;
    },
    // advance the simulation by a fixed dt (manual mode only). Returns nothing.
    tick(dt) {
      if (!gameOver) {
        // Round 8: when dying, drive the death cam through tick() so the headless
        // harness (where rAF is throttled) advances it deterministically.
        if (deathSeq && manualTick) advanceDeath(dt);
        else stepGame(dt);
      }
      _mmDirty = true;
    },
    // force a render so screenshots reflect the latest simulation state.
    render() { post.render(); },
    // Round 4: minimap snapshot — cheap view into player position + enemies +
    // building footprints for the HUD canvas to redraw each frame.
    getMinimapSnapshot() {
      if (_mmDirty) refreshMinimapSnapshot();
      return {
        playerX: player.position.x,
        playerZ: player.position.z,
        playerYaw: player.yaw,
        enemies: _mmEnemies,
        buildings: _mmBuildings,
        bounds: _mmBounds,
      };
    },
    // Round 7: expose the weapon + a blood debug hook for headless verification
    // (spawns a real blood burst ~3.5m ahead at chest height).
    _weapon: weapon,
    // Round 8: apply damage through the real onPlayerHit path (kick + flash +
    // sound + death sequence). Used by the headless verification harness.
    damagePlayer(dmg) { onPlayerHit(dmg, null); },
    // Round 8: force the nearest enemy into its hit-reaction flinch (for screenshot).
    debugFlinch() { return enemies.debugFlinchNearest(player.position); },
    // Round 8: stage a close-up flinch shot — teleport the player ~3m back from
    // the nearest enemy, face it, and trigger the flinch so the arms-up pose
    // reads clearly in the screenshot.
    debugStageFlinch() {
      let best = null, bestD = Infinity;
      const p = player.position;
      for (const e of enemies.enemies) {
        if (!e.alive) continue;
        const dx = e.group.position.x - p.x;
        const dz = e.group.position.z - p.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = e; }
      }
      if (!best) return null;
      const ex = best.group.position.x, ez = best.group.position.z;
      const dx = ex - p.x, dz = ez - p.z;
      const d = Math.hypot(dx, dz) || 1;
      const nx = dx / d, nz = dz / d;
      player.position.set(ex - nx * 3.0, 1.7, ez - nz * 3.0);
      player.velocity.set(0, 0, 0);
      player.yaw = Math.atan2(-nx, -nz);
      player.pitch = -0.06;
      enemies.damage(best, 20); // non-lethal -> flinch
      best.cooldown = 1.5; // hold fire during the screenshot so no stray shot flashes red
      return { ex, ez, d };
    },
    // Round 8: snap the player back to the original spawn so post-flinch shots
    // use the original wide-arena view.
    debugResetPlayer() {
      player.position.set(0, 1.7, 8);
      player.velocity.set(0, 0, 0);
      player.yaw = 0;
      player.pitch = 0;
      player.recoil = 0;
      player.hitKick = 0;
      // Round 11: drop any rotation the per-frame look cap deferred, plus the
      // raw accumulator, so a reset really is a clean slate for the next check.
      player._lookCarryX = 0;
      player._lookCarryY = 0;
      input.mouseDX = 0;
      input.mouseDY = 0;
      player.deathT = 0;
      player.alive = true;
      player.health = player.maxHealth;
      // Round 10: a full un-die so automated scenarios can re-run after a death
      // without the gameOver guard freezing stepGame (which would otherwise
      // make every later check read a stale frame).
      gameOver = false;
      won = false;
      deathSeq = null;
      if (hud && hud.clearDeath) hud.clearDeath();
      // Round 12: regen bookkeeping
      lastHitAt = -999;
      playerHitCount = 0;
    },
    debugBlood() {
      const fwd = new THREE.Vector3(0, 0, -1).applyEuler(
        new THREE.Euler(0, player.yaw, 0)
      );
      const p = new THREE.Vector3(
        player.position.x + fwd.x * 3.5,
        player.position.y + 0.2,
        player.position.z + fwd.z * 3.5
      );
      weapon._spawnBlood(p);
    },

    // Round 10: self-QA hook — a per-enemy snapshot so an automated reviewer
    // can measure AI behaviour objectively: engagement (distance to player),
    // wounded-cover (health<60 AND state in COVER/SEEK_COVER), and
    // friendly-fire (alive count dropping with no player input).
    debugEnemies() {
      const out = [];
      for (const e of enemies.enemies) {
        const dx = e.group.position.x - player.position.x;
        const dz = e.group.position.z - player.position.z;
        out.push({
          alive: e.alive,
          health: +e.health.toFixed(1),
          state: e.state || '?',
          dist: +Math.hypot(dx, dz).toFixed(2),
          x: +e.group.position.x.toFixed(2),
          z: +e.group.position.z.toFixed(2),
          suppressed: !!e.suppressed,
          sinceFirstSeen: e.firstSeenAt > 0
            ? +(enemies.simTime - e.firstSeenAt).toFixed(2) : -1,
        });
      }
      return out;
    },
    // Round 12: combat-telemetry snapshot for the play session harness
    debugCombatStats() {
      return {
        activeAttackers: enemies.enemies.filter((e) => e.alive && e.state === 'ATTACK' && !e.suppressed).length,
        suppressed: enemies.enemies.filter((e) => e.alive && e.suppressed).length,
        total: enemies.enemies.length,
        alive: enemies.enemies.filter((e) => e.alive).length,
        simTime: +enemies.simTime.toFixed(2),
        playerHitCount,
        lastHitAgoSec: lastHitAt < 0 ? -1 : +((performance.now() / 1000) - lastHitAt).toFixed(2),
      };
    },
    // Round 10: self-QA hook — wound the nearest alive enemy by `dmg` so the
    // reviewer can verify the wounded->cover behaviour without a full firefight.
    debugDamageNearest(dmg) {
      let best = null, bestD = Infinity;
      for (const e of enemies.enemies) {
        if (!e.alive) continue;
        const dx = e.group.position.x - player.position.x;
        const dz = e.group.position.z - player.position.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = e; }
      }
      if (!best) return null;
      enemies.damage(best, dmg);
      return { health: +best.health.toFixed(1), state: best.state };
    },
    // Round 10: self-QA hook — place the player `dist` metres from the nearest
    // enemy, facing it, so engagement/attack/cover behaviours are testable
    // deterministically instead of depending on the random spawn layout.
    debugTeleportNearEnemy(dist) {
      let best = null, bestD = Infinity;
      for (const e of enemies.enemies) {
        if (!e.alive) continue;
        const dx = e.group.position.x - player.position.x;
        const dz = e.group.position.z - player.position.z;
        const d = Math.hypot(dx, dz);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (!best) return null;
      const ex = best.group.position.x, ez = best.group.position.z;
      const dx = player.position.x - ex, dz = player.position.z - ez;
      const d = Math.hypot(dx, dz) || 1;
      const nx = ex + (dx / d) * dist, nz = ez + (dz / d) * dist;
      player.position.set(nx, 1.7, nz);
      player.velocity.set(0, 0, 0);
      player.yaw = Math.atan2(-(ex - nx), -(ez - nz));
      player.pitch = 0;
      camera.position.copy(player.position);
      camera.rotation.set(0, player.yaw, 0, 'YXZ');
      return { dist, enemyState: best.state, ex: +ex.toFixed(1), ez: +ez.toFixed(1) };
    },

    // Round 10: self-QA hook — drive the PLAYER along its real facing so the
    // headless review can walk/turn exactly as a human would. fwd is metres to
    // move along the player's current forward, dyaw radians to add to yaw.
    // Caller still calls tick(dt) afterwards to advance the sim.
    debugDrivePlayer(fwd, dyaw) {
      const yaw = player.yaw || 0;
      player.position.x += Math.sin(yaw) * fwd;
      player.position.z += -Math.cos(yaw) * fwd;
      if (dyaw) player.yaw += dyaw;
      _mmDirty = true;
    },

    // Round 11: teammate removed — the review harness now asserts that NO
    // friendly actor exists near the player. Returns the count of scene objects
    // tagged as allies (must stay 0) so a re-introduction can never silently
    // slip back in without being reviewed.
    debugAllyCount() {
      let n = 0;
      scene.traverse((o) => { if (o.userData && o.userData.ally) n++; });
      return n;
    },
    // Round 9: stage a crouched hostile in hard cover and frame it for a shot.
    // debugForceCover() drops the nearest enemy into a full crouch behind the
    // nearest usable cover prop (relative to the player); we then stand the
    // player on the near side of that same prop and nudge the enemy's peek phase
    // so the harness reveals a leaning, rifle-up "using cover" pose.
    debugStageCover() {
      const r = enemies.debugForceCover(player.position);
      if (!r) return null;
      const B = new THREE.Vector3(r.boxX, 0, r.boxZ);
      const E = new THREE.Vector3(r.x, 0, r.z);
      const u = B.clone().sub(E); u.y = 0;
      if (u.lengthSq() < 1e-4) u.set(0, 0, 1);
      u.normalize();
      const viewDist = r.boxR + 2.5;
      player.position.set(B.x + u.x * viewDist, 1.7, B.z + u.z * viewDist);
      player.velocity.set(0, 0, 0);
      player.yaw = Math.atan2(-(r.x - player.position.x), -(r.z - player.position.z));
      player.pitch = -0.05;
      // find that enemy and force the FULL-CROUCH (hide) phase so the duck
      // reads clearly. PEEK (c=0.28) is nearly upright — at distance it looks
      // like a standing soldier. For a chest-high prop (~1m) the crouched head
      // still pokes above the box, so we get a clean "ducked behind cover"
      // silhouette with rifle tucked and legs bent.
      const e = enemies.enemies.find(
        (en) => en.alive && Math.abs(en.group.position.x - r.x) < 0.6 && Math.abs(en.group.position.z - r.z) < 0.6
      );
      if (e) {
        e.coverTimer = 0.4;          // well inside the hide window (PEEK_HIDE=1.9)
        e.crouchTarget = 1.0;        // full duck
        e.crouchAmt = 1.0;           // snap immediately, no ease-in flicker
        e.cooldown = 1.5;            // hold fire during the screenshot
        e.hitReact = 0;
      }
      return { ...r, viewDist };
    },
    // Round 9: stamp a sustained-fire burst of persistent bullet holes + dust
    // on a real building wall. Picks the LARGEST tall collider (a building
    // wall, not a thin prop), stands the player 4m OUTSIDE the face that
    // faces the spawn, raycasts against the real solid meshes to anchor on
    // the visible surface (handles rotated meshes), lifts the anchor to chest
    // height along the wall's vertical tangent, then reframes the player 3.5m
    // OUTSIDE the real wall surface facing the chest point and sprays decals
    // + dust across it.
    debugWallImpacts() {
      // pick the nearest TALL collider (proven to hit a real wall under the raycast);
      // h>2.2 already excludes the 0.6-2.0m cover props and keeps walls/buildings
      let wall = null, wallD = Infinity;
      for (const b of env.colliders) {
        const h = b.max.y - b.min.y;
        if (h < 2.2) continue;
        const cx = (b.min.x + b.max.x) / 2;
        const cz = (b.min.z + b.max.z) / 2;
        const dd = Math.hypot(cx - player.position.x, cz - player.position.z);
        if (dd < wallD) { wallD = dd; wall = b; }
      }
      if (!wall) return null;

      const cx = (wall.min.x + wall.max.x) / 2;
      const cz = (wall.min.z + wall.max.z) / 2;
      const faces = [
        { n: new THREE.Vector3(1, 0, 0),  px: wall.max.x, pz: cz },
        { n: new THREE.Vector3(-1, 0, 0), px: wall.min.x, pz: cz },
        { n: new THREE.Vector3(0, 0, 1),  px: cx, pz: wall.max.z },
        { n: new THREE.Vector3(0, 0, -1), px: cx, pz: wall.min.z },
      ];
      // pick the face whose outward normal best faces the player (so the
      // initial camera ends up on the exterior, not inside the building)
      let bestFace = faces[0], bestDot = -Infinity;
      for (const f of faces) {
        const toP = new THREE.Vector3(player.position.x - f.px, 0, player.position.z - f.pz);
        const dot = toP.x * f.n.x + toP.z * f.n.z;
        if (dot > bestDot) { bestDot = dot; bestFace = f; }
      }
      const fx = bestFace.px, fz = bestFace.pz, nrm = bestFace.n;
      // initial placement: 4m OUTSIDE the face (exterior), looking at it
      player.position.set(fx + nrm.x * 4, 1.7, fz + nrm.z * 4);
      player.velocity.set(0, 0, 0);
      player.yaw = Math.atan2(-(fx - player.position.x), -(fz - player.position.z));
      player.pitch = -0.04;
      camera.position.copy(player.position);
      camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');

      raycaster.setFromCamera(center, camera);
      const hits = raycaster.intersectObjects(env.solids, false);
      if (!hits.length) return null;
      const hit = hits[0];
      const anchor = hit.point.clone();
      // hN = world-space outward normal of the real surface (toward the camera)
      const hN = (hit.face
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
        : nrm.clone()).normalize();

      const up = Math.abs(hN.y) > 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
      const tangent = new THREE.Vector3().crossVectors(up, hN).normalize();
      const bitan = new THREE.Vector3().crossVectors(hN, tangent).normalize();

      const chestY = 1.5;
      const dy = chestY - anchor.y;
      const chest = anchor.clone().addScaledVector(bitan, dy);

      // reframe 3.5m OUTSIDE the real wall (+hN = toward the camera = away
      // from the wall interior), facing the chest point
      player.position.set(chest.x + hN.x * 3.5, 1.7, chest.z + hN.z * 3.5);
      player.velocity.set(0, 0, 0);
      player.yaw = Math.atan2(-(chest.x - player.position.x), -(chest.z - player.position.z));
      player.pitch = -0.02;
      camera.position.copy(player.position);
      camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');

      const N = 14, patchW = 1.1, patchH = 0.8;
      for (let i = 0; i < N; i++) {
        const u = (Math.random() - 0.5) * patchW;
        const v = (Math.random() - 0.5) * patchH;
        const p2 = chest.clone()
          .addScaledVector(tangent, u)
          .addScaledVector(bitan, v);
        weapon._spawnImpact(p2, hN.clone());
      }
      return { chest: chest.toArray(), hN: [hN.x, hN.y, hN.z], hits: N };
    },
  };
}
