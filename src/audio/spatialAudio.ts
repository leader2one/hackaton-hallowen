// Zero-dependency Web Audio API synthesizer for 360° Hot/Cold proximity sonar,
// animal vocalizations, leaf rustling, and camera shutter feedback.

class SpatialAudioEngine {
  private ctx: AudioContext | null = null;
  private muted: boolean = false;
  private lastPingTime: number = 0;

  private ensureContext(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public setMuted(mute: boolean) {
    this.muted = mute;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public unlock() {
    this.ensureContext();
  }

  // Hot/Cold sonar pulse called from the animation loop; automatically throttles based on angular proximity
  public tickProximitySonar(angleDeltaDeg: number, nowMs: number) {
    if (this.muted) return;
    // Interval ranges from 180ms when locked (<12 deg) to 1400ms when cold (>120 deg)
    const clamped = Math.max(0, Math.min(180, angleDeltaDeg));
    const intervalMs = 190 + (clamped / 180) * 1250;

    if (nowMs - this.lastPingTime < intervalMs) return;
    this.lastPingTime = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // Higher, brighter pitch as you get closer to the hidden animal
    const proximityNorm = 1 - clamped / 180; // 0 (cold) -> 1 (locked)
    const baseFreq = 280 + proximityNorm * 580;

    osc.type = proximityNorm > 0.82 ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(baseFreq, now);
    if (proximityNorm > 0.85) {
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.25, now + 0.08);
    }

    const peakGain = 0.03 + proximityNorm * 0.06;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.12);
  }

  public playShutter() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Crisp mechanical shutter click using filtered white noise burst
    const bufferSize = ctx.sampleRate * 0.06;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.015));
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1800, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
  }

  public playDiscoveryFanfare() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Warm ascending major 9th arpeggio
    const notes = [523.25, 659.25, 783.99, 1046.5, 1174.66];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const startTime = now + idx * 0.065;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.linearRampToValueAtTime(0.11, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.38);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.4);
    });
  }

  public playScanSweep() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(960, now + 0.35);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.4);
  }
}

export const spatialAudio = new SpatialAudioEngine();
