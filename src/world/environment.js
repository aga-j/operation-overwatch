import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Deterministic PRNG so the arena is laid out identically every load.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0x5eed1234);

// ---------------------------------------------------------------------------
// Shared material factory — military palette, varied roughness/metalness.
// ---------------------------------------------------------------------------
const PALETTE = {
  grey: 0x6b6f73,
  olive: 0x4f5238,
  rust: 0x7a4a32,
  sand: 0xb9a06b,
  rubber: 0x1c1c1f,
  concrete: 0x8a857c,
  metal: 0x70757a,
  // P1#11 — expanded palette (~12 colors total)
  oil: 0x1a1a18, // oil / dark
  paint: 0xc8c4b8, // faded white paint
  terracotta: 0xa06540, // terracotta
  moss: 0x3a4a28, // mossy edge
  earthen: 0x4a3d28, // dark earth
  midgrey: 0x8a8a82, // mid grey
};

function mat(color, roughness = 0.9, metalness = 0.05) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

// ---------------------------------------------------------------------------
// Shared base materials (P2#21). Instead of cloning a jittered material per
// prop instance, we keep a small pool of base materials with `vertexColors`
// enabled and apply per-instance color variation through a geometry color
// attribute. Far cheaper (fewer programs/draw-state changes, esp. software GL).
// ---------------------------------------------------------------------------
function sharedMat(color, roughness, metalness) {
  const m = mat(color, roughness, metalness);
  m.vertexColors = true;
  return m;
}

// ENV2-1 (P0): mil-sim dusty NEUTRAL palette. Desaturated to kill the toy
// rainbow, but VALUE variation is preserved so props still read as distinct.
// Per-instance ROUGHNESS jitter is achieved via a small POOL of shared
// materials (colour-variant x roughness-variant) — keeps material sharing
// while varying roughness per instance (no per-prop material clones).
const NEUTRAL = {
  d1: 0x3e3f3a, // near-black olive-grey
  d2: 0x4a4f42, // dark moss-grey
  m1: 0x595548, // mid warm grey
  m2: 0x5c564d, // mid stone
  l1: 0x6b6558, // light dusty grey
  sandbag: 0x7d7562, // desaturated dusty tan (was saturated 0xb9a06b)
};

// Build a bounded pool of shared, vertexColors-enabled mats: each neutral
// colour gets a few roughness variants so the per-instance pick yields
// roughness jitter while the total material count stays low (SwiftShader-safe).
function neutralPool(colors, rLow, rHigh, steps) {
  const out = [];
  for (const c of colors) {
    for (let i = 0; i < steps; i++) {
      const r = steps === 1 ? rLow : rLow + (rHigh - rLow) * (i / (steps - 1));
      out.push(sharedMat(c, r, 0.05));
    }
  }
  return out;
}

// Crates: dusty neutral greys, roughness 0.7..0.95 across 2 steps.
const CRATE_MATS = neutralPool([NEUTRAL.m2, NEUTRAL.d2, NEUTRAL.m1], 0.7, 0.95, 2);
// Barriers: faded neutral (was high-chroma paint + terracotta), now dusty.
const BARRIER_MATS = neutralPool([NEUTRAL.l1, NEUTRAL.d1, NEUTRAL.m2], 0.85, 0.98, 2);
// Barrels: muted oil / desaturated rust (0x7a4a32 -> 0x6a5b48) / metal.
const BARREL_MATS = [
  sharedMat(NEUTRAL.m1, 0.7, 0.3),
  sharedMat(0x6a5b48, 0.8, 0.3),
  sharedMat(PALETTE.metal, 0.5, 0.6),
];
// Sandbags: single shared base, per-bag vertex tint, desaturated tan.
const SANDBAG_MAT = sharedMat(NEUTRAL.sandbag, 0.95, 0.0);

// ENV2-2 (P1): cheap contact-AO. A dark, thin slab under large props to fake
// grounding. Never casts a shadow (SwiftShader stable).
const CONTACT_MAT = new THREE.MeshStandardMaterial({
  color: 0x2a2419,
  roughness: 1.0,
  metalness: 0.0,
});

// Dark recessed-window material (P0#3) — one shared material.
const WINDOW_MAT = mat(PALETTE.oil, 0.6, 0.0);

// ---------------------------------------------------------------------------
// Per-instance material jitter (P1#29): cloned material with slight hue/value
// variation so repeated props don't read as clones.
// ---------------------------------------------------------------------------
function jitteredMat(color, roughness = 0.9, metalness = 0.05) {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const k = 0.92 + rng() * 0.16; // 0.92 .. 1.08
  m.color.multiplyScalar(k);
  return m;
}

// ---------------------------------------------------------------------------
// Procedural ground textures (P1#6 / P0#5 / P1#10) — canvas-generated, no
// external assets. A fixed seed drives the shared "features" (tire-track
// streaks + low-frequency splotches) so the albedo and the matching normal
// map stay perfectly aligned.
// ---------------------------------------------------------------------------
const GROUND_SIZE = 256;
const GROUND_REPEAT = 7; // GRD-2: 12 -> 7 to reduce visible tiling

function groundFeatureSpec() {
  const r = mulberry32(0x9e3779b9);
  const streaks = [];
  for (let i = 0; i < 3; i++) {
    streaks.push({
      x: r() * GROUND_SIZE,
      y: r() * GROUND_SIZE,
      len: 50 + r() * 110,
      ang: r() * Math.PI,
      w: 2 + r() * 2,
      a: 0.14 + r() * 0.1,
    });
  }
  const splotches = [];
  for (let i = 0; i < 4; i++) {
    splotches.push({
      x: r() * GROUND_SIZE,
      y: r() * GROUND_SIZE,
      r: 40 + r() * 40,
      light: r() > 0.5,
      a: 0.18,
    });
  }
  return { streaks, splotches };
}

function makeGroundTexture(aniso) {
  const size = GROUND_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const { streaks, splotches } = groundFeatureSpec();

  ctx.fillStyle = '#6f6a5e';
  ctx.fillRect(0, 0, size, size);

  // Tire-track streaks BEFORE the fine grain (P0#5) — long, low-alpha dark paths.
  ctx.lineCap = 'round';
  for (const s of streaks) {
    ctx.strokeStyle = `rgba(24,22,18,${s.a})`;
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + Math.cos(s.ang) * s.len, s.y + Math.sin(s.ang) * s.len);
    ctx.stroke();
  }

  // fine grain noise
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 38;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);

  // scuff / scratch lines
  for (let s = 0; s < 48; s++) {
    ctx.strokeStyle = `rgba(38,36,30,${0.08 + Math.random() * 0.22})`;
    ctx.lineWidth = 1 + Math.random() * 3;
    ctx.beginPath();
    const x = Math.random() * size,
      y = Math.random() * size;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 46, y + (Math.random() - 0.5) * 46);
    ctx.stroke();
  }

  // patchy stains
  for (let p = 0; p < 22; p++) {
    const x = Math.random() * size,
      y = Math.random() * size,
      r = 8 + Math.random() * 32;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(28,26,22,0.20)');
    g.addColorStop(1, 'rgba(28,26,22,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Large low-frequency splotches drawn OVER the whole thing (P0#5) — wet/wear
  // (darker) and dust (lighter) zones that break the tiled noise look.
  for (const p of splotches) {
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
    if (p.light) {
      g.addColorStop(0, `rgba(190,182,160,${p.a})`);
      g.addColorStop(1, 'rgba(190,182,160,0)');
    } else {
      g.addColorStop(0, `rgba(40,36,28,${p.a})`);
      g.addColorStop(1, 'rgba(40,36,28,0)');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // GRD-2: SECOND, larger-detail decal layer spanning the whole canvas so the
  // tiled repeat no longer reads as an obvious grid. A few very large, soft
  // macro-blots at a different scale + a gentle corner vignette give each tile
  // a unique look under the 7x repeat.
  const macroR = mulberry32(0x1234abcd);
  for (let i = 0; i < 8; i++) {
    const x = macroR() * size,
      y = macroR() * size,
      r = size * (0.25 + macroR() * 0.3);
    const light = macroR() > 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    if (light) {
      g.addColorStop(0, 'rgba(205,197,176,0.16)');
      g.addColorStop(1, 'rgba(205,197,176,0)');
    } else {
      g.addColorStop(0, 'rgba(30,27,21,0.18)');
      g.addColorStop(1, 'rgba(30,27,21,0)');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // macro speckle clusters (detail decal) to further break the grid
  for (let i = 0; i < 180; i++) {
    const x = macroR() * size,
      y = macroR() * size;
    ctx.fillStyle = `rgba(${macroR() > 0.5 ? '20,18,14' : '198,190,168'},${0.05 + macroR() * 0.12})`;
    ctx.beginPath();
    ctx.arc(x, y, 1 + macroR() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(GROUND_REPEAT, GROUND_REPEAT);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  return tex;
}

// GRD-1: REAL normal map. Build a height field from the same tire-track
// streaks (grooves) + splotches (bumps) used by the albedo, then derive a
// tangent-space normal map via a Sobel operator. No more fake RGB lighten.
function makeGroundNormalTexture(aniso) {
  const size = GROUND_SIZE;
  const { streaks, splotches } = groundFeatureSpec();

  // --- 1. Height field ----------------------------------------------------
  const H = new Float32Array(size * size).fill(0.5);
  function depositLine(x0, y0, x1, y1, w, delta) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    const inv2s2 = 1 / (2 * (w * 0.5) * (w * 0.5));
    const r = Math.ceil(w);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = x0 + (x1 - x0) * t;
      const py = y0 + (y1 - y0) * t;
      const ix = Math.round(px),
        iy = Math.round(py);
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          const xx = ix + ox,
            yy = iy + oy;
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
          const d2 = ox * ox + oy * oy;
          H[yy * size + xx] += delta * Math.exp(-d2 * inv2s2);
        }
      }
    }
  }
  // tire-track grooves: depress height along the streak and raise a thin lip
  for (const s of streaks) {
    depositLine(s.x, s.y, s.x + Math.cos(s.ang) * s.len, s.y + Math.sin(s.ang) * s.len, s.w, -0.4);
  }
  // splotch bumps (light = raised dust, dark = worn hollow)
  for (const p of splotches) {
    const inv2r2 = 1 / (2 * (p.r * 0.5) * (p.r * 0.5));
    for (let yy = 0; yy < size; yy++) {
      for (let xx = 0; xx < size; xx++) {
        const d2 = (xx - p.x) * (xx - p.x) + (yy - p.y) * (yy - p.y);
        if (d2 > p.r * p.r) continue;
        H[yy * size + xx] += (p.light ? 0.22 : -0.22) * Math.exp(-d2 * inv2r2);
      }
    }
  }
  // fine grain
  for (let i = 0; i < H.length; i++) H[i] += (Math.random() - 0.5) * 0.05;
  // clamp
  for (let i = 0; i < H.length; i++) H[i] = Math.max(0, Math.min(1, H[i]));

  // --- 2. Sobel -> normal ------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const strength = 2.2; // higher = stronger relief
  const at = (x, y) => {
    x = x < 0 ? 0 : x >= size ? size - 1 : x;
    y = y < 0 ? 0 : y >= size ? size - 1 : y;
    return H[y * size + x];
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = tr + 2 * r + br - (tl + 2 * l + bl);
      const dy = bl + 2 * b + br - (tl + 2 * t + tr);
      let nx = -dx,
        ny = -dy,
        nz = 1.0 / strength;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const idx = (y * size + x) * 4;
      img.data[idx] = (nx * 0.5 + 0.5) * 255;
      img.data[idx + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[idx + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(GROUND_REPEAT, GROUND_REPEAT);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = aniso;
  return tex;
}

// GRD2-2: roughness now CORRELATES with the ground features (not independent
// noise). Tire-track streaks = packed/polished sand -> LOWER roughness (darker
// in the map). Dusty (light) splotches = HIGHER roughness; dark (packed)
// splotches = LOWER roughness. So the sand reads as varied matte/polished.
function makeRoughnessTexture(aniso) {
  const size = GROUND_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const { streaks, splotches } = groundFeatureSpec();

  // base: mid roughness
  ctx.fillStyle = 'rgb(185,185,185)';
  ctx.fillRect(0, 0, size, size);

  // tire-track streaks = packed/polished -> lower roughness (darker)
  ctx.lineCap = 'round';
  for (const s of streaks) {
    ctx.strokeStyle = `rgba(120,120,120,${Math.min(0.85, s.a + 0.15)})`;
    ctx.lineWidth = s.w * 1.4;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + Math.cos(s.ang) * s.len, s.y + Math.sin(s.ang) * s.len);
    ctx.stroke();
  }

  // splotches: dusty(light) = rougher, packed(dark) = smoother
  for (const p of splotches) {
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
    if (p.light) {
      g.addColorStop(0, 'rgba(228,228,228,0.5)'); // higher roughness
      g.addColorStop(1, 'rgba(228,228,228,0)');
    } else {
      g.addColorStop(0, 'rgba(110,110,110,0.55)'); // lower roughness
      g.addColorStop(1, 'rgba(110,110,110,0)');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // fine noise so it doesn't band
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 30;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, img.data[i] + n));
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(GROUND_REPEAT, GROUND_REPEAT);
  tex.anisotropy = aniso;
  return tex;
}

// ---------------------------------------------------------------------------
// Local registration buckets (filled once during buildArena).
// ---------------------------------------------------------------------------
let colliders = [];
let solids = [];

// Round 5: dynamic-props bookkeeping (animated each frame by env.update()).
let _flagGeo = null;     // waved flag plane geometry
let _flagBase = null;    // Float32Array of rest vertex positions
let _beaconLight = null; // pulsing rooftop beacon PointLight
let _beaconMat = null;   // beacon emissive material (sync with light)
let _beaconShaft = null; // Round 7: additive volumetric light shaft
let _beaconShaftMat = null;
let _dynTime = 0;

function register(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  colliders.push(new THREE.Box3().setFromObject(mesh));
  solids.push(mesh);
  return mesh;
}

// Solid-only registration (P0#3): cosmetic meshes bullets can hit but that do
// NOT block movement (e.g. recessed windows, painted streaks).
function registerSolid(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  solids.push(mesh);
  return mesh;
}

// ENV2-2 (P1): cosmetic registration WITHOUT castShadow. Used for contact-AO
// wedges / dirt planes so we never balloon the shadow-caster count under
// SwiftShader. Bullet target only; never a movement collider.
function registerCosmetic(mesh) {
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  solids.push(mesh);
  return mesh;
}

// ENV2-2: thin dark contact wedge under a prop footprint to fake grounding
// (ambient-occlusion darkening). Cosmetic only — does not cast a shadow.
function addContactShadow(scene, x, z, ry, hx, hz) {
  const geo = new THREE.BoxGeometry(hx * 2 + 0.3, 0.06, hz * 2 + 0.3);
  const m = new THREE.Mesh(geo, CONTACT_MAT);
  m.position.set(x, 0.03, z);
  m.rotation.y = ry;
  m.renderOrder = 1;
  scene.add(m);
  registerCosmetic(m);
}

// Per-instance color variation via a vertex color attribute (P2#21). Paints a
// single near-white jitter factor across all vertices so the shared base
// material reads slightly differently per instance.
function tintGeometry(geo, jmin = 0.85, jmax = 1.12) {
  const j = jmin + Math.random() * (jmax - jmin);
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = j;
    colors[i * 3 + 1] = j;
    colors[i * 3 + 2] = j;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

// Small jitter helper.
function jitter(range) {
  return (rng() - 0.5) * 2 * range;
}

// ---------------------------------------------------------------------------
// Sky — large inverted sphere with a vertical gradient shader.
// ---------------------------------------------------------------------------
function buildSky(scene) {
  const uniforms = {
    topColor: { value: new THREE.Color(0x5b7099) }, // zenith (deeper blue)
    bottomColor: { value: new THREE.Color(0xcdb892) }, // horizon — warm dust haze, matches Round 6 fog
    offset: { value: 12.0 },
    exponent: { value: 0.85 },
  };

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPos;
      void main() {
        float h = normalize(vWorldPos + vec3(0.0, offset, 0.0)).y;
        float t = pow(clamp(h * 0.5 + 0.5, 0.0, 1.0), exponent);
        vec3 col = mix(bottomColor, topColor, t);
        // SKY2-1: darken the bottom band so the ground/sky transition feels
        // atmospheric (less contrast near the horizon line).
        col *= mix(0.78, 1.0, smoothstep(0.0, 0.22, t));
        // SKY2-1: subtle warm horizon-glow band just above the horizon.
        float glow = exp(-pow((t - 0.10) / 0.13, 2.0));
        col += vec3(0.13, 0.12, 0.10) * glow * (1.0 - t * 0.4);
        // desaturate toward the horizon to sell atmospheric haze
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float desat = 1.0 - clamp((1.0 - t) * 0.6, 0.0, 0.6);
        col = mix(vec3(lum), col, desat);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), skyMat);
  sky.receiveShadow = false;
  sky.castShadow = false;
  scene.add(sky);

  // SKY-2: cheap atmospheric depth — a second, slightly smaller dome carrying a
  // soft cloud-noise gradient (transparent, no depth write) + a horizon
  // desaturation via darker band near the horizon. Kept shader-light.
  function makeCloudTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const cx = c.getContext('2d');
    // vertical alpha gradient: transparent at horizon, faint at top
    const g = cx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.0, 'rgba(255,255,255,0.0)'); // top
    g.addColorStop(0.55, 'rgba(255,255,255,0.0)');
    g.addColorStop(0.78, 'rgba(236,238,242,0.10)'); // cloud band near horizon
    g.addColorStop(1.0, 'rgba(220,222,228,0.0)');
    cx.fillStyle = g;
    cx.fillRect(0, 0, 256, 256);
    // soft noise blobs (clouds)
    const cr = mulberry32(0xbeefc10d);
    for (let i = 0; i < 26; i++) {
      const x = cr() * 256,
        y = 150 + cr() * 90,
        r = 14 + cr() * 46;
      const cg = cx.createRadialGradient(x, y, 0, x, y, r);
      cg.addColorStop(0, `rgba(245,246,250,${0.05 + cr() * 0.10})`);
      cg.addColorStop(1, 'rgba(245,246,250,0)');
      cx.fillStyle = cg;
      cx.beginPath();
      cx.arc(x, y, r, 0, Math.PI * 2);
      cx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const cloudMat = new THREE.MeshBasicMaterial({
    map: makeCloudTexture(),
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });
  const cloudDome = new THREE.Mesh(new THREE.SphereGeometry(590, 32, 16), cloudMat);
  scene.add(cloudDome);

  // Soft sun glow sprite (additive) placed along the sun direction.
  const sunDir = new THREE.Vector3(46, 33, 32).normalize();
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 128;
  const gctx = glowCanvas.getContext('2d');
  const gg = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gg.addColorStop(0, 'rgba(255,247,224,0.9)');
  gg.addColorStop(0.25, 'rgba(255,236,190,0.45)');
  gg.addColorStop(1, 'rgba(255,236,190,0)');
  gctx.fillStyle = gg;
  gctx.fillRect(0, 0, 128, 128);
  const glowTex = new THREE.CanvasTexture(glowCanvas);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      transparent: true,
      fog: false,
    })
  );
  glow.scale.set(160, 160, 1);
  glow.position.copy(sunDir).multiplyScalar(560);
  scene.add(glow);
}

// GRD2-1: large wind-blown ripple/streak decal texture. Streaks are drawn at a
// DIFFERENT angle (~45°) than the ground tire tracks so the big-scale ground
// reads as wind-sculpted, not tire-grid. Transparent with soft alpha.
function makeRippleDecalTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const cx = c.getContext('2d');
  cx.clearRect(0, 0, 256, 256);
  for (let i = 0; i < 16; i++) {
    const x = Math.random() * 256,
      y = Math.random() * 256;
    const len = 40 + Math.random() * 130;
    const wdt = 2 + Math.random() * 4;
    const ang = Math.PI * 0.25 + (Math.random() - 0.5) * 0.25; // ~diagonal
    const g = cx.createLinearGradient(x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.addColorStop(0, 'rgba(40,36,28,0)');
    g.addColorStop(0.5, `rgba(40,36,28,${0.08 + Math.random() * 0.12})`);
    g.addColorStop(1, 'rgba(40,36,28,0)');
    cx.strokeStyle = g;
    cx.lineWidth = wdt;
    cx.lineCap = 'round';
    cx.beginPath();
    cx.moveTo(x, y);
    cx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    cx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Ground — large plane with subtle vertex-color variation.
// ---------------------------------------------------------------------------
function buildGround(scene, half, aniso) {
  const geo = new THREE.PlaneGeometry(half * 2, half * 2, 1, 1);
  geo.rotateX(-Math.PI / 2);

  const groundMat = new THREE.MeshStandardMaterial({
    map: makeGroundTexture(aniso),
    roughnessMap: makeRoughnessTexture(aniso),
    normalMap: makeGroundNormalTexture(aniso),
    normalScale: new THREE.Vector2(0.35, 0.35), // GRD2-1: kill bumpy-plastic look
    roughness: 1.0,
    metalness: 0.0,
  });

  const ground = new THREE.Mesh(geo, groundMat);
  ground.position.y = 0;
  ground.receiveShadow = true;
  ground.castShadow = false;
  scene.add(ground);

  // GRD2-1: 3-4 large wind-blown ripple/streak decals at a DIFFERENT (diagonal)
  // angle than the tire tracks. Cosmetic only (never colliders); may overlap
  // the spawn corridor. Geometry is baked flat, then spun about world-Y.
  const rippleTex = makeRippleDecalTexture();
  const rnd = mulberry32(0xc0ffee);
  for (let i = 0; i < 4; i++) {
    const sz = 36 + rnd() * 30;
    const dg = new THREE.PlaneGeometry(sz, sz);
    dg.rotateX(-Math.PI / 2);
    const plane = new THREE.Mesh(
      dg,
      new THREE.MeshStandardMaterial({
        map: rippleTex,
        transparent: true,
        depthWrite: false,
        roughness: 1.0,
        metalness: 0.0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
    );
    plane.rotation.y = Math.PI * 0.25 + (rnd() - 0.5) * 0.4; // diagonal orientation
    plane.position.set((rnd() - 0.5) * half * 1.6, 0.04, (rnd() - 0.5) * half * 1.6);
    plane.renderOrder = 1;
    scene.add(plane);
  }

  // Bullet target only — NOT a movement collider. Callers push it to
  // `solids` (not `colliders`).
  return ground;
}

// ---------------------------------------------------------------------------
// Lighting.
// ---------------------------------------------------------------------------
function buildLighting(scene) {
  const hemi = new THREE.HemisphereLight(0xbcd0e0, 0x4a4036, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
  // Low, raking sun (~30° elevation) for dramatic shadows.
  sun.position.set(46, 33, 32);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);

  // P0#1 — tighten the shadow frustum to the playable area near the origin so
  // texel density (and therefore shadow crispness) goes way up.
  const cam = sun.shadow.camera;
  cam.left = -50;
  cam.right = 50;
  cam.top = 50;
  cam.bottom = -50;
  cam.near = 1;
  cam.far = 120;
  cam.updateProjectionMatrix();

  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 2; // ENV2-2: crisper building shadows (was 4)
  scene.add(sun);
  scene.add(sun.target);

  // Cool rim/back light to separate silhouettes from the sky (P0#1). Pure
  // accent — never casts shadows.
  const back = new THREE.DirectionalLight(0xaaccff, 0.35);
  back.position.set(-30, 20, -20);
  back.castShadow = false;
  scene.add(back);
}

// ---------------------------------------------------------------------------
// Prop builders. Each returns a Group/Mesh already placed; we register solid
// meshes for collision + bullet impact.
// ---------------------------------------------------------------------------
function place(mesh, x, z, ry = 0) {
  mesh.position.x = x;
  mesh.position.z = z;
  mesh.rotation.y = ry;
  return mesh;
}

function crates(scene, count, bounds, findSpot) {
  const sizes = [0.6, 0.8, 1.0, 1.2, 1.6];
  for (let i = 0; i < count; i++) {
    const s = sizes[(rng() * sizes.length) | 0];
    const h = s * (0.7 + rng() * 0.3);
    const spot = findSpot(s * 0.7);
    if (!spot) continue;
    // P2#21: shared base material + per-instance vertex-color jitter.
    const m = CRATE_MATS[(rng() * CRATE_MATS.length) | 0];
    const geo = tintGeometry(new THREE.BoxGeometry(s, h, s));
    const box = new THREE.Mesh(geo, m);
    place(box, spot.x, spot.z, jitter(0.25));
    box.position.y = h / 2;
    scene.add(box);
    register(box);
    // ENV2-2: contact-AO wedge under the crate footprint.
    addContactShadow(scene, spot.x, spot.z, box.rotation.y, s / 2, s / 2);
  }
}

function barriers(scene, count, bounds, findSpot) {
  for (let i = 0; i < count; i++) {
    const w = 2.2 + rng() * 1.2;
    const h = 1.0 + rng() * 0.2;
    const d = 0.5;
    const spot = findSpot(w * 0.6);
    if (!spot) continue;
    // P1#11 / P2#21: faded paint / terracotta shared materials, vertex tint.
    const m = BARRIER_MATS[(rng() * BARRIER_MATS.length) | 0];
    const geo = tintGeometry(new THREE.BoxGeometry(w, h, d));
    const box = new THREE.Mesh(geo, m);
    place(box, spot.x, spot.z, Math.round(rng() * 3) * (Math.PI / 2) + jitter(0.1));
    box.position.y = h / 2;
    scene.add(box);
    register(box);
    // ENV2-2: contact-AO wedge under the barrier footprint.
    addContactShadow(scene, spot.x, spot.z, box.rotation.y, w / 2, d / 2);
  }
}

function brokenWalls(scene, count, bounds, findSpot) {
  for (let i = 0; i < count; i++) {
    const g = new THREE.Group();
    const w = 3 + rng() * 2;
    const baseH = 2.4 + rng() * 0.8;
    const m = jitteredMat(PALETTE.concrete, 0.95, 0.0);
    const lower = new THREE.Mesh(new THREE.BoxGeometry(w, baseH, 0.4), m);
    lower.position.y = baseH / 2;
    g.add(lower);
    // broken top: a couple of smaller chunks
    const chunks = 2 + ((rng() * 2) | 0);
    for (let c = 0; c < chunks; c++) {
      const cw = 0.4 + rng() * 0.5;
      const ch = 0.5 + rng() * 0.9;
      const chunk = new THREE.Mesh(new THREE.BoxGeometry(cw, ch, 0.4), m);
      chunk.position.set(-w / 2 + cw / 2 + c * (w / chunks), baseH + ch / 2 - rng() * 0.3, 0);
      chunk.rotation.z = jitter(0.12);
      g.add(chunk);
    }
    const spot = findSpot(w * 0.6);
    if (!spot) continue;
    g.position.set(spot.x, 0, spot.z);
    g.rotation.y = Math.round(rng() * 3) * (Math.PI / 2) + jitter(0.15);
    scene.add(g);
    g.traverse((o) => {
      if (o.isMesh) register(o);
    });
  }
}

function sandbags(scene, count, bounds, findSpot) {
  for (let i = 0; i < count; i++) {
    const g = new THREE.Group();
    const rows = 2 + ((rng() * 2) | 0);
    const perRow = 4 + ((rng() * 2) | 0);
    const r = 0.32;
    // P2#21: one shared material for the whole pile, per-bag vertex tint.
    for (let row = 0; row < rows; row++) {
      for (let b = 0; b < perRow; b++) {
        const geo = tintGeometry(new THREE.BoxGeometry(0.6, r * 2, 0.35), 0.8, 1.08);
        const bag = new THREE.Mesh(geo, SANDBAG_MAT);
        bag.position.set(
          (b - perRow / 2) * 0.62 + jitter(0.05),
          r + row * r * 1.7,
          (row % 2) * 0.3
        );
        bag.rotation.z = jitter(0.08);
        g.add(bag);
      }
    }
    const width = perRow * 0.62;
    const spot = findSpot(width * 0.5);
    if (!spot) continue;
    g.position.set(spot.x, 0, spot.z);
    g.rotation.y = jitter(Math.PI);
    scene.add(g);
    g.traverse((o) => {
      if (o.isMesh) register(o);
    });
  }
}

function barrels(scene, count, bounds, findSpot) {
  for (let i = 0; i < count; i++) {
    const radius = 0.32;
    const h = 0.9 + rng() * 0.3;
    const spot = findSpot(0.5);
    if (!spot) continue;
    // P1#11 / P2#21: oil/rust/metal shared materials, per-instance vertex tint.
    const m = BARREL_MATS[(rng() * BARREL_MATS.length) | 0];
    const geo = tintGeometry(new THREE.CylinderGeometry(radius, radius, h, 16));
    const barrel = new THREE.Mesh(geo, m);
    place(barrel, spot.x, spot.z, jitter(0.2));
    barrel.position.y = h / 2;
    scene.add(barrel);
    register(barrel);
  }
}

function tires(scene, count, bounds, findSpot) {
  for (let i = 0; i < count; i++) {
    const r = 0.38;
    const tube = 0.14;
    const spot = findSpot(0.5);
    if (!spot) continue;
    const m = jitteredMat(PALETTE.rubber, 0.9, 0.05);
    const tire = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 10, 18), m);
    tire.rotation.x = Math.PI / 2;
    place(tire, spot.x, spot.z, jitter(0.4));
    tire.position.y = tube;
    scene.add(tire);
    register(tire);
  }
}

// ---------------------------------------------------------------------------
// P0#3 helpers — break the box-shell silhouette: stepped/segmented walls,
// recessed windows, overhanging roofs, and real doorway depth.
// ---------------------------------------------------------------------------
// ENV-4: each window is a framed BOX — outer concrete sill/lintel/jambs, an
// inner dark plane set ~0.15m back (real depth), and occasionally a faint
// emissive "interior light" plane for contrast. Cosmetic only (registerSolid).
function addWindows(wall, axis, thickness, face, rows, cols) {
  const th = 0.06; // thin dark slab
  const ww = 1.0,
    wh = 0.85; // opening size
  const ft = 0.14; // frame thickness (thickened vs old flat slab)
  const longLen =
    axis === 'x' ? wall.geometry.parameters.width : wall.geometry.parameters.depth;
  const h = wall.geometry.parameters.height;
  const sgn = face === '+' ? 1 : -1;
  const frameMat = mat(PALETTE.concrete, 0.92, 0.0);
  const innerMat = new THREE.MeshStandardMaterial({
    color: PALETTE.oil,
    roughness: 0.9,
    metalness: 0.0,
  });
  const frameZ = sgn * (thickness / 2 + ft / 2 - 0.04); // frame sits proud of face
  const innerZ = sgn * (thickness / 2 - 0.15); // recessed 0.15m back
  for (const ry of rows) {
    if (ry > h - 0.7) continue; // keep the window inside the wall
    // ENV2-3: per-floor interior-light decision so some floors read as lit.
    const rowLit = rng() < 0.45;
    for (let c = 0; c < cols; c++) {
      const colPos = -longLen / 2 + (c + 0.5) * (longLen / cols);
      // frame pieces (4) — axis-aware orientation
      if (axis === 'x') {
        addWinPiece(wall, frameMat, ww + 2 * ft, ft, ft, colPos, ry - wh / 2 - ft / 2, frameZ); // sill
        addWinPiece(wall, frameMat, ww + 2 * ft, ft, ft, colPos, ry + wh / 2 + ft / 2, frameZ); // lintel
        addWinPiece(wall, frameMat, ft, wh, ft, colPos - ww / 2 - ft / 2, ry, frameZ); // left jamb
        addWinPiece(wall, frameMat, ft, wh, ft, colPos + ww / 2 + ft / 2, ry, frameZ); // right jamb
        addWinPiece(wall, innerMat, ww, wh, th, colPos, ry, innerZ); // dark interior
      } else {
        addWinPiece(wall, frameMat, ft, ft, ww + 2 * ft, frameZ, ry - wh / 2 - ft / 2, colPos);
        addWinPiece(wall, frameMat, ft, ft, ww + 2 * ft, frameZ, ry + wh / 2 + ft / 2, colPos);
        addWinPiece(wall, frameMat, ft, wh, ft, frameZ, ry, colPos - ww / 2 - ft / 2);
        addWinPiece(wall, frameMat, ft, wh, ft, frameZ, ry, colPos + ww / 2 + ft / 2);
        addWinPiece(wall, innerMat, th, wh, ww, innerZ, ry, colPos);
      }
      // ENV2-3: per-floor / per-window interior light variation.
      if (rowLit || rng() > 0.7) {
        const eMat = new THREE.MeshStandardMaterial({
          color: 0x000000,
          emissive: 0xffd9a0,
          emissiveIntensity: 0.35 + rng() * 0.7,
          roughness: 1.0,
        });
        if (axis === 'x')
          addWinPiece(wall, eMat, ww * 0.8, wh * 0.8, 0.03, colPos, ry, innerZ + sgn * 0.03);
        else addWinPiece(wall, eMat, 0.03, wh * 0.8, ww * 0.8, innerZ, ry, colPos);
      }
    }
  }
}

function addWinPiece(wall, material, w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  wall.add(m);
  registerSolid(m);
}

// One wall that may be split into N stepped segments along its long axis
// (x for front/back walls, z for side walls). Each segment is a collider.
function buildSegmentedWall(group, wallMat, opts) {
  const { axis, length, heights, thickness, cx, cz, face, winRows, winCols, bandMat } = opts;
  const n = heights.length;
  const segLen = length / n;
  const bandH = 1.6; // ENV-3: stained lower band height
  for (let i = 0; i < n; i++) {
    const h = heights[i];
    const segOffset = -length / 2 + segLen * (i + 0.5);
    let w, d, x, z;
    if (axis === 'x') {
      w = segLen;
      d = thickness;
      x = cx + segOffset;
      z = cz;
    } else {
      w = thickness;
      d = segLen;
      x = cx;
      z = cz + segOffset;
    }
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    wall.position.set(x, h / 2, z);
    group.add(wall);
    register(wall);
    // ENV-3: stained lower concrete band — a second material break at the base
    if (bandMat) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(w, bandH, d + 0.08), bandMat);
      band.position.set(x, bandH / 2, z);
      group.add(band);
      registerSolid(band); // cosmetic lip, does not block movement
    }
    if (winRows && winCols) addWindows(wall, axis, thickness, face, winRows, winCols);
  }
}

function buildRoof(group, metalMat, w, d, h) {
  const t = 0.25; // thin slab
  const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.8, t, d + 0.8), metalMat); // 0.4 overhang each side
  roof.position.set(0, h, 0);
  group.add(roof);
  register(roof);
  buildRoofClutter(group, w, d, h);
}

// ENV-3: roof clutter — AC units, vent pipes, antenna masts, broken parapets.
// All cosmetic (registerSolid) since they sit on the roof and never block
// ground movement.
function buildRoofClutter(group, w, d, h) {
  const t = 0.25;
  const roofTop = h + t / 2;
  const cmA = mat(PALETTE.metal, 0.6, 0.5);
  const cmB = mat(PALETTE.rust, 0.8, 0.3);
  const cmC = mat(PALETTE.concrete, 0.9, 0.0);

  const acN = 1 + ((rng() * 2) | 0);
  for (let i = 0; i < acN; i++) {
    // ENV2-3: ~1.5x AC units
    const aw = 1.2 + rng() * 0.9,
      ad = 0.9 + rng() * 0.75,
      ah = 0.75 + rng() * 0.6;
    const ac = new THREE.Mesh(new THREE.BoxGeometry(aw, ah, ad), rng() > 0.5 ? cmA : cmB);
    ac.position.set((rng() - 0.5) * (w - 2), roofTop + ah / 2, (rng() - 0.5) * (d - 2));
    group.add(ac);
    registerSolid(ac);
    const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.12, 12), cmC);
    fan.position.set(ac.position.x, roofTop + ah + 0.06, ac.position.z);
    group.add(fan);
    registerSolid(fan);
  }
  const ventN = 1 + ((rng() * 2) | 0);
  for (let i = 0; i < ventN; i++) {
    // ENV2-3: ~1.5x vents
    const vr = 0.12 + rng() * 0.09,
      vh = 0.9 + rng() * 1.2;
    const v = new THREE.Mesh(new THREE.CylinderGeometry(vr, vr, vh, 10), cmC);
    v.position.set((rng() - 0.5) * (w - 1.5), roofTop + vh / 2, (rng() - 0.5) * (d - 1.5));
    group.add(v);
    registerSolid(v);
  }
  const antN = 1 + ((rng() * 2) | 0);
  for (let i = 0; i < antN; i++) {
    // ENV2-3: ~1.5x antennas
    const ar = 0.06,
      ah = 2.4 + rng() * 2.4;
    const a = new THREE.Mesh(new THREE.CylinderGeometry(ar, ar * 1.5, ah, 8), cmC);
    a.position.set((rng() - 0.5) * (w - 1), roofTop + ah / 2, (rng() - 0.5) * (d - 1));
    a.rotation.z = jitter(0.12);
    group.add(a);
    registerSolid(a);
  }
  // broken parapet: blocks along the two outer edges with occasional gaps
  const step = 1.2;
  for (let x = -w / 2; x <= w / 2; x += step) {
    if (rng() > 0.25) {
      // ENV2-3: slightly larger parapet blocks
      const pb = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.6, 0.45), cmC);
      pb.position.set(x, roofTop + 0.3, d / 2 + 0.15);
      group.add(pb);
      registerSolid(pb);
    }
  }
  for (let z = -d / 2; z <= d / 2; z += step) {
    if (rng() > 0.25) {
      const pb = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.6, 1.35), cmC);
      pb.position.set(w / 2 + 0.15, roofTop + 0.3, z);
      group.add(pb);
      registerSolid(pb);
    }
  }

  // ---- Round 4: much denser roof clutter (water tank, satellite dish,
  //      cable runs, signage billboards, antenna arrays). All cosmetic;
  //      registered as solid so they cast shadows but never block the
  //      ground (they're above h + 0.25 already).
  // 1) Water tank on short legs
  if (rng() > 0.3) {
    const tankR = 0.55 + rng() * 0.2;
    const tankH = 1.0 + rng() * 0.4;
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(tankR, tankR, tankH, 14), cmB);
    const tx = (rng() - 0.5) * (w - 2);
    const tz = (rng() - 0.5) * (d - 2);
    tank.position.set(tx, roofTop + tankH / 2, tz);
    group.add(tank);
    registerSolid(tank);
    // 4 short legs
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.08), cmA);
      leg.position.set(tx + Math.cos(a) * (tankR * 0.7), roofTop + 0.2, tz + Math.sin(a) * (tankR * 0.7));
      group.add(leg);
      registerSolid(leg);
    }
  }
  // 2) Satellite dish (parabolic dish + arm + receiver)
  if (rng() > 0.5) {
    const dishR = 0.45 + rng() * 0.25;
    const dish = new THREE.Mesh(new THREE.SphereGeometry(dishR, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.2), cmA);
    dish.material.side = THREE.DoubleSide;
    const dx = (rng() - 0.5) * (w - 2);
    const dz = (rng() - 0.5) * (d - 2);
    dish.position.set(dx, roofTop + dishR * 0.45, dz);
    dish.rotation.z = Math.PI - 0.3 + rng() * 0.6;
    dish.rotation.y = rng() * Math.PI * 2;
    group.add(dish);
    registerSolid(dish);
    // arm + receiver box
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, dishR * 1.4), cmA);
    arm.position.set(dx, roofTop + dishR * 1.1, dz);
    arm.rotation.x = dish.rotation.z + Math.PI / 2;
    group.add(arm);
    registerSolid(arm);
    const recv = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.08), cmB);
    recv.position.set(dx, roofTop + dishR * 1.25, dz);
    group.add(recv);
    registerSolid(recv);
  }
  // 3) Cable runs (a few long thin boxes snaking along the roof)
  for (let i = 0; i < 2; i++) {
    const cl = 1.8 + rng() * 1.2;
    const cw = 0.06, ch = 0.04;
    const cable = new THREE.Mesh(new THREE.BoxGeometry(cl, ch, cw), cmA);
    const cx = (rng() - 0.5) * (w - 3);
    const cz = (rng() - 0.5) * (d - 3);
    cable.position.set(cx, roofTop + 0.05, cz);
    cable.rotation.y = rng() * Math.PI * 2;
    group.add(cable);
    registerSolid(cable);
  }
  // 4) Signage billboard on the roof edge (canvas-textured faded paint)
  if (rng() > 0.4) {
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.7, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x6e655a, roughness: 0.9 })
    );
    const sx = (rng() > 0.5 ? 1 : -1) * (w / 2 + 0.2);
    board.position.set(sx, roofTop + 1.2, (rng() - 0.5) * (d - 1.5));
    board.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(board);
    registerSolid(board);
  }
  // 5) Antenna array — 3 short rods in a triangle near one corner
  if (rng() > 0.4) {
    const ax = (rng() > 0.5 ? 1 : -1) * (w / 2 - 1.0);
    const az = (rng() - 0.5) * (d - 2);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const r = 0.18;
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4 + rng() * 0.6, 8), cmA);
      rod.position.set(ax + Math.cos(a) * r, roofTop + 0.7, az + Math.sin(a) * r);
      rod.rotation.z = jitter(0.1);
      group.add(rod);
      registerSolid(rod);
    }
  }
}

// ENV2-3: a protruding external staircase/duct volume on one side of a
// building, breaking the plain box silhouette. Steps climb from the ground and
// jut out past the +x face. Registered as solid colliders (it sits far from
// the spawn lane, so it never blocks the spawn corridor).
function addBuildingStair(group, w, d) {
  const steps = 6;
  const stX = w / 2 + 0.28; // protrude beyond the +x face
  const stepW = 1.4;
  const stepRun = 0.45;
  const stepH = 0.42;
  const stairMat = mat(PALETTE.concrete, 0.95, 0.0);
  for (let i = 0; i < steps; i++) {
    const h = stepH * (i + 1);
    const box = new THREE.Mesh(new THREE.BoxGeometry(stepW, h, stepRun), stairMat);
    box.position.set(stX, h / 2, -d / 4 + i * stepRun);
    group.add(box);
    register(box);
  }
  // landing + a chunky external duct on top of the stair
  const landing = new THREE.Mesh(new THREE.BoxGeometry(stepW, 0.2, stepRun * 1.5), stairMat);
  landing.position.set(stX, stepH * steps + 0.1, -d / 4 + steps * stepRun);
  group.add(landing);
  register(landing);
  const duct = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.22, 1.6, 10),
    mat(PALETTE.rust, 0.8, 0.3)
  );
  duct.position.set(stX, stepH * steps + 0.9, -d / 4 + steps * stepRun);
  duct.rotation.z = Math.PI / 2;
  group.add(duct);
  registerSolid(duct);
}

// Two thin jambs flanking a doorway gap, protruding OUT from the shell face so
// the opening reads as depth, not a slice. These DO block movement.
function buildDoorFrame(group, wallMat, gap, faceZ) {
  const doorH = 2.6; // door height + 0.4
  const jw = 0.2; // jamb thickness
  const jd = 0.6; // jamb protrusion (extends OUT)
  const jambGeo = new THREE.BoxGeometry(jw, doorH, jd);
  const left = new THREE.Mesh(jambGeo, wallMat);
  left.position.set(-gap / 2 - jw / 2, doorH / 2, faceZ + jd / 2);
  group.add(left);
  register(left);
  const right = new THREE.Mesh(jambGeo, wallMat);
  right.position.set(gap / 2 + jw / 2, doorH / 2, faceZ + jd / 2);
  group.add(right);
  register(right);
}

function buildings(scene, bounds) {
  // Round 4: capture building footprints so the minimap can render them as
  // rotated gray rectangles (CoD-style tactical map).
  if (!('_buildingFootprints' in globalThis)) globalThis._buildingFootprints = [];
  globalThis._buildingFootprints.length = 0;

  // Two large shells forming a compound with a doorway gap between them.
  // ENV-3: painted upper band (lighter concrete) + stained lower band for a
  // clear two-material break on every wall.
  const wallMat = mat(0x9a948a, 0.9, 0.0); // painted upper band
  const bandMat = mat(PALETTE.earthen, 1.0, 0.0); // stained lower concrete band
  const metalMat = mat(PALETTE.metal, 0.7, 0.4);

  // ---- Building A (left shell) ----
  const a = new THREE.Group();
  const aW = 9,
    aD = 5,
    t = 0.5;
  buildSegmentedWall(a, wallMat, {
    axis: 'x',
    length: aW,
    heights: [5, 6, 7], // stepped silhouette
    thickness: t,
    cx: 0,
    cz: -aD / 2,
    face: '-',
    winRows: [2.0, 3.5, 5.0],
    winCols: 3,
    bandMat,
  });
  buildSegmentedWall(a, wallMat, {
    axis: 'z',
    length: aD,
    heights: [5, 6],
    thickness: t,
    cx: -aW / 2,
    cz: 0,
    face: '-',
    winRows: [2.0, 3.5],
    winCols: 2,
    bandMat,
  });
  buildSegmentedWall(a, wallMat, {
    axis: 'z',
    length: aD,
    heights: [6, 5],
    thickness: t,
    cx: aW / 2,
    cz: 0,
    face: '+',
    winRows: [2.0, 3.5],
    winCols: 2,
    bandMat,
  });
  buildRoof(a, metalMat, aW, aD, 7);
  addBuildingBaseDetail(a, aW, aD);
  addBuildingStair(a, aW, aD);
  addBuildingSignage(a, aW, aD, 7, 'OVERWATCH');
  a.position.set(-18, 0, -28);
  a.rotation.y = 0.15;
  scene.add(a);
  globalThis._buildingFootprints.push({ x: -18, z: -28, w: aW, d: aD, rot: 0.15 });

  // ---- Building B (right shell) with a doorway gap in the front wall ----
  const b = new THREE.Group();
  const bW = 8,
    bD = 5,
    bt = 0.5;
  const gap = 1.8;
  const sideW = (bW - gap) / 2;
  buildSegmentedWall(b, wallMat, {
    axis: 'x',
    length: bW,
    heights: [5, 7, 6], // stepped silhouette
    thickness: bt,
    cx: 0,
    cz: -bD / 2,
    face: '-',
    winRows: [2.0, 3.5, 5.0],
    winCols: 3,
    bandMat,
  });
  buildSegmentedWall(b, wallMat, {
    axis: 'z',
    length: bD,
    heights: [5.5],
    thickness: bt,
    cx: bW / 2,
    cz: 0,
    face: '+',
    winRows: [2.0, 3.5],
    winCols: 2,
    bandMat,
  });
  // front wall split into two pieces of different heights -> doorway gap in the middle
  buildSegmentedWall(b, wallMat, {
    axis: 'x',
    length: sideW,
    heights: [6],
    thickness: bt,
    cx: -gap / 2 - sideW / 2,
    cz: bD / 2,
    face: '+',
    winRows: [2.0, 3.5, 5.0],
    winCols: 1,
    bandMat,
  });
  buildSegmentedWall(b, wallMat, {
    axis: 'x',
    length: sideW,
    heights: [5],
    thickness: bt,
    cx: gap / 2 + sideW / 2,
    cz: bD / 2,
    face: '+',
    winRows: [2.0, 3.5],
    winCols: 1,
    bandMat,
  });
  buildDoorFrame(b, wallMat, gap, bD / 2); // real doorway depth
  buildRoof(b, metalMat, bW, bD, 7);
  addBuildingBaseDetail(b, bW, bD);
  addBuildingStair(b, bW, bD);
  addBuildingSignage(b, bW, bD, 7, 'SECTOR-7');
  b.position.set(18, 0, -26);
  b.rotation.y = -0.12;
  scene.add(b);
  globalThis._buildingFootprints.push({ x: 18, z: -26, w: bW, d: bD, rot: -0.12 });
}

// ENV2-2: soft radial dark-fade texture for contact-AO ground planes — gives a
// feathered edge instead of a hard slab. Cached so both buildings share one.
let _contactTex = null;
function contactTexture() {
  if (_contactTex) return _contactTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const cx = c.getContext('2d');
  const g = cx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0.0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.32)');
  g.addColorStop(0.82, 'rgba(0,0,0,0.10)');
  g.addColorStop(1.0, 'rgba(0,0,0,0.0)');
  cx.fillStyle = g;
  cx.fillRect(0, 0, 256, 256);
  _contactTex = new THREE.CanvasTexture(c);
  _contactTex.colorSpace = THREE.SRGBColorSpace;
  return _contactTex;
}

// ENV-5 + GRD-3: connect each building to the terrain — foundation skirt, a
// thin dark dirt-accumulation decal strip on the ground, and rubble / broken
// concrete chunks around the base. All cosmetic so they never block movement.
// Group-local coordinates (origin = building center).
function addBuildingBaseDetail(group, w, d) {
  const skirtMat = mat(PALETTE.earthen, 1.0, 0.0);
  const concreteMat = mat(PALETTE.concrete, 0.95, 0.0);

  // foundation skirt — concrete lip slightly larger than the footprint
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.4, d + 0.6), skirtMat);
  skirt.position.set(0, 0.2, 0);
  group.add(skirt);
  registerSolid(skirt);

  // GRD-3 / ENV2-2: soft dark dirt-accumulation plane on the ground — a
  // feathered radial-alpha Plane replacing the old hard-edged box slab.
  const dirt = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 1.6, d + 1.6),
    new THREE.MeshBasicMaterial({
      map: contactTexture(),
      transparent: true,
      depthWrite: false,
      color: 0x000000,
      fog: false,
    })
  );
  dirt.rotation.x = -Math.PI / 2;
  dirt.position.set(0, 0.03, 0);
  dirt.renderOrder = 2;
  group.add(dirt);
  registerCosmetic(dirt);

  // ENV-5: rubble piles + broken concrete chunks at the base
  const rubbleN = 5 + ((rng() * 4) | 0);
  for (let i = 0; i < rubbleN; i++) {
    let rx, rz;
    if (rng() < 0.5) {
      rx = (rng() - 0.5) * (w + 1);
      rz = (rng() < 0.5 ? -1 : 1) * (d / 2 + 0.4 + rng() * 0.8);
    } else {
      rz = (rng() - 0.5) * (d + 1);
      rx = (rng() < 0.5 ? -1 : 1) * (w / 2 + 0.4 + rng() * 0.8);
    }
    const s = 0.25 + rng() * 0.4;
    const chunk = new THREE.Mesh(
      new THREE.BoxGeometry(s, s * 0.6, s),
      rng() > 0.5 ? skirtMat : concreteMat
    );
    chunk.position.set(rx, s * 0.3, rz);
    chunk.rotation.set(jitter(0.4), jitter(Math.PI), jitter(0.4));
    group.add(chunk);
    registerSolid(chunk);
  }
}

// Round 4: painted wall signage. A thin plane mounted on the front (or side)
// of the building with a canvas-baked faded-paint texture. Just enough to
// break up the blank concrete — reads as a CoD-style urban marker.
let _signageTex = null;
function signageTexture(label) {
  // build once per label (cheap; only a handful of unique labels)
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d');
  // background: weathered painted band
  ctx.fillStyle = '#5a544a';
  ctx.fillRect(0, 0, 256, 128);
  // weathered streaks (random dark vertical strokes)
  ctx.fillStyle = 'rgba(20,18,12,0.35)';
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * 256;
    const w = 2 + Math.random() * 6;
    ctx.fillRect(x, 0, w, 128);
  }
  // text — bold stencil-style uppercase, off-white
  ctx.fillStyle = '#e2d9c8';
  ctx.font = 'bold 56px Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 128, 64);
  // subtle outline
  ctx.strokeStyle = 'rgba(20,18,12,0.55)';
  ctx.lineWidth = 2;
  ctx.strokeText(label, 128, 64);
  // a bit more grime
  ctx.fillStyle = 'rgba(15,12,8,0.18)';
  for (let i = 0; i < 40; i++) {
    ctx.fillRect(Math.random() * 256, Math.random() * 128, Math.random() * 4, Math.random() * 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function addWallSignage(group, w, h, label, face /* 'front' | 'side' */) {
  // face=front means paint on the +Z wall (camera-facing when approaching)
  const planeW = Math.min(w * 0.7, 3.2);
  const planeH = 0.7;
  const tex = signageTexture(label);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.0 });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), mat);
  if (face === 'front') {
    plane.position.set(-w * 0.18, h * 0.55, d / 2 + 0.26); // wait: need d in scope
  } else {
    plane.position.set(-w / 2 - 0.26, h * 0.55, 0);
    plane.rotation.y = Math.PI / 2;
  }
  group.add(plane);
  registerSolid(plane);
}

// Round 4: simpler signature call used by buildings() — picks a face and a
// random label, places the plane on the appropriate wall. Uses the building
// group's local axes (which match world before the group is rotated/translated).
function addBuildingSignage(group, w, d, h, label) {
  const planeW = Math.min(w * 0.7, 3.2);
  const planeH = 0.7;
  const tex = signageTexture(label);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.0 });
  // place on the front (+Z) face, just above the windows
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), mat);
  plane.position.set(0, h * 0.62, d / 2 + 0.26);
  group.add(plane);
  registerSolid(plane);
}

// ENV-1: each perimeter wall is split into 4 height-stepped segments with
// intermittent vertical support ribs, occasional crenellations (battlements
// with damage gaps), and per-segment color/roughness variation so the
// silhouette breaks up instead of reading as a flat endless slab.
function perimeter(scene, bounds) {
  const long = bounds * 2;
  const t = 1.0;
  const walls = [
    { axis: 'x', fixed: -bounds }, // north (z = -bounds)
    { axis: 'x', fixed: bounds }, // south (z = +bounds)
    { axis: 'z', fixed: -bounds }, // west (x = -bounds)
    { axis: 'z', fixed: bounds }, // east (x = +bounds)
  ];
  for (const wd of walls) buildPerimeterWall(scene, wd.axis, long, wd.fixed, t);
}

function buildPerimeterWall(scene, axis, length, fixed, t) {
  const nSeg = 4; // 3-4 segments
  const segLen = length / nSeg;
  for (let i = 0; i < nSeg; i++) {
    const off = -length / 2 + segLen * (i + 0.5);
    const baseH = 5 + rng() * 2.0; // stepped 5..7
    // per-segment material break: jittered concrete, varied roughness/value
    const m = jitteredMat(PALETTE.concrete, 0.82 + rng() * 0.16, 0.0);
    let w, d, x, z;
    if (axis === 'x') {
      w = segLen * 0.98;
      d = t;
      x = off;
      z = fixed;
    } else {
      w = t;
      d = segLen * 0.98;
      x = fixed;
      z = off;
    }
    const seg = new THREE.Mesh(new THREE.BoxGeometry(w, baseH, d), m);
    seg.position.set(x, baseH / 2, z);
    scene.add(seg);
    register(seg); // keep existing perimeter collider

    // crenellations (battlements) on top — with occasional gaps = damage
    if (rng() > 0.2) {
      const merlons = Math.max(2, Math.floor(segLen / 4));
      const mw = (segLen / merlons) * 0.6;
      for (let k = 0; k < merlons; k++) {
        if (rng() > 0.2) {
          const mh = 0.5 + rng() * 0.5;
          let mx, mz;
          if (axis === 'x') {
            mx = -segLen / 2 + (k + 0.5) * (segLen / merlons);
            mz = fixed;
          } else {
            mx = fixed;
            mz = -segLen / 2 + (k + 0.5) * (segLen / merlons);
          }
          const merlon = new THREE.Mesh(new THREE.BoxGeometry(axis === 'x' ? mw : t, mh, axis === 'x' ? t : mw), m);
          merlon.position.set(mx, baseH + mh / 2, mz);
          scene.add(merlon);
          register(merlon);
        }
      }
    }

    // occasional damage hole: recessed dark slab on the inner face (cosmetic)
    if (rng() > 0.45) {
      const holeMat = mat(PALETTE.oil, 0.95, 0.0);
      const hh = 1.0 + rng() * 1.0;
      const hw = 0.9 + rng() * 1.1;
      const hy = baseH * 0.35 + rng() * baseH * 0.3;
      const inward = fixed < 0 ? 1 : -1; // toward arena interior
      let hx, hz;
      if (axis === 'x') {
        hx = off + jitter(segLen * 0.2);
        hz = fixed + inward * (t / 2 + 0.02);
      } else {
        hx = fixed + inward * (t / 2 + 0.02);
        hz = off + jitter(segLen * 0.2);
      }
      const hole = new THREE.Mesh(
        new THREE.BoxGeometry(axis === 'x' ? hw : 0.06, hh, axis === 'x' ? 0.06 : hw),
        holeMat
      );
      hole.position.set(hx, hy, hz);
      scene.add(hole);
      registerSolid(hole);
    }
  }

  // intermittent vertical support ribs at segment boundaries
  for (let i = 1; i < nSeg; i++) {
    if (rng() > 0.45) continue;
    const off = -length / 2 + segLen * i;
    const ribH = 7 + rng() * 1.5;
    const ribMat = jitteredMat(PALETTE.concrete, 0.9, 0.0);
    let rw, rd, rx, rz;
    if (axis === 'x') {
      rw = 0.6;
      rd = t + 0.6;
      rx = off;
      rz = fixed;
    } else {
      rw = t + 0.6;
      rd = 0.6;
      rx = fixed;
      rz = off;
    }
    const rib = new THREE.Mesh(new THREE.BoxGeometry(rw, ribH, rd), ribMat);
    rib.position.set(rx, ribH / 2, rz);
    scene.add(rib);
    register(rib);
  }
}

// ---------------------------------------------------------------------------
// Spawn points — Round 11: ASSAULT-DIRECTION layout.
//
// The old candidate list wrapped the whole arena, including a point at (0, 20)
// — a mere 12m DIRECTLY BEHIND the player's start. A fresh spawn could take
// rounds in the back before ever turning around, which reads as broken rather
// than hard. Real FPS levels give you a secured rear and push the threat into
// a forward arc so the fight has a readable direction.
//
// Rules now enforced for EVERY hostile spawn (asserted by the QA harness):
//   * strictly AHEAD of the player (forward is -Z from the start at (0,0,8))
//   * inside a +/-61 degree fan, so they read as a front line, not a ring
//   * never closer than SAFE_RADIUS — the player always makes first contact
//   * tiered depth (contact / mid field / overwatch) so the push has shape
// ---------------------------------------------------------------------------
export const SPAWN_RULES = {
  playerStart: { x: 0, z: 8 },
  safeRadius: 28,       // metres; no hostile may spawn nearer than this
  rearLine: -6,         // every spawn must satisfy z <= this (well ahead)
  fanDeg: 61,           // max angle off the forward (-Z) axis
};

function buildSpawnPoints(bounds) {
  const playerStart = new THREE.Vector3(SPAWN_RULES.playerStart.x, 0, SPAWN_RULES.playerStart.z);
  const SAFE_RADIUS = SPAWN_RULES.safeRadius;
  const REAR_LINE = SPAWN_RULES.rearLine;
  const FAN = (SPAWN_RULES.fanDeg * Math.PI) / 180;
  const COS_FAN = Math.cos(FAN);

  const starts = [];

  // Hand-placed tiers, ordered near -> far. Kept clear of the two building
  // footprints ((-18,-28) and (18,-26)) and off the player's start corridor.
  const candidates = [
    // tier 1 — first contact (~30-34m out)
    new THREE.Vector3(-10, 0, -22),
    new THREE.Vector3(12, 0, -21),
    // tier 2 — mid field (~46-52m)
    new THREE.Vector3(-27, 0, -34),
    new THREE.Vector3(1, 0, -42),
    new THREE.Vector3(28, 0, -33),
    // tier 3 — overwatch / deep (~62-70m)
    new THREE.Vector3(-42, 0, -42),
    new THREE.Vector3(-2, 0, -57),
    new THREE.Vector3(43, 0, -44),
    // spare wide flanks — still ahead of the rear line, used only if the
    // hand-placed points above get rejected by cover.
    new THREE.Vector3(-50, 0, -20),
    new THREE.Vector3(50, 0, -22),
  ];

  // A point is legal only if it is ahead, outside the safe radius, and inside
  // the forward fan. This is the single source of truth the QA guard mirrors.
  const forwardOK = (c) => {
    if (c.z > REAR_LINE) return false;
    const dx = c.x - playerStart.x;
    const dz = c.z - playerStart.z;
    const dist = Math.hypot(dx, dz);
    if (dist < SAFE_RADIUS) return false;
    return (-dz) / (dist || 1) >= COS_FAN; // cos(angle off forward)
  };

  const clearOfCover = (c) => {
    for (const box of colliders) {
      if (box.containsPoint(c)) return false;
      // reject if an AABB is within ~0.8m horizontally
      const cx = Math.max(box.min.x, Math.min(c.x, box.max.x));
      const cz = Math.max(box.min.z, Math.min(c.z, box.max.z));
      const dx = c.x - cx, dz = c.z - cz;
      if (dx * dx + dz * dz < 0.64) return false;
    }
    return true;
  };

  for (const c of candidates) {
    if (starts.length >= 10) break;
    if (!forwardOK(c)) continue;
    if (!clearOfCover(c)) continue;
    starts.push(c.clone());
  }

  // Fallback sampler: same rules, random points inside the forward fan. Never
  // falls back to a full ring — a rear spawn is a bug, not a variation.
  let tries = 0;
  while (starts.length < 8 && tries < 800) {
    tries++;
    const ang = (rng() * 2 - 1) * FAN;
    const rad = SAFE_RADIUS + 4 + rng() * 38;
    const p = new THREE.Vector3(
      playerStart.x + Math.sin(ang) * rad,
      0,
      playerStart.z - Math.cos(ang) * rad,
    );
    if (Math.abs(p.x) > bounds - 6 || p.z < -(bounds - 6)) continue;
    if (!forwardOK(p)) continue;
    if (!clearOfCover(p)) continue;
    let clumped = false;
    for (const s of starts) { if (s.distanceTo(p) < 8) { clumped = true; break; } }
    if (clumped) continue;
    starts.push(p);
  }

  return starts;
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------
export function buildArena(scene, renderer) {
  colliders = [];
  solids = [];

  // P2#22 — anisotropy needs a renderer reference. Clamp to 1 when absent so
  // the module still works headless.
  const MAX_ANISO = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;

  const bounds = 60; // arena extends ±60 (120x120 playable area)
  const half = bounds;

  buildSky(scene);
  const ground = buildGround(scene, half, MAX_ANISO);
  buildLighting(scene);

  // --- Static blockers first so spawn points clear them ------------------
  perimeter(scene, bounds);
  buildings(scene, bounds);

  // Compute spawn points now that the static colliders exist, BEFORE placing
  // the dense new cover — so new cover can be kept out of the spawn lanes.
  const spawnPoints = buildSpawnPoints(bounds);

  // --- Prop placement: clustered rejection sampler (ENV-2) ----------------
  // Cover props are clustered into coherent "islands" around pre-chosen
  // cluster centers, kept out of the central corridor, building footprints,
  // and (critically) the spawn-point forward lanes (PLAYER MOVEMENT GATE).
  const placed = [];
  const footprints = [
    { x: -18, z: -28, hw: 6.0, hd: 4.0 }, // building A (slightly inset/larger)
    { x: 18, z: -26, hw: 5.5, hd: 4.0 }, // building B
  ];
  const inBuilding = (x, z) => {
    for (const f of footprints) {
      if (Math.abs(x - f.x) <= f.hw && Math.abs(z - f.z) <= f.hd) return true;
    }
    return false;
  };
  const inCorridor = (x, z) => x > -6 && x < 6 && z > 2 && z < 14;

  // PLAYER MOVEMENT GATE: keep spawnPoints[0]'s -Z forward lane (14m) and a
  // 4m radius around every spawn clear of NEW solid colliders.
  const spawnLane = spawnPoints[0];
  const blocksSpawn = (x, z) => {
    for (const sp of spawnPoints) {
      const dx = x - sp.x,
        dz = z - sp.z;
      if (dx * dx + dz * dz < 16) return true; // 4m radius
    }
    if (spawnLane) {
      // forward = -Z: lane from spawn.z-14 .. spawn.z+1, within x±3.5
      if (Math.abs(x - spawnLane.x) < 3.5 && z < spawnLane.z + 1 && z > spawnLane.z - 14)
        return true;
    }
    return false;
  };

  // Cluster centers for cover islands (mid/outer field, away from hazards).
  const clusters = [];
  for (let i = 0; i < 80 && clusters.length < 14; i++) {
    const x = (rng() - 0.5) * 2 * (bounds - 12);
    const z = (rng() - 0.5) * 2 * (bounds - 12);
    if (inCorridor(x, z)) continue;
    if (inBuilding(x, z)) continue;
    if (blocksSpawn(x, z)) continue;
    clusters.push({ x, z });
  }

  function findSpot(r) {
    const margin = r + 4;
    for (let t = 0; t < 140; t++) {
      // bias placement toward a random cluster center (ENV-2 islands)
      const cl = clusters.length ? clusters[(rng() * clusters.length) | 0] : null;
      let x, z;
      if (cl) {
        x = Math.max(-bounds + margin, Math.min(bounds - margin, cl.x + jitter(4)));
        z = Math.max(-bounds + margin, Math.min(bounds - margin, cl.z + jitter(4)));
      } else {
        x = (rng() - 0.5) * 2 * (bounds - margin);
        z = (rng() - 0.5) * 2 * (bounds - margin);
      }
      if (inCorridor(x, z)) continue;
      if (inBuilding(x, z)) continue;
      if (blocksSpawn(x, z)) continue;
      let ok = true;
      for (const p of placed) {
        const dx = x - p.x,
          dz = z - p.z;
        const minD = r + p.r + 1.2;
        if (dx * dx + dz * dz < minD * minD) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      placed.push({ x, z, r });
      return { x, z };
    }
    return null; // give up this prop rather than overlap
  }

  // Props — substantially increased counts, clustered into cover islands.
  crates(scene, 45, bounds, findSpot);
  barriers(scene, 22, bounds, findSpot);
  brokenWalls(scene, 8, bounds, findSpot);
  sandbags(scene, 14, bounds, findSpot);
  barrels(scene, 16, bounds, findSpot);
  tires(scene, 10, bounds, findSpot);

  // Ground is a bullet target but NOT a movement collider (P0#3).
  solids.push(ground);

  // Round 5: animated props — a waving rooftop flag + a pulsing beacon light.
  buildDynamic(scene);

  const _env = {
    colliders,
    solids,
    spawnPoints,
    // Round 11: the contract every hostile spawn must satisfy (forward fan,
    // safe radius, rear line). Exposed so the QA harness can assert against
    // the same numbers the generator used — no drift between code and test.
    spawnRules: SPAWN_RULES,
    bounds: {
      min: new THREE.Vector3(-bounds, 0, -bounds),
      max: new THREE.Vector3(bounds, 6, bounds),
    },
    // Round 4: building footprints for the tactical minimap (set by buildings())
    buildings: globalThis._buildingFootprints || [],
    // Round 5: advance flag wave + beacon blink.
    update(dt) {
      _dynTime += dt;
      if (_flagGeo && _flagBase) {
        const pos = _flagGeo.attributes.position;
        const arr = pos.array;
        const t = _dynTime;
        for (let i = 0; i < arr.length; i += 3) {
          const x0 = _flagBase[i];
          const y0 = _flagBase[i + 1];
          // free end (x=1.4) waves most; pinned at the pole (x=0)
          const f = Math.min(1, Math.max(0, x0 / 1.4));
          arr[i + 2] = _flagBase[i + 2] +
            Math.sin(x0 * 4.0 + t * 6.0) * 0.12 * f +
            Math.sin(y0 * 3.0 + t * 4.0) * 0.04 * f;
        }
        pos.needsUpdate = true;
        _flagGeo.computeVertexNormals();
      }
      if (_beaconLight && _beaconMat) {
        const pulse = 0.5 + 0.5 * Math.sin(_dynTime * 4.5);
        _beaconLight.intensity = 0.3 + pulse * 3.2;
        _beaconMat.emissiveIntensity = 0.3 + pulse * 2.2;
      }
      if (_beaconShaftMat) {
        // shaft brightens with the beacon pulse
        const pulse = 0.5 + 0.5 * Math.sin(_dynTime * 4.5);
        _beaconShaftMat.opacity = 0.05 + pulse * 0.11;
      }
    },
  };
  return _env;
}

// Round 5: animated rooftop props. A flagpole with a flag that waves (vertex
// animated in env.update) on building A, and a pulsing red beacon on building B.
function buildDynamic(scene) {
  const ROOF = 7.0;

  // ---- flagpole on building A roof (center -18, -28) ----
  const poleH = 3.0;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.06, poleH, 8),
    new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.4 })
  );
  pole.position.set(-18, ROOF + poleH / 2, -30);
  pole.castShadow = true;
  scene.add(pole);
  const finial = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xd9d9d9, metalness: 0.8, roughness: 0.3 })
  );
  finial.position.set(-18, ROOF + poleH, -30);
  scene.add(finial);

  // flag: segmented plane so it can ripple. Left edge pinned to the pole.
  _flagGeo = new THREE.PlaneGeometry(1.4, 0.9, 14, 6);
  _flagGeo.translate(0.7, 0, 0); // shift so x in [0,1.4], pole at x=0
  _flagBase = Float32Array.from(_flagGeo.attributes.position.array);
  const flagMat = new THREE.MeshStandardMaterial({
    color: 0x8a1f1f, metalness: 0.0, roughness: 0.85, side: THREE.DoubleSide,
  });
  const flag = new THREE.Mesh(_flagGeo, flagMat);
  flag.position.set(-18, ROOF + poleH - 0.5, -30);
  flag.castShadow = true;
  scene.add(flag);

  // ---- pulsing red beacon on building B roof (center 18, -26) ----
  _beaconMat = new THREE.MeshStandardMaterial({
    color: 0x3a0a0a, emissive: 0xff2a1a, emissiveIntensity: 1.0, roughness: 0.5,
  });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), _beaconMat);
  beacon.position.set(18, ROOF + 0.5, -24);
  scene.add(beacon);
  _beaconLight = new THREE.PointLight(0xff3a26, 2.0, 14, 2);
  _beaconLight.position.copy(beacon.position);
  scene.add(_beaconLight);
  // small mast under the beacon
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.05, 0.5, 6),
    new THREE.MeshStandardMaterial({ color: 0x6a6f74, metalness: 0.6, roughness: 0.5 })
  );
  mast.position.set(18, ROOF + 0.25, -24);
  scene.add(mast);

  // Round 7: cheap volumetric light shaft — an additive, depth-write-off cone
  // rising from the beacon. Its opacity is pulsed in sync with the beacon so it
  // reads as a column of light rather than a solid mesh. SwiftShader-friendly.
  _beaconShaftMat = new THREE.MeshBasicMaterial({
    color: 0xff5a3a,
    transparent: true,
    opacity: 0.1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const shaftGeo = new THREE.ConeGeometry(1.25, 6.5, 16, 1, true);
  _beaconShaft = new THREE.Mesh(shaftGeo, _beaconShaftMat);
  // ConeGeometry: apex at +y/2, base (wide) at -y/2. Position so the wide base
  // sits just above the beacon and the point rises ~6.5m into the sky.
  _beaconShaft.position.set(18, ROOF + 0.5 + 3.25, -24);
  scene.add(_beaconShaft);
}
