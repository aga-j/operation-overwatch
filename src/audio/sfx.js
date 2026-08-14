// Round 5: lightweight synthesized SFX (no external audio assets).
//
// Everything is gated behind an explicit init() that must be called from a
// user gesture (pointer-lock). In headless/demo mode init() is never called,
// so every method is a safe no-op and nothing touches the AudioContext — which
// matters because headless Chrome in a sandbox has no audio device and would
// otherwise throw during the automated playtest.
export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
    this._noise = null;
  }

  init() {
    if (this.enabled || this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.45;
      this.master.connect(this.ctx.destination);

      // one reusable white-noise buffer for cracks/impacts
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._noise = buf;

      this.enabled = true;
    } catch (e) {
      this.enabled = false;
    }
  }

  resume() {
    try { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); } catch (e) {}
  }

  _noiseBurst(t, dur, cutoff, gain) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    lp.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  _thump(t, f0, f1, dur, gain) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  shot() {
    if (!this.enabled) return;
    try {
      const t = this.ctx.currentTime;
      this._noiseBurst(t, 0.18, 2400, 0.9); // crack
      this._thump(t, 150, 48, 0.13, 0.6);   // low body
    } catch (e) {}
  }

  hit() {
    if (!this.enabled) return;
    try {
      const t = this.ctx.currentTime;
      this._noiseBurst(t, 0.06, 3200, 0.4);
      this._thump(t, 320, 120, 0.05, 0.3);
    } catch (e) {}
  }

  reload() {
    if (!this.enabled) return;
    try {
      const t = this.ctx.currentTime;
      this._noiseBurst(t, 0.04, 1800, 0.35);          // mag out
      this._noiseBurst(t + 0.35, 0.05, 2200, 0.4);    // mag slap in
    } catch (e) {}
  }

  // Enemy hit reaction — a short grunt/cry plus a falling body tone.
  // Round 7: triggered when a round connects with an enemy.
  enemyHit() {
    if (!this.enabled) return;
    try {
      const t = this.ctx.currentTime;
      this._noiseBurst(t, 0.18, 1500, 0.5);          // cry / grunt
      this._thump(t, 430, 90, 0.24, 0.4);            // body dropping
    } catch (e) {}
  }

  // Round 8: player-took-damage feedback — a dull impact body + a short, low
  // "ugh" of breath. Distinct from enemyHit (which is higher/more vocal).
  playerHurt() {
    if (!this.enabled) return;
    try {
      const t = this.ctx.currentTime;
      this._thump(t, 220, 60, 0.22, 0.6);            // chest impact
      this._noiseBurst(t + 0.02, 0.12, 900, 0.35);   // grunt of breath
    } catch (e) {}
  }

  // Soft footfall — triggered by the player's step cadence from main.js.
  step() {
    if (!this.enabled) return;
    try {
      const t = this.ctx.currentTime;
      this._noiseBurst(t, 0.10, 720, 0.22);  // crunch
      this._thump(t, 95, 52, 0.07, 0.14);    // low footfall body
    } catch (e) {}
  }

  // Continuous ambient wind bed (looping filtered noise + slow gust LFO).
  startWind() {
    if (!this.enabled || this._wind) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noise; src.loop = true;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 480;
      const g = this.ctx.createGain(); g.gain.value = 0.05;
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 0.11;
      const lfoGain = this.ctx.createGain(); lfoGain.gain.value = 0.035;
      lfo.connect(lfoGain); lfoGain.connect(g.gain);
      src.connect(lp); lp.connect(g); g.connect(this.master);
      src.start(); lfo.start();
      this._wind = { src, lfo };
    } catch (e) {}
  }
}
