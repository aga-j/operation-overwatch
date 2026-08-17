import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export function createRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

// Subtle cinematic vignette + faint film grain to sell the "graded" look.
// Round 5: warmer, more contrasty "teal-orange" military grade — CoD feel.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    offset: { value: 1.06 },
    darkness: { value: 1.25 },
    contrast: { value: 1.14 },
    saturation: { value: 1.22 },
    warmTint: { value: new THREE.Color(1.06, 1.00, 0.92) },
    shadowLift: { value: 0.018 },
    shadowTint: { value: new THREE.Color(0.92, 0.97, 1.04) },   // faint teal shadows
    highlightTint: { value: new THREE.Color(1.16, 1.02, 0.80) }, // warm orange highs
    grainAmt: { value: 0.05 },
    deathMix: { value: 0.0 },     // Round 8: 0 = alive, 1 = full death desaturate+red shift
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float offset;
    uniform float darkness;
    uniform float contrast;
    uniform float saturation;
    uniform vec3 warmTint;
    uniform float shadowLift;
  uniform vec3 shadowTint;
  uniform vec3 highlightTint;
  uniform float grainAmt;
  uniform float deathMix;
  varying vec2 vUv;
    float rand(vec2 co){ return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      // subtle chromatic aberration toward the edges (lens character)
      float ca = 0.0016 * dot(d, d) * 4.0;
      float rC = texture2D(tDiffuse, vUv + d * ca).r;
      float gC = texture2D(tDiffuse, vUv).g;
      float bC = texture2D(tDiffuse, vUv - d * ca).b;
      vec3 col = vec3(rC, gC, bC);

      // vignette
      float vig = clamp(pow(1.0 - dot(d * offset, d * offset), darkness), 0.0, 1.0);
      col *= vig;

      // contrast around mid-grey
      col = (col - 0.5) * contrast + 0.5;

      // saturation boost
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(lum), col, saturation);

      // global warm tint
      col *= warmTint;

      // teal-orange split-tone (filmic military grade)
      float t = smoothstep(0.0, 1.0, lum);
      col *= mix(shadowTint, highlightTint, t);

      // gentle shadow lift so darks aren't crushed to black
      float shadowMask = 1.0 - smoothstep(0.0, 0.5, lum);
      col += vec3(shadowLift) * shadowMask;

      // Round 8: death grade — desaturate and push toward a dark red as the
      // player goes down (driven by deathMix 0..1 from the death-cam sequence).
      if (deathMix > 0.0) {
        float dl = dot(col, vec3(0.299, 0.587, 0.114));
        vec3 deathCol = vec3(dl) * vec3(1.25, 0.32, 0.28);
        col = mix(col, deathCol, clamp(deathMix, 0.0, 1.0));
      }

      float grain = (rand(vUv * 1.7) - 0.5) * grainAmt;
      gl_FragColor = vec4(clamp(col + grain, 0.0, 1.0), 1.0);
    }
  `,
};

export function createComposer(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)),
    0.55, // strength
    0.55, // radius
    0.65  // threshold
  );
  composer.addPass(bloom);

  composer.addPass(new OutputPass());

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  return {
    composer,
    bloom,
    setSize(w, h) { composer.setSize(w, h); bloom.setSize(w, h); },
    // Round 8: ramp the death desaturation/red-shift (0 = alive, 1 = down).
    setDeathMix(v) { grade.uniforms.deathMix.value = Math.max(0, Math.min(1, v)); },
    render() { composer.render(); },
  };
}
