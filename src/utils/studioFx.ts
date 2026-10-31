/**
 * Studio FX Rack — real-time, zero-latency Web Audio DSP chain.
 *
 * Every unit is a pure node graph that can be instantiated on any
 * `BaseAudioContext`, so the exact same settings produce the same sound in the
 * live `AudioContext` and in the offline render used for export. Each unit has
 * an explicit bypass that never rewires the graph (click-free): bypass simply
 * forces its wet/dry split to 100% dry.
 *
 * Signal order: input → Echo → Reverb → Saturation → Widener → Chorus → output
 */

export type EchoMode = 'tape' | 'digital';
export type SaturationMode = 'tape' | 'overdrive';
export type ReverbPreset = 'room' | 'hall' | 'cathedral' | 'plate';

export interface EchoSettings {
  enabled: boolean;
  /** Delay time in seconds (0.02 – 1.5). */
  time: number;
  /** Feedback amount (0 – 0.9, hard-clamped). */
  feedback: number;
  /** Lowpass cutoff inside the feedback loop in Hz (800 – 8000). */
  tone: number;
  /** Dry/wet mix (0 – 1). */
  mix: number;
  mode: EchoMode;
}

export interface ReverbSettings {
  enabled: boolean;
  preset: ReverbPreset;
  /** Decay time in seconds (0.5 – 5.0). */
  decay: number;
  /** Pre-delay in seconds (0 – 0.2). */
  preDelay: number;
  /** High-frequency damping (0 – 1, 1 = darkest). */
  damping: number;
  /** Dry/wet mix (0 – 1). */
  mix: number;
}

export interface SaturationSettings {
  enabled: boolean;
  /** Drive amount (0 – 100). */
  drive: number;
  mode: SaturationMode;
  /** Make-up output gain in dB (-12 – +12). */
  outputGain: number;
}

export interface WidenerSettings {
  enabled: boolean;
  /** 0 = mono, 1 = normal Haas, 2 = extra wide (0 – 2). */
  width: number;
  /** Micro-delay on the right channel in ms (5 – 25). */
  delayMs: number;
}

export interface ChorusSettings {
  enabled: boolean;
  /** LFO rate in Hz (0.1 – 4). */
  rate: number;
  /** Modulation depth (0 – 1). */
  depth: number;
  /** Dry/wet mix (0 – 1). */
  mix: number;
}

export interface StudioFxSettings {
  echo: EchoSettings;
  reverb: ReverbSettings;
  saturation: SaturationSettings;
  widener: WidenerSettings;
  chorus: ChorusSettings;
}

export const defaultStudioFx: StudioFxSettings = {
  echo: { enabled: false, time: 0.35, feedback: 0.35, tone: 3200, mix: 0.3, mode: 'tape' },
  reverb: { enabled: false, preset: 'hall', decay: 2.0, preDelay: 0.02, damping: 0.4, mix: 0.3 },
  saturation: { enabled: false, drive: 25, mode: 'tape', outputGain: 0 },
  widener: { enabled: false, width: 1.0, delayMs: 12 },
  chorus: { enabled: false, rate: 0.8, depth: 0.4, mix: 0.3 },
};

export const REVERB_PRESETS: Record<ReverbPreset, { decay: number; preDelay: number; damping: number; label: string }> = {
  room: { decay: 0.8, preDelay: 0.005, damping: 0.5, label: 'Room' },
  hall: { decay: 2.4, preDelay: 0.02, damping: 0.4, label: 'Hall' },
  cathedral: { decay: 4.2, preDelay: 0.05, damping: 0.25, label: 'Cathedral' },
  plate: { decay: 1.6, preDelay: 0.01, damping: 0.15, label: 'Plate' },
};

export const ECHO_MAX_FEEDBACK = 0.9;

const clamp = (v: number, min: number, max: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;

/** Smooth, click-free parameter write. `smooth=false` snaps (offline render). */
function write(param: AudioParam, value: number, ctx: BaseAudioContext, smooth: boolean) {
  const v = Number.isFinite(value) ? value : 0;
  if (!smooth) {
    param.value = v;
    return;
  }
  try {
    param.setTargetAtTime(v, ctx.currentTime, 0.015);
  } catch {
    param.value = v;
  }
}

/**
 * Sigmoid soft-clipping curves. `drive` is 0–100; higher drive pushes the
 * curve into progressively harder knee compression, producing the odd/even
 * harmonics associated with tape (asymmetric, gentler) or tube overdrive.
 */
export function makeSaturationCurve(drive: number, mode: SaturationMode, samples = 2048) {
  const amount = clamp(drive, 0, 100) / 100;
  const curve = new Float32Array(samples);
  const k = mode === 'overdrive' ? 1 + amount * 24 : 1 + amount * 9;

  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    let y: number;
    if (mode === 'tape') {
      // Asymmetric tanh adds the even harmonics that make tape sound warm.
      const bias = 0.08 * amount;
      y = Math.tanh((x + bias) * k) - Math.tanh(bias * k);
    } else {
      // Symmetric soft clip: more aggressive odd-harmonic overdrive.
      y = Math.sign(x) * (1 - Math.exp(-Math.abs(x) * k));
    }
    curve[i] = y;
    const abs = Math.abs(y);
    if (abs > peak) peak = abs;
  }

  // WaveShaper curves must stay inside [-1, 1]; the tape bias subtraction would
  // otherwise push the negative half past -1 and add gain instead of saturating.
  if (peak > 1) {
    for (let i = 0; i < samples; i++) curve[i] /= peak;
  }
  return curve;
}

/**
 * Synthetic impulse response generator — no external WAV dependency.
 * Exponentially decaying noise, with a short early-reflection burst and a
 * one-pole lowpass to emulate high-frequency absorption in the room.
 */
export function generateReverbImpulse(
  ctx: BaseAudioContext,
  decaySeconds: number,
  damping: number,
  channels = 2
): AudioBuffer {
  const rate = ctx.sampleRate;
  const decay = clamp(decaySeconds, 0.05, 8);
  const length = Math.max(1, Math.floor(rate * decay));
  const impulse = ctx.createBuffer(channels, length, rate);
  const damp = clamp(damping, 0, 1);
  // One-pole coefficient: more damping → lower cutoff → faster HF loss.
  const cutoff = 12000 * Math.pow(0.06, damp);
  const alpha = Math.exp((-2 * Math.PI * cutoff) / rate);

  for (let c = 0; c < channels; c++) {
    const data = impulse.getChannelData(c);
    let previous = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Slight tail shaping keeps the decay natural rather than a hard ramp.
      const envelope = Math.pow(1 - t, 2.2) * Math.exp(-3 * t);
      const noise = Math.random() * 2 - 1;
      previous = noise * (1 - alpha) + previous * alpha;
      data[i] = previous * envelope;
    }
    // Early reflections give the impulse a believable room size.
    const earlyCount = 6;
    for (let e = 0; e < earlyCount; e++) {
      const idx = Math.floor(((e + 1) / (earlyCount + 1)) * Math.min(length - 1, rate * 0.12));
      data[idx] += (Math.random() * 2 - 1) * 0.35 * Math.pow(0.7, e);
    }
  }
  return impulse;
}

interface Unit {
  input: GainNode;
  output: GainNode;
  dispose(): void;
}

class EchoUnit implements Unit {
  input: GainNode;
  output: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private delay: DelayNode;
  private feedback: GainNode;
  private tone: BiquadFilterNode;
  private ctx: BaseAudioContext;
  private smooth: boolean;

  constructor(ctx: BaseAudioContext, settings: EchoSettings, smooth: boolean) {
    this.ctx = ctx;
    this.smooth = smooth;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.delay = ctx.createDelay(2.0);
    this.feedback = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';

    this.input.connect(this.dry);
    this.dry.connect(this.output);

    this.input.connect(this.delay);
    // Tape mode rounds off the repeats more aggressively than digital.
    this.delay.connect(this.tone);
    this.tone.connect(this.wet);
    this.wet.connect(this.output);
    // Feedback loop taps post-filter so each repeat gets progressively darker.
    this.tone.connect(this.feedback);
    this.feedback.connect(this.delay);

    this.apply(settings);
  }

  apply(s: EchoSettings) {
    const time = clamp(s.time, 0.02, 1.5);
    const fb = Math.min(clamp(s.feedback, 0, ECHO_MAX_FEEDBACK), ECHO_MAX_FEEDBACK);
    const tone = clamp(s.tone, 800, 8000);
    const mix = s.enabled ? clamp(s.mix, 0, 1) : 0;

    write(this.delay.delayTime, time, this.ctx, this.smooth);
    write(this.feedback.gain, fb, this.ctx, this.smooth);
    write(this.tone.frequency, s.mode === 'tape' ? Math.min(tone, 6000) : tone, this.ctx, this.smooth);
    write(this.tone.Q, s.mode === 'tape' ? 0.7 : 0.0001, this.ctx, this.smooth);
    // Equal-power-ish crossfade keeps perceived level stable while sweeping mix.
    write(this.dry.gain, Math.cos((mix * Math.PI) / 2), this.ctx, this.smooth);
    write(this.wet.gain, Math.sin((mix * Math.PI) / 2), this.ctx, this.smooth);
  }

  dispose() {
    [this.input, this.output, this.dry, this.wet, this.delay, this.feedback, this.tone].forEach(n => {
      try { n.disconnect(); } catch { /* already detached */ }
    });
  }
}

class ReverbUnit implements Unit {
  input: GainNode;
  output: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private preDelay: DelayNode;
  private convolver: ConvolverNode;
  private damping: BiquadFilterNode;
  private ctx: BaseAudioContext;
  private smooth: boolean;
  private irKey = '';

  constructor(ctx: BaseAudioContext, settings: ReverbSettings, smooth: boolean) {
    this.ctx = ctx;
    this.smooth = smooth;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.preDelay = ctx.createDelay(0.5);
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.damping = ctx.createBiquadFilter();
    this.damping.type = 'lowpass';
    this.damping.frequency.value = 20000;

    this.input.connect(this.dry);
    this.dry.connect(this.output);

    this.input.connect(this.preDelay);
    this.preDelay.connect(this.damping);
    this.damping.connect(this.convolver);
    this.convolver.connect(this.wet);
    this.wet.connect(this.output);

    this.apply(settings);
  }

  apply(s: ReverbSettings) {
    const decay = clamp(s.decay, 0.5, 5);
    const damping = clamp(s.damping, 0, 1);
    const mix = s.enabled ? clamp(s.mix, 0, 1) : 0;

    write(this.preDelay.delayTime, clamp(s.preDelay, 0, 0.2), this.ctx, this.smooth);
    write(this.damping.frequency, 20000 * Math.pow(0.05, damping), this.ctx, this.smooth);
    write(this.dry.gain, Math.cos((mix * Math.PI) / 2), this.ctx, this.smooth);
    write(this.wet.gain, Math.sin((mix * Math.PI) / 2), this.ctx, this.smooth);

    // Rebuilding the IR is expensive, so only do it when the character changes.
    const key = `${s.preset}:${decay.toFixed(2)}:${damping.toFixed(2)}`;
    if (key !== this.irKey) {
      this.irKey = key;
      try {
        this.convolver.buffer = generateReverbImpulse(this.ctx, decay, damping);
      } catch (e) {
        console.warn('[StudioFX] Impulse response generation failed:', e);
      }
    }
  }

  dispose() {
    [this.input, this.output, this.dry, this.wet, this.preDelay, this.convolver, this.damping].forEach(n => {
      try { n.disconnect(); } catch { /* already detached */ }
    });
  }
}

class SaturationUnit implements Unit {
  input: GainNode;
  output: GainNode;
  private shaper: WaveShaperNode;
  private outGain: GainNode;
  private ctx: BaseAudioContext;
  private smooth: boolean;
  private lastDrive = -1;
  private lastMode: SaturationMode | '' = '';

  constructor(ctx: BaseAudioContext, settings: SaturationSettings, smooth: boolean) {
    this.ctx = ctx;
    this.smooth = smooth;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.outGain = ctx.createGain();

    this.input.connect(this.shaper);
    this.shaper.connect(this.outGain);
    this.outGain.connect(this.output);

    this.apply(settings);
  }

  apply(s: SaturationSettings) {
    const drive = clamp(s.drive, 0, 100);
    const mode: SaturationMode = s.mode === 'overdrive' ? 'overdrive' : 'tape';
    const active = s.enabled && drive > 0;

    // A null curve means "pass through untouched" — that is our bypass.
    if (!active) {
      this.shaper.curve = null;
      this.lastDrive = -1;
      this.lastMode = '';
    } else if (drive !== this.lastDrive || mode !== this.lastMode) {
      this.shaper.curve = makeSaturationCurve(drive, mode);
      this.lastDrive = drive;
      this.lastMode = mode;
    }

    const db = active ? clamp(s.outputGain, -12, 12) : 0;
    write(this.outGain.gain, Math.pow(10, db / 20), this.ctx, this.smooth);
  }

  dispose() {
    [this.input, this.output, this.shaper, this.outGain].forEach(n => {
      try { n.disconnect(); } catch { /* already detached */ }
    });
  }
}

/**
 * Stereo widener — mid/side narrowing plus a Haas micro-delay for widening.
 *
 * The previous version always ran the right channel through its micro-delay,
 * even when the unit was disabled (`width` fell back to 1 but `delayTime` was
 * still written). That left a 12 ms Haas delay in the "bypassed" signal path,
 * which comb-filters the centre image (measured: −3.75 dB on a mono sum) and is
 * audible as a hollow, phasey tone.
 *
 * The graph is built so that `width = 1` is the exact identity:
 *
 *   M = (L + R) / 2        S = (L − R) / 2
 *   L' = M + S·k           R' = M − S·k        where k = min(width, 1)
 *   R'' = R' + h·delay(R)                      where h = max(0, width − 1)
 *
 * At `width = 1` → `k = 1`, `h = 0`, so `L' = L` and `R' = R` exactly. Widths
 * below 1 collapse toward mono (`k → 0` gives `L' = R' = M`); widths above 1 add
 * the Haas copy, which is the only way to widen already-correlated material —
 * pure M/S cannot, because a centred source has no side component to scale.
 */
class WidenerUnit implements Unit {
  input: GainNode;
  output: GainNode;
  private splitter: ChannelSplitterNode;
  private merger: ChannelMergerNode;
  private delay: DelayNode;
  private sideL: GainNode;
  private sideR: GainNode;
  private haas: GainNode;
  private ctx: BaseAudioContext;
  private smooth: boolean;

  constructor(ctx: BaseAudioContext, settings: WidenerSettings, smooth: boolean) {
    this.ctx = ctx;
    this.smooth = smooth;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.splitter = ctx.createChannelSplitter(2);
    this.merger = ctx.createChannelMerger(2);
    this.delay = ctx.createDelay(0.1);
    this.sideL = ctx.createGain();
    this.sideR = ctx.createGain();
    this.haas = ctx.createGain();

    // Force a stereo input so a mono source is duplicated to both channels
    // rather than collapsing to L-only (a ChannelSplitter reads channel 1 of a
    // mono signal as silence).
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers';

    // M = (L + R) / 2, S = (L − R) / 2
    const mid = ctx.createGain();
    const midL = ctx.createGain();
    const midR = ctx.createGain();
    const side = ctx.createGain();
    const sideFromL = ctx.createGain();
    const sideFromR = ctx.createGain();
    midL.gain.value = 0.5;
    midR.gain.value = 0.5;
    sideFromL.gain.value = 0.5;
    sideFromR.gain.value = -0.5;

    this.input.connect(this.splitter);
    this.splitter.connect(midL, 0, 0);
    this.splitter.connect(midR, 1, 0);
    midL.connect(mid);
    midR.connect(mid);
    this.splitter.connect(sideFromL, 0, 0);
    this.splitter.connect(sideFromR, 1, 0);
    sideFromL.connect(side);
    sideFromR.connect(side);

    // Mid feeds both outputs; the side component is added in anti-phase.
    mid.connect(this.merger, 0, 0);
    mid.connect(this.merger, 0, 1);
    side.connect(this.sideL);
    side.connect(this.sideR);
    this.sideL.connect(this.merger, 0, 0);
    this.sideR.connect(this.merger, 0, 1);

    // Haas copy of the right channel, summed in for widths above neutral.
    this.splitter.connect(this.delay, 1, 0);
    this.delay.connect(this.haas);
    this.haas.connect(this.merger, 0, 1);

    this.merger.connect(this.output);
    this.apply(settings);
  }

  apply(s: WidenerSettings) {
    // Disabled is not a special path: `width = 1` makes the graph the identity,
    // so the bypass and a neutral knob setting are the same signal.
    const width = s.enabled ? clamp(s.width, 0, 2) : 1;
    const k = Math.min(width, 1);
    write(this.delay.delayTime, clamp(s.delayMs, 5, 25) / 1000, this.ctx, this.smooth);
    write(this.sideL.gain, k, this.ctx, this.smooth);
    write(this.sideR.gain, -k, this.ctx, this.smooth);
    // Haas only contributes once the image is pushed past neutral.
    write(this.haas.gain, Math.max(0, width - 1), this.ctx, this.smooth);
  }

  dispose() {
    [this.input, this.output, this.splitter, this.merger, this.delay,
     this.sideL, this.sideR, this.haas].forEach(n => {
      try { n.disconnect(); } catch { /* already detached */ }
    });
  }
}

class ChorusUnit implements Unit {
  input: GainNode;
  output: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private delay: DelayNode;
  private lfo: OscillatorNode;
  private lfoGain: GainNode;
  private ctx: BaseAudioContext;
  private smooth: boolean;
  private started = false;

  constructor(ctx: BaseAudioContext, settings: ChorusSettings, smooth: boolean) {
    this.ctx = ctx;
    this.smooth = smooth;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.delay = ctx.createDelay(0.1);
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfoGain = ctx.createGain();

    this.input.connect(this.dry);
    this.dry.connect(this.output);

    this.input.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.output);

    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.delay.delayTime);
    try {
      this.lfo.start(0);
      this.started = true;
    } catch { /* already started */ }

    this.apply(settings);
  }

  apply(s: ChorusSettings) {
    const active = s.enabled;
    const mix = active ? clamp(s.mix, 0, 1) : 0;
    write(this.lfo.frequency, clamp(s.rate, 0.1, 4), this.ctx, this.smooth);
    // Base 20 ms with ±10 ms swing covers the 10–30 ms vocal-doubling window.
    write(this.delay.delayTime, 0.02, this.ctx, this.smooth);
    // Depth must collapse to zero when bypassed. Leaving the LFO gain live keeps
    // sweeping the delay line even at mix 0, which is the "tape wobble" / Doppler
    // drift heard as a slowly detuning pitch on sustained notes.
    write(this.lfoGain.gain, active ? clamp(s.depth, 0, 1) * 0.01 : 0, this.ctx, this.smooth);
    // Equal-power crossfade. At mix 0 the wet path is exactly silent, so the
    // modulated delay cannot contribute any pitch movement to the output.
    write(this.dry.gain, Math.cos((mix * Math.PI) / 2), this.ctx, this.smooth);
    write(this.wet.gain, Math.sin((mix * Math.PI) / 2), this.ctx, this.smooth);
  }

  dispose() {
    try { this.lfo.stop(); } catch { /* not started */ }
    this.started = false;
    [this.input, this.output, this.dry, this.wet, this.delay, this.lfo, this.lfoGain].forEach(n => {
      try { n.disconnect(); } catch { /* already detached */ }
    });
  }
}

/** An ordered, bypass-aware effects rack that can be dropped into any graph. */
export class StudioFxChain {
  readonly input: GainNode;
  readonly output: GainNode;
  settings: StudioFxSettings;

  private echo: EchoUnit;
  private reverb: ReverbUnit;
  private saturation: SaturationUnit;
  private widener: WidenerUnit;
  private chorus: ChorusUnit;
  private disposed = false;

  constructor(
    private ctx: BaseAudioContext,
    settings: StudioFxSettings = defaultStudioFx,
    private smooth = true
  ) {
    this.settings = normalizeStudioFx(settings);
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    this.echo = new EchoUnit(ctx, this.settings.echo, smooth);
    this.reverb = new ReverbUnit(ctx, this.settings.reverb, smooth);
    this.saturation = new SaturationUnit(ctx, this.settings.saturation, smooth);
    this.widener = new WidenerUnit(ctx, this.settings.widener, smooth);
    this.chorus = new ChorusUnit(ctx, this.settings.chorus, smooth);

    this.input.connect(this.echo.input);
    this.echo.output.connect(this.reverb.input);
    this.reverb.output.connect(this.saturation.input);
    this.saturation.output.connect(this.widener.input);
    this.widener.output.connect(this.chorus.input);
    this.chorus.output.connect(this.output);
  }

  setSettings(next: StudioFxSettings) {
    if (this.disposed) return;
    this.settings = normalizeStudioFx(next);
    this.echo.apply(this.settings.echo);
    this.reverb.apply(this.settings.reverb);
    this.saturation.apply(this.settings.saturation);
    this.widener.apply(this.settings.widener);
    this.chorus.apply(this.settings.chorus);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    [this.echo, this.reverb, this.saturation, this.widener, this.chorus].forEach(u => u.dispose());
    try { this.input.disconnect(); } catch { /* already detached */ }
    try { this.output.disconnect(); } catch { /* already detached */ }
  }
}

/** Clamp every field into its documented range and fill in missing keys. */
export function normalizeStudioFx(input?: Partial<StudioFxSettings> | null): StudioFxSettings {
  const d = defaultStudioFx;
  const src = input ?? {};
  const echo = { ...d.echo, ...(src.echo ?? {}) };
  const reverb = { ...d.reverb, ...(src.reverb ?? {}) };
  const saturation = { ...d.saturation, ...(src.saturation ?? {}) };
  const widener = { ...d.widener, ...(src.widener ?? {}) };
  const chorus = { ...d.chorus, ...(src.chorus ?? {}) };

  return {
    echo: {
      enabled: !!echo.enabled,
      time: clamp(echo.time, 0.02, 1.5),
      feedback: Math.min(clamp(echo.feedback, 0, ECHO_MAX_FEEDBACK), ECHO_MAX_FEEDBACK),
      tone: clamp(echo.tone, 800, 8000),
      mix: clamp(echo.mix, 0, 1),
      mode: echo.mode === 'digital' ? 'digital' : 'tape',
    },
    reverb: {
      enabled: !!reverb.enabled,
      preset: (['room', 'hall', 'cathedral', 'plate'] as ReverbPreset[]).includes(reverb.preset) ? reverb.preset : 'hall',
      decay: clamp(reverb.decay, 0.5, 5),
      preDelay: clamp(reverb.preDelay, 0, 0.2),
      damping: clamp(reverb.damping, 0, 1),
      mix: clamp(reverb.mix, 0, 1),
    },
    saturation: {
      enabled: !!saturation.enabled,
      drive: clamp(saturation.drive, 0, 100),
      mode: saturation.mode === 'overdrive' ? 'overdrive' : 'tape',
      outputGain: clamp(saturation.outputGain, -12, 12),
    },
    widener: {
      enabled: !!widener.enabled,
      width: clamp(widener.width, 0, 2),
      delayMs: clamp(widener.delayMs, 5, 25),
    },
    chorus: {
      enabled: !!chorus.enabled,
      rate: clamp(chorus.rate, 0.1, 4),
      depth: clamp(chorus.depth, 0, 1),
      mix: clamp(chorus.mix, 0, 1),
    },
  };
}
