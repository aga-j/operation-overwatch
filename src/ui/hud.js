// ============================================================================
//  hud.js — Self-contained Three.js FPS HUD (plain DOM + CSS, no imports)
// ============================================================================

export function createHUD() {
  // ---- Root overlay (never intercepts pointer events) ----------------------
  const root = document.createElement('div');
  root.id = 'hud-root';
  root.setAttribute('role', 'presentation');

  // ---- P2#17 / Round 4: the military "Black Ops One" font is now vendored
  //      locally via index.html's @font-face, so no runtime network call. ----

  // ---- Inject all CSS once ------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #hud-root {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 9000;
      font-family: "Black Ops One", "Stencil", "Impact", "Segoe UI", system-ui, sans-serif;
      color: #d6dde4;
      text-shadow: 0 1px 3px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.5);
      user-select: none;
      -webkit-user-select: none;
      letter-spacing: 1px;
    }
    #hud-root * { box-sizing: border-box; }

    :root {
      --accent: #d0d8e0;
      --accent-dim: #a0a8b0;
      --hp-good: #e8f0e0;
      --hp-mid: #ffb000;
      --hp-low: #ff3b30;
    }

    /* Round 4: stencil/military font for ALL HUD text (Black Ops One + tabular nums) */
    .hud-monofont {
      font-family: "Black Ops One", "Stencil", "Impact", "Segoe UI", system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      font-weight: 400;
      letter-spacing: 1.5px;
    }

    /* ---- Round 4: Minimap (top-left, circular, rotates with player) ------- */
    #hud-minimap-wrap {
      position: absolute;
      top: 18px; left: 18px;
      width: 168px; height: 168px;
      display: flex; flex-direction: column; align-items: center; gap: 6px;
    }
    #hud-minimap {
      width: 168px; height: 168px;
      background: radial-gradient(circle at center, rgba(8,12,16,0.78), rgba(2,4,6,0.92));
      border: 1.5px solid rgba(208,216,224,0.45);
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(0,0,0,0.8), 0 0 14px rgba(0,0,0,0.6);
      display: block;
    }
    #hud-minimap-label {
      font-size: 11px;
      letter-spacing: 4px;
      color: #cfd6dc;
      text-shadow: 0 0 6px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.9);
    }
    #hud-minimap-label .dot {
      display: inline-block;
      width: 6px; height: 6px;
      background: #ff3b30;
      border-radius: 50%;
      vertical-align: middle;
      margin: 0 4px 2px 0;
      box-shadow: 0 0 6px rgba(255,59,48,0.9);
      animation: radar-pulse 1.2s ease-in-out infinite;
    }
    @keyframes radar-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

    /* ---- Crosshair ------------------------------------------------------ */
    #hud-crosshair {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 26px; height: 26px;
    }
    .ch-tick {
      display: block;
      position: absolute;
      background: rgba(255,255,255,0.95);
    }
    /* P2#30: open crosshair — ticks start ~3px from center, no closed plus */
    .ch-tick.top, .ch-tick.bottom { width: 6px;   height: 1.5px; left: 50%; }
    .ch-tick.left, .ch-tick.right { width: 1.5px; height: 6px; top: 50%; }
    .ch-tick.top    { top: 50%; transform: translate(-50%, calc(-50% - 4px)); }
    .ch-tick.bottom { top: 50%; transform: translate(-50%, calc(-50% + 4px)); }
    .ch-tick.left   { left: 50%; transform: translate(calc(-50% - 4px), -50%); }
    .ch-tick.right  { left: 50%; transform: translate(calc(-50% + 4px), -50%); }
    /* P2#HUD2-1: faint outer ring so the reticle reads as one unit */
    #hud-crosshair::before {
      content: "";
      position: absolute;
      top: 50%; left: 50%;
      width: 11px; height: 11px;
      border: 1px solid rgba(255,255,255,0.4);
      border-radius: 50%;
      transform: translate(-50%, -50%);
    }
    /* tiny center dot — softened (no hard white blowout), restrained non-neon */
    #hud-crosshair::after {
      content: "";
      position: absolute;
      top: 50%; left: 50%;
      width: 2px; height: 2px;
      background: rgba(255,255,255,0.7);
      border-radius: 50%;
      transform: translate(-50%, -50%);
    }

    /* Hitmarker */
    #hud-hitmarker {
      position: absolute;
      top: 50%; left: 50%;
      width: 22px; height: 22px;
      transform: translate(-50%, -50%) scale(0.6);
      opacity: 0;
      transition: transform 140ms ease-out, opacity 140ms ease-out;
    }
    #hud-hitmarker .hm {
      position: absolute;
      width: 9px; height: 2px;
      background: #ffffff;
      box-shadow: 0 0 6px rgba(255,255,255,0.9);
      top: 50%; left: 50%;
    }
    #hud-hitmarker .hm.tr { transform: translate(-50%,-50%) rotate(45deg); }
    #hud-hitmarker .hm.tl { transform: translate(-50%,-50%) rotate(-45deg); }
    #hud-hitmarker .hm.br { transform: translate(-50%,-50%) rotate(-45deg); }
    #hud-hitmarker .hm.bl { transform: translate(-50%,-50%) rotate(45deg); }
    #hud-hitmarker.show {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1.1);
    }
    /* P2#19: KILL feedback — red, slightly larger */
    #hud-hitmarker.kill .hm {
      background: #ff3b30;
      box-shadow: 0 0 8px rgba(255,59,48,0.95);
    }
    #hud-hitmarker.kill.show {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1.5);
    }

    /* ---- Hostiles counter (top center) ---------------------------------- */
    #hud-enemies {
      position: absolute;
      top: 18px; left: 50%;
      transform: translateX(-50%);
      font-size: 13px;
      letter-spacing: 3px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 6px 16px;
      background: linear-gradient(180deg, rgba(10,16,8,0.55), rgba(10,16,8,0.25));
      border: 1px solid rgba(208,216,224,0.25);
      border-radius: 2px;
      color: var(--accent);
    }
    #hud-enemies .num {
      font-size: 15px;
      margin-left: 6px;
      color: #fff;
    }

    /* ---- Kill feed (top right) ------------------------------------------ */
    #hud-killfeed {
      position: absolute;
      top: 16px; right: 18px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 5px;
      max-width: 320px;
    }
    .kf-line {
      font-size: 13px;
      letter-spacing: 1px;
      padding: 4px 10px 4px 12px;
      background: rgba(14,18,14,0.22);
      border-left: 3px solid #b3331e;
      color: #d6dde4;
      opacity: 0;
      transform: translateX(12px);
      animation: kf-in 220ms ease-out forwards;
    }
    @keyframes kf-in { to { opacity: 1; transform: translateX(0); } }
    .kf-line.out { animation: kf-out 600ms ease-in forwards; }
    @keyframes kf-out { to { opacity: 0; transform: translateX(12px); } }

    /* ---- Health (bottom left) ------------------------------------------- */
    #hud-health {
      position: absolute;
      left: 26px; bottom: 26px;
      width: 180px;
    }
    .hp-label {
      font-size: 11px;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: #6b7480;
      margin-bottom: 5px;
    }
    .hp-row { display: flex; align-items: baseline; gap: 8px; }
    .hp-value {
      font-size: 30px;
      font-weight: 700;
      color: #fff;
      line-height: 1;
    }
    .hp-max { font-size: 13px; color: #7c8794; }
    #hud-hp-bar {
      margin-top: 7px;
      position: relative;
      height: 5px;
      width: 100%;
      background: rgba(0,0,0,0.6);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 1px;
      overflow: hidden;
    }
    #hud-hp-fill {
      position: absolute;
      inset: 0 auto 0 0;
      width: 100%;
      height: 100%;
      background: repeating-linear-gradient(90deg, rgba(0,0,0,0.35) 0, rgba(0,0,0,0.35) 1px, transparent 1px, transparent 9px),
                  linear-gradient(90deg, #ff3b30 0%, #ffb000 100%);
      transition: width 280ms cubic-bezier(.2,.8,.2,1), background 280ms linear, box-shadow 280ms linear;
      box-shadow: none;
    }

    /* ---- Ammo (bottom right) -------------------------------------------- */
    #hud-ammo {
      position: absolute;
      right: 26px; bottom: 26px;
      text-align: right;
      display: flex;
      align-items: baseline;
      gap: 6px;
      justify-content: flex-end;
    }
    #hud-ammo-cur {
      font-size: 46px;
      font-weight: 700;
      line-height: 0.9;
      color: #f0e8d0;
      text-shadow: 0 0 4px rgba(208,216,224,0.18), 0 1px 3px rgba(0,0,0,0.85);
    }
    #hud-ammo-res {
      font-size: 16px;
      color: #8a93a0;
    }
    #hud-ammo-res::before { content: "/ "; }
    .ammo-label {
      position: absolute;
      right: 0; bottom: -16px;
      font-size: 10px;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: #6b7480;
    }

    /* ---- Reloading indicator (P2#18) ------------------------------------ */
    #hud-reloading {
      position: absolute;
      left: 50%;
      bottom: 92px;
      transform: translateX(-50%);
      display: none;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 5px;
      text-transform: uppercase;
      color: #ffb000;
      text-shadow: 0 0 12px rgba(255,176,0,0.6), 0 1px 3px rgba(0,0,0,0.85);
      padding: 6px 20px;
      border: 1px solid rgba(255,176,0,0.5);
      border-radius: 2px;
      background: rgba(10,16,8,0.4);
      animation: reload-pulse 700ms ease-in-out infinite;
    }
    #hud-reloading.show { display: block; }
    @keyframes reload-pulse { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }

    /* ---- Damage flash (clean red edge vignette) ------------------------- */
    #hud-damage {
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: 0;
      /* transparent center -> red only at the edges, so gameplay stays visible */
      background: radial-gradient(ellipse at center,
        rgba(255,0,0,0) 40%,
        rgba(255,0,0,0.10) 68%,
        rgba(255,8,8,0.45) 100%);
      transition: opacity 110ms ease-out;
    }
    #hud-damage.show { opacity: 1; }

    /* ---- Round 8: persistent low-health vignette (pulses under 35% HP) -- */
    #hud-lowhp {
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: 0;
      background: radial-gradient(ellipse at center,
        rgba(120,0,0,0) 45%,
        rgba(150,0,0,0.10) 78%,
        rgba(170,0,0,0.42) 100%);
      transition: opacity 400ms ease;
    }
    #hud-root.lowhp #hud-lowhp {
      opacity: 1;
      animation: lowhp-pulse 1.1s ease-in-out infinite;
    }
    @keyframes lowhp-pulse { 0%,100% { opacity: 0.55; } 50% { opacity: 0.95; } }

    /* ---- Round 8: death-cam red wash (ramped 0->1 during the death seq) - */
    #hud-death {
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: 0;
      /* heavier, darker red than the hit flash, so dying reads as a distinct beat */
      background:
        radial-gradient(ellipse at center, rgba(90,0,0,0) 28%, rgba(140,0,0,0.40) 72%, rgba(190,0,0,0.80) 100%),
        linear-gradient(rgba(60,0,0,0.12), rgba(60,0,0,0.12));
    }

    /* ---- Big centered message ------------------------------------------- */
    #hud-message {
      position: absolute;
      inset: 0;
      z-index: 9500;
      display: none;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      text-align: center;
      background: radial-gradient(ellipse at center, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.55) 100%);
      pointer-events: none;
    }
    #hud-message.show { display: flex; animation: msg-in 400ms ease-out; }
    @keyframes msg-in { from { opacity: 0; transform: scale(1.04); } to { opacity: 1; transform: scale(1); } }
    #hud-message .msg-text {
      white-space: pre-line;
      font-size: 64px;
      font-weight: 800;
      letter-spacing: 4px;
      text-transform: uppercase;
      line-height: 1.05;
      color: #fff;
      text-shadow: 0 0 24px rgba(0,0,0,0.9), 0 2px 8px rgba(0,0,0,0.8);
    }
    #hud-message.danger .msg-text { color: #ff3b30; text-shadow: 0 0 30px rgba(255,59,48,0.6), 0 0 14px rgba(0,0,0,0.9); }
    #hud-message.victory .msg-text { color: var(--accent); text-shadow: 0 0 30px rgba(208,216,224,0.25), 0 0 14px rgba(0,0,0,0.9); }
  `;
  document.head.appendChild(style);

  // ---- Build DOM ----------------------------------------------------------
  root.innerHTML = `
    <div id="hud-damage"></div>
    <div id="hud-lowhp"></div>
    <div id="hud-death"></div>

    <div id="hud-crosshair">
      <span class="ch-tick h top"></span>
      <span class="ch-tick h bottom"></span>
      <span class="ch-tick v left"></span>
      <span class="ch-tick v right"></span>
    </div>
    <div id="hud-hitmarker">
      <span class="hm tr"></span>
      <span class="hm tl"></span>
      <span class="hm br"></span>
      <span class="hm bl"></span>
    </div>

    <div id="hud-minimap-wrap">
      <canvas id="hud-minimap" width="168" height="168"></canvas>
      <div id="hud-minimap-label"><span class="dot"></span>TACTICAL</div>
    </div>

    <div id="hud-enemies">HOSTILES:<span class="num">0</span></div>
    <div id="hud-killfeed"></div>

    <div id="hud-health">
      <div class="hp-label">Armor</div>
      <div class="hp-row">
        <span class="hp-value hud-monofont">100</span>
        <span class="hp-max hud-monofont">/ 100</span>
      </div>
      <div id="hud-hp-bar"><div id="hud-hp-fill"></div></div>
    </div>

    <div id="hud-ammo">
      <span id="hud-ammo-cur" class="hud-monofont">0</span>
      <span id="hud-ammo-res" class="hud-monofont">0</span>
      <span class="ammo-label">Ammunition</span>
    </div>

      <div id="hud-message"><div class="msg-text"></div></div>

    <div id="hud-reloading">RELOADING</div>
  `;
  document.body.appendChild(root);

  // ---- Cache element refs -------------------------------------------------
  const el = {
    enemies: root.querySelector('#hud-enemies .num'),
    killfeed: root.querySelector('#hud-killfeed'),
    hpValue: root.querySelector('.hp-value'),
    hpMax: root.querySelector('.hp-max'),
    hpFill: root.querySelector('#hud-hp-fill'),
    ammoCur: root.querySelector('#hud-ammo-cur'),
    ammoRes: root.querySelector('#hud-ammo-res'),
    hitmarker: root.querySelector('#hud-hitmarker'),
    damage: root.querySelector('#hud-damage'),
    lowhp: root.querySelector('#hud-lowhp'),
    death: root.querySelector('#hud-death'),
    message: root.querySelector('#hud-message'),
    messageText: root.querySelector('#hud-message .msg-text'),
    reloading: root.querySelector('#hud-reloading'),
    minimap: root.querySelector('#hud-minimap'),
  };

  // ---- Helpers ------------------------------------------------------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Interpolate hex colors (returns "rgb(...)")
  function lerpColor(a, b, t) {
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return `rgb(${r},${g},${bl})`;
  }
  const COLOR_GOOD = [232, 240, 224];   // #e8f0e0 (pale neutral)
  const COLOR_MID = [255, 176, 0];    // #ffb000
  const COLOR_LOW = [255, 59, 48];    // #ff3b30

  function healthColor(ratio) {
    // ratio 1 -> good, 0.5 -> mid, 0 -> low
    if (ratio > 0.5) return lerpColor(COLOR_MID, COLOR_GOOD, (ratio - 0.5) / 0.5);
    return lerpColor(COLOR_LOW, COLOR_MID, clamp(ratio, 0, 0.5) / 0.5);
  }

  // P1#18: white 60% default; only a subtle red glow + #ff3b30 when health < 35%
  const HP_LOW_THRESHOLD = 0.35;

  // ---- Round 4: Minimap drawing (procedural canvas, ~14 fps) ---------------
  const mm = el.minimap;
  const mmCtx = mm.getContext('2d');
  const MM_W = mm.width;       // 168
  const MM_H = mm.height;      // 168
  const MM_R = MM_W / 2;       // 84 (radius)
  // map a small world region (m) into the minimap radius. Buildings within ~80m matter;
  // enemies can be detected out to 40m. We size so the radius covers ~70m of world.
  const MM_WORLD_RADIUS = 70;
  let mmSweep = 0;             // rotating sweep angle (radians)
  let mmLast = performance.now();

  function drawMinimap() {
    const snap = window.__game && window.__game.getMinimapSnapshot
      ? window.__game.getMinimapSnapshot()
      : null;
    const ctx = mmCtx;
    ctx.clearRect(0, 0, MM_W, MM_H);

    // circular clip so nothing draws outside the radar disc
    ctx.save();
    ctx.beginPath();
    ctx.arc(MM_R, MM_R, MM_R - 1, 0, Math.PI * 2);
    ctx.clip();

    // soft inner vignette (subtle, doesn't obscure)
    const vg = ctx.createRadialGradient(MM_R, MM_R, MM_R * 0.2, MM_R, MM_R, MM_R);
    vg.addColorStop(0, 'rgba(20,30,38,0.0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, MM_W, MM_H);

    if (!snap) {
      ctx.restore();
      return;
    }

    const px = MM_W / MM_WORLD_RADIUS; // pixels per world meter at full radius
    const yaw = snap.playerYaw || 0;

    // rotate the world so the player always points up
    ctx.save();
    ctx.translate(MM_R, MM_R);
    ctx.rotate(-yaw);

    // buildings (gray rotated rects)
    ctx.fillStyle = 'rgba(170,178,184,0.55)';
    ctx.strokeStyle = 'rgba(220,228,234,0.7)';
    ctx.lineWidth = 1;
    for (const b of snap.buildings || []) {
      ctx.save();
      ctx.translate(b.x * px, b.z * px);
      ctx.rotate(b.rot || 0);
      ctx.fillRect(-b.w * px * 0.5, -b.d * px * 0.5, b.w * px, b.d * px);
      ctx.strokeRect(-b.w * px * 0.5, -b.d * px * 0.5, b.w * px, b.d * px);
      ctx.restore();
    }

    // perimeter walls as faint outer ring
    if (snap.bounds) {
      const bx = snap.bounds.maxX;
      ctx.strokeStyle = 'rgba(208,216,224,0.4)';
      ctx.lineWidth = 2;
      ctx.strokeRect(-bx * px, -bx * px, bx * 2 * px, bx * 2 * px);
    }

    // enemies (red dots, pulse with the sweep). Round 12: bumped to 4.5px +
    // brighter ring so they're actually readable on a 168px disc — the 3.2px
    // dots from earlier rounds disappeared under the radial vignette.
    const sweep = mmSweep;
    for (const e of snap.enemies || []) {
      // distance from player
      const dx = e.x - snap.playerX;
      const dz = e.z - snap.playerZ;
      const d = Math.hypot(dx, dz);
      if (d > MM_WORLD_RADIUS) continue;
      const ex = dz * px;
      const ey = -dx * px;
      const ang = Math.atan2(ey, ex);
      let age = (sweep - ang + Math.PI * 2) % (Math.PI * 2);
      const intensity = Math.max(0.55, 1 - age / (Math.PI * 0.5));
      // solid fill (always bright) + glow ring
      ctx.fillStyle = `rgba(255,90,70,${intensity.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(ex, ey, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,120,100,${(intensity * 0.6).toFixed(2)})`;
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.arc(ex, ey, 8, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore(); // un-rotate

    // range rings (drawn AFTER rotation so they stay fixed visually) — actually
    // we draw them in the rotated frame so they rotate with the player (correct feel).
    ctx.save();
    ctx.translate(MM_R, MM_R);
    ctx.rotate(-yaw);
    ctx.strokeStyle = 'rgba(208,216,224,0.18)';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1.0].forEach((f) => {
      ctx.beginPath();
      ctx.arc(0, 0, MM_R * f, 0, Math.PI * 2);
      ctx.stroke();
    });
    // crosshair ticks (N/E/S/W) on the outer ring
    ctx.strokeStyle = 'rgba(208,216,224,0.45)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (MM_R - 6), Math.sin(a) * (MM_R - 6));
      ctx.lineTo(Math.cos(a) * MM_R, Math.sin(a) * MM_R);
      ctx.stroke();
    }
    ctx.restore();

    // sweep line (rotates with player) — drawn over everything
    ctx.save();
    ctx.translate(MM_R, MM_R);
    ctx.rotate(-yaw + mmSweep);
    const sg = ctx.createLinearGradient(-MM_R, 0, MM_R, 0);
    sg.addColorStop(0, 'rgba(120,255,160,0.0)');
    sg.addColorStop(0.85, 'rgba(120,255,160,0.18)');
    sg.addColorStop(1, 'rgba(120,255,160,0.55)');
    ctx.strokeStyle = sg;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(MM_R - 1, 0);
    ctx.stroke();
    ctx.restore();

    // player arrow (always points up, fixed orientation in screen space)
    ctx.save();
    ctx.translate(MM_R, MM_R);
    ctx.fillStyle = '#cfd6dc';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(0, 2);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.restore(); // un-clip
  }

  function tickMinimap(now) {
    const dt = (now - mmLast) / 1000;
    mmLast = now;
    // sweep does ~1 full revolution every 2.5s
    mmSweep = (mmSweep + dt * (Math.PI * 2 / 2.5)) % (Math.PI * 2);
    drawMinimap();
  }

  // requestAnimationFrame for the minimap; runs always (cheap). Skips when hidden
  // (tab inactive) so the sweep can resume cleanly on focus.
  let mmRunning = true;
  function mmLoop(now) {
    if (!mmRunning) return;
    tickMinimap(now);
    requestAnimationFrame(mmLoop);
  }
  requestAnimationFrame(mmLoop);

  // ---- Public API ---------------------------------------------------------
  let hitTimer = null;
  let dmgTimer = null;

  return {
    setHealth(hp, max) {
      const m = max > 0 ? max : 1;
      const ratio = clamp(hp / m, 0, 1);
      const shown = Math.max(0, Math.round(hp));
      el.hpValue.textContent = shown;
      el.hpMax.textContent = `/ ${Math.round(m)}`;
      el.hpFill.style.width = (ratio * 100).toFixed(1) + '%';
      // Round 8: pulse the screen red once HP drops into the danger band.
      root.classList.toggle('lowhp', ratio < HP_LOW_THRESHOLD && hp > 0);
      if (ratio < HP_LOW_THRESHOLD) {
        el.hpFill.style.background = 'repeating-linear-gradient(90deg, rgba(0,0,0,0.35) 0, rgba(0,0,0,0.35) 1px, transparent 1px, transparent 9px), linear-gradient(90deg, #ff3b30, #ff6a2a)';
        el.hpFill.style.boxShadow = '0 0 6px rgba(255,59,48,0.6)';
      } else {
        el.hpFill.style.background = 'repeating-linear-gradient(90deg, rgba(0,0,0,0.35) 0, rgba(0,0,0,0.35) 1px, transparent 1px, transparent 9px), linear-gradient(90deg, #ff3b30 0%, #ffb000 100%)';
        el.hpFill.style.boxShadow = 'none';
      }
    },

    setAmmo(cur, reserve) {
      el.ammoCur.textContent = cur;
      el.ammoRes.textContent = reserve;
    },

    setEnemies(n) {
      el.enemies.textContent = n;
    },

    // P2#18: toggle the RELOADING indicator (defaults hidden, toggles cleanly)
    setReloading(on) {
      el.reloading.classList.toggle('show', !!on);
    },

    // P2#19: normal hit = white X flash; kill = red, larger/longer flash
    hitMarker(kill = false) {
      el.hitmarker.classList.toggle('kill', !!kill);
      el.hitmarker.classList.add('show');
      if (hitTimer) clearTimeout(hitTimer);
      hitTimer = setTimeout(() => el.hitmarker.classList.remove('show'), kill ? 240 : 150);
    },

    // Round 8: optional intensity (0..1) so a heavy hit can flash harder.
    damageFlash(intensity = 1) {
      el.damage.classList.add('show');
      if (intensity !== 1) el.damage.style.opacity = String(Math.max(0.2, Math.min(1, intensity)));
      if (dmgTimer) clearTimeout(dmgTimer);
      dmgTimer = setTimeout(() => {
        el.damage.classList.remove('show');
        el.damage.style.opacity = '';
      }, 150);
    },

    // Round 8: ramp the death-cam red wash (prog 0..1). Set directly each frame
    // so it tracks the slow-mo sequence; no CSS transition (would lag the ramp).
    rampDeath(prog) {
      el.death.style.opacity = (Math.max(0, Math.min(1, prog)) * 0.92).toFixed(3);
    },
    clearDeath() {
      el.death.style.opacity = '0';
    },

    killFeed(text) {
      const line = document.createElement('div');
      line.className = 'kf-line';
      line.textContent = text;
      el.killfeed.appendChild(line);
      // fade out then remove after ~3.5s
      setTimeout(() => {
        line.classList.add('out');
        setTimeout(() => line.remove(), 650);
      }, 3500);
    },

    showMessage(text) {
      const lower = String(text).toLowerCase();
      el.message.classList.remove('danger', 'victory');
      if (lower.includes('die') || lower.includes('dead')) el.message.classList.add('danger');
      else if (lower.includes('victor') || lower.includes('win')) el.message.classList.add('victory');
      el.messageText.textContent = text;
      el.message.classList.add('show');
    },
  };
}
