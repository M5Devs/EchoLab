import { audioBufferToWav } from './audioBufferToWav';
import { Mp3Encoder } from '@breezystack/lamejs';
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import {
  StudioFxChain,
  StudioFxSettings,
  defaultStudioFx,
  normalizeStudioFx,
} from './studioFx';
import { fetchAudioWithProxy } from './audioProxy';
import { validateAudioPayload } from './audioFormat';

export type EQBandType = 'lowshelf' | 'peaking' | 'highshelf' | 'lowpass' | 'highpass';

export interface EQBandDef {
  type: EQBandType;
  freq: number;
  gain: number;
  q: number;
}

export type CompressorDef = {
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  knee: number;
};

export type AudioEffects = {
  speed: number;
  reverb: number;
  pitch: number;
  bass: number;
  treble: number;
  distortion: number;
  delay: number;
  pan8D: number;
  volume: number;
  lowpass: number;
  highpass: number;
  eqBands: EQBandDef[];
  compressor: CompressorDef;
};

export const defaultEffects: AudioEffects = {
  speed: 1.0,
  reverb: 0,
  pitch: 0,
  bass: 0,
  treble: 0,
  distortion: 0,
  delay: 0,
  pan8D: 0,
  volume: 1.0,
  lowpass: 20000,
  highpass: 20,
  eqBands: [
    { type: 'highpass', freq: 40, gain: 0, q: 1 },
    { type: 'lowshelf', freq: 100, gain: 0, q: 1 },
    { type: 'peaking', freq: 1000, gain: 0, q: 1 },
    { type: 'peaking', freq: 4000, gain: 0, q: 1 },
    { type: 'highshelf', freq: 10000, gain: 0, q: 1 },
  ],
  compressor: {
    threshold: 0,
    ratio: 1,
    attack: 0.003,
    release: 0.25,
    knee: 30,
  }
};

/**
 * Transport rate bounds. `effects.speed` multiplies both the rendered duration
 * and `getCurrentTime()`, so a non-finite, zero or negative value would either
 * throw inside `AudioParam.value` or corrupt the startTime/pauseTime math and
 * present as playback that races or stalls. Playback rate is ONLY ever set from
 * the user's Speed control — never from a timer or animation frame.
 */
export const MIN_PLAYBACK_SPEED = 0.25;
export const MAX_PLAYBACK_SPEED = 4.0;

export function sanitizeSpeed(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  return Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, n));
}

/** Semitone detune bound; ±24 keeps `detune.value = pitch * 100` in a sane range. */
export function sanitizePitch(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(24, Math.max(-24, n));
}

/**
 * A self-contained, genuinely silent 1 s WAV, used as the hidden keep-alive
 * element's source.
 *
 * Generated rather than pasted: the obvious short literals circulating for this
 * job are malformed (their `fmt ` chunk declares a size of 18 but carries only
 * 16 bytes, so strict decoders reject them), and the tiniest "silent" clips
 * carry a non-zero sample. Building the header here guarantees a well-formed
 * 44-byte canonical PCM header followed by real zeros.
 *
 * Deliberately NOT a MediaStream (`srcObject`): many Android Chrome builds will
 * not raise a media notification for a MediaStream-sourced element. The element
 * is left unmuted (a muted element is also dropped) but carries no programme
 * audio, so it cannot become a second live output path.
 */
export function silentWavDataUri(seconds = 1, sampleRate = 8000): string {
  const samples = Math.max(1, Math.floor(seconds * sampleRate));
  const dataBytes = samples * 2; // 16-bit mono
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true);  // audioFormat = PCM
  view.setUint16(22, 1, true);  // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate
  view.setUint16(32, 2, true);  // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  // Sample payload stays zero-filled.

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** Keep-alive element gain: audible to Android's "is this playing?" check, imperceptible to humans. */
export const BRIDGE_VOLUME = 0.01;

export interface Track {
  id: string;
  name: string;
  buffer: AudioBuffer;
  gainNode?: GainNode;
  pannerNode?: StereoPannerNode;
  sourceNode?: AudioBufferSourceNode;
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
}

export interface LoudnessData {
  integratedLUFS: number;
  truePeak: number;
  dynamicRange: number;
  rms: number;
}

interface EchoLabDB extends DBSchema {
  projects: {
    key: string;
    value: {
      id: string;
      name: string;
      savedAt: number;
      duration?: number;
      effects: AudioEffects;
      studioFx?: StudioFxSettings;
      playlists: any[];
    };
  };
}

export class AudioEngine {
  ctx: AudioContext;
  buffer: AudioBuffer | null = null;
  source: AudioBufferSourceNode | null = null;
  analyser: AnalyserNode;
  mediaStreamDestination: MediaStreamAudioDestinationNode;
  audioBridge: HTMLAudioElement;

  highpassNode: BiquadFilterNode;
  lowpassNode: BiquadFilterNode;
  bassNode: BiquadFilterNode;
  trebleNode: BiquadFilterNode;

  eqNodes: BiquadFilterNode[] = [];

  distortionNode: WaveShaperNode;
  delayNode: DelayNode;
  delayMix: GainNode;
  reverbNode: ConvolverNode;
  reverbMix: GainNode;
  pannerNode: StereoPannerNode;
  pannerLfo: OscillatorNode;
  pannerLfoGain: GainNode;

  compressorNode: DynamicsCompressorNode;
  volumeNode: GainNode;

  channelMerger: ChannelMergerNode;
  tracks: Track[] = [];

  effects: AudioEffects = JSON.parse(JSON.stringify(defaultEffects));

  /** Studio FX rack (echo, reverb, saturation, widener, chorus). */
  studioFx: StudioFxSettings = normalizeStudioFx(defaultStudioFx);
  private studioFxChain: StudioFxChain | null = null;

  isPlaying = false;
  startTime = 0;
  pauseTime = 0;

  onEnded: () => void = () => {};
  onStateChange: () => void = () => {};

  historyStack: AudioBuffer[] = [];
  historyIndex = -1;
  maxHistory = 50;

  dbPromise: Promise<IDBPDatabase<EchoLabDB>>;

  mediaRecorder: MediaRecorder | null = null;
  recordedChunks: BlobPart[] = [];
  recordingStream: MediaStream | null = null;
  isRecording = false;

  loopStart = 0;
  loopEnd = 0;
  isLooping = false;

  constructor() {
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

    this.highpassNode = this.ctx.createBiquadFilter();
    this.highpassNode.type = 'highpass';

    this.lowpassNode = this.ctx.createBiquadFilter();
    this.lowpassNode.type = 'lowpass';

    this.bassNode = this.ctx.createBiquadFilter();
    this.bassNode.type = 'lowshelf';
    this.bassNode.frequency.value = 200;

    this.trebleNode = this.ctx.createBiquadFilter();
    this.trebleNode.type = 'highshelf';
    this.trebleNode.frequency.value = 8000;

    for (let i = 0; i < 5; i++) {
      const eqNode = this.ctx.createBiquadFilter();
      this.eqNodes.push(eqNode);
    }

    this.distortionNode = this.ctx.createWaveShaper();
    this.distortionNode.oversample = '4x';

    this.delayNode = this.ctx.createDelay(1.0);
    this.delayMix = this.ctx.createGain();

    this.reverbNode = this.ctx.createConvolver();
    this.reverbMix = this.ctx.createGain();
    this.generateImpulseResponse();

    this.pannerNode = this.ctx.createStereoPanner();
    this.pannerLfo = this.ctx.createOscillator();
    this.pannerLfo.type = 'sine';
    this.pannerLfo.frequency.value = 0.15;
    this.pannerLfoGain = this.ctx.createGain();
    this.pannerLfo.connect(this.pannerLfoGain);
    this.pannerLfoGain.connect(this.pannerNode.pan);
    this.pannerLfo.start();

    this.compressorNode = this.ctx.createDynamicsCompressor();
    this.volumeNode = this.ctx.createGain();

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;

    this.channelMerger = this.ctx.createChannelMerger(2);

    // Master-bus tap. Kept available for capturing the mix, but deliberately NOT
    // wired into the default output path — see connectMasterOutput().
    this.mediaStreamDestination = this.ctx.createMediaStreamDestination();

    this.audioBridge = new Audio();
    // Deliberately NOT muted: a muted element makes Chrome Android drop the OS
    // media notification, which kills lock-screen / headset controls. The
    // element is kept inaudible by gain instead, never by muting.
    this.audioBridge.muted = false;
    this.audioBridge.volume = BRIDGE_VOLUME;
    this.audioBridge.setAttribute('playsinline', 'true');
    this.audioBridge.preload = 'auto';
    this.audioBridge.loop = true;
    // A silent, self-contained 1 s WAV — deliberately NOT `srcObject = MediaStream`.
    // Many Android Chrome builds refuse to raise a media notification for a
    // MediaStream-sourced element, which is precisely the lock-screen failure
    // this bridge exists to prevent. Because the clip is silent it can never
    // become a second audible output path alongside the Web Audio graph.
    this.audioBridge.src = silentWavDataUri();

    if (typeof document !== 'undefined' && document.body && !this.audioBridge.isConnected) {
      this.audioBridge.style.display = 'none';
      document.body.appendChild(this.audioBridge);
    }

    this.dbPromise = openDB<EchoLabDB>('echolab-projects', 1, {
      upgrade(db) {
        db.createObjectStore('projects', { keyPath: 'id' });
      },
    });

    // Build the static master bus up front so a track-only session (which never
    // calls connectNodes) still reaches the speakers and the MediaStream.
    this.mountStudioFx();

    this.parseHashSettings();
  }

  private parseHashSettings() {
    try {
      const hash = window.location.hash;
      if (hash.startsWith('#settings=')) {
        const base64 = hash.replace('#settings=', '');
        const json = atob(base64);
        const parsed = JSON.parse(json);
        this.applyEffects(parsed);
      }
    } catch (e) {
      console.error("Invalid shareable link settings", e);
    }
  }

  getShareableLink(): string {
    const json = JSON.stringify(this.effects);
    const base64 = btoa(json);
    const url = new URL(window.location.href);
    url.hash = `settings=${base64}`;
    return url.toString();
  }

  resumeContext = async () => {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  async loadBuffer(arrayBuffer: ArrayBuffer, contentType?: string | null) {
    // Reject web pages, JSON and playlists before handing the payload to
    // decodeAudioData, which would otherwise fail with an opaque EncodingError.
    const sniffed = validateAudioPayload(arrayBuffer, contentType);
    if (!sniffed.ok) {
      throw new Error(sniffed.message);
    }

    await this.resumeContext();
    let decodedBuffer: AudioBuffer;
    try {
      decodedBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    } catch (e: any) {
      console.error('decodeAudioData error in loadBuffer:', e);
      throw new Error('Failed to decode audio. Format might be unsupported or corrupt.');
    }
    const processedBuffer = downmixToStereo(decodedBuffer, this.ctx);
    this.setBuffer(processedBuffer);
  }

  async loadUrl(url: string) {
    // Direct fetch first; on CORS failure the Cloudflare Worker proxy relays the
    // stream (Range-aware, so scrubbing still works).
    const response = await fetchAudioWithProxy(url);
    const contentType = response.headers.get('content-type');
    const arrayBuffer = await response.arrayBuffer();
    await this.loadBuffer(arrayBuffer, contentType);
  }

  setBuffer(buffer: AudioBuffer | null, pushToHistory = true) {
    this.buffer = buffer;
    if (buffer && pushToHistory) {
      this.pushHistory(buffer);
    }
    this.stop();
    this.pauseTime = 0;
    this.onStateChange();
  }

  pushHistory(buffer: AudioBuffer) {
    if (this.historyIndex < this.historyStack.length - 1) {
      this.historyStack = this.historyStack.slice(0, this.historyIndex + 1);
    }
    this.historyStack.push(buffer);
    if (this.historyStack.length > this.maxHistory) {
      this.historyStack.shift();
    } else {
      this.historyIndex++;
    }
    this.onStateChange();
  }

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.buffer = this.historyStack[this.historyIndex];
      this.stop();
      this.pauseTime = 0;
      this.onStateChange();
    }
  }

  redo() {
    if (this.historyIndex < this.historyStack.length - 1) {
      this.historyIndex++;
      this.buffer = this.historyStack[this.historyIndex];
      this.stop();
      this.pauseTime = 0;
      this.onStateChange();
    }
  }

  trimBuffer(startSec: number, endSec: number) {
    if (!this.buffer) return;
    const startSample = Math.max(0, Math.floor(startSec * this.buffer.sampleRate));
    const endSample = Math.min(this.buffer.length, Math.floor(endSec * this.buffer.sampleRate));
    if (startSample >= endSample) return;

    const newBuffer = this.ctx.createBuffer(this.buffer.numberOfChannels, endSample - startSample, this.buffer.sampleRate);
    for (let c = 0; c < this.buffer.numberOfChannels; c++) {
      const channelData = this.buffer.getChannelData(c);
      const newChannelData = newBuffer.getChannelData(c);
      newChannelData.set(channelData.subarray(startSample, endSample));
    }
    this.setBuffer(newBuffer);
  }

  reverseBuffer() {
    if (!this.buffer) return;
    const newBuffer = this.ctx.createBuffer(this.buffer.numberOfChannels, this.buffer.length, this.buffer.sampleRate);
    for (let c = 0; c < this.buffer.numberOfChannels; c++) {
      const oldData = this.buffer.getChannelData(c);
      const newData = newBuffer.getChannelData(c);
      for (let i = 0; i < oldData.length; i++) {
        newData[i] = oldData[oldData.length - 1 - i];
      }
    }
    this.setBuffer(newBuffer);
  }

  normalizeBuffer() {
    if (!this.buffer) return;
    let maxAmp = 0;
    for (let c = 0; c < this.buffer.numberOfChannels; c++) {
      const data = this.buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
    }
    if (maxAmp === 0) return;

    const multiplier = 1.0 / maxAmp;
    const newBuffer = this.ctx.createBuffer(this.buffer.numberOfChannels, this.buffer.length, this.buffer.sampleRate);
    for (let c = 0; c < this.buffer.numberOfChannels; c++) {
      const oldData = this.buffer.getChannelData(c);
      const newData = newBuffer.getChannelData(c);
      for (let i = 0; i < oldData.length; i++) {
        newData[i] = oldData[i] * multiplier;
      }
    }
    this.setBuffer(newBuffer);
  }

  setLoopRegion(start: number, end: number) {
    this.loopStart = start;
    this.loopEnd = end;
    this.isLooping = true;
    if (this.source) {
      this.source.loopStart = start;
      this.source.loopEnd = end;
      this.source.loop = true;
    }
  }

  clearLoop() {
    this.isLooping = false;
    if (this.source) {
      this.source.loop = false;
    }
  }

  private generateImpulseResponse() {
    const rate = this.ctx.sampleRate;
    const length = rate * 2.0;
    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);
    for (let i = 0; i < length; i++) {
      const decay = Math.exp(-i / (rate * 0.5));
      left[i] = (Math.random() * 2 - 1) * decay;
      right[i] = (Math.random() * 2 - 1) * decay;
    }
    this.reverbNode.buffer = impulse;
  }

  private makeDistortionCurve(amount: number) {
    const k = amount * 100;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  applyEffects(effects: Partial<AudioEffects>) {
    this.effects = { ...this.effects, ...effects };
    // Transport rate is user-controlled only, and must stay within a finite,
    // positive range: it is read back in the startTime/pauseTime arithmetic and
    // in every seek. Clamping here (the only place `effects` is written) means
    // no caller can push the engine into a racing or stalled transport.
    this.effects.speed = sanitizeSpeed(this.effects.speed);
    this.effects.pitch = sanitizePitch(this.effects.pitch);

    if (this.source) {
      this.source.playbackRate.value = this.effects.speed;
      this.source.detune.value = this.effects.pitch * 100;
    }

    // Smooth ramps avoid the zipper noise / clicks a raw `.value =` write causes
    // when a knob is dragged mid-playback.
    const ramp = (param: AudioParam, value: number) => {
      if (!Number.isFinite(value)) return;
      try {
        param.setTargetAtTime(value, this.ctx.currentTime, 0.02);
      } catch (e) {
        param.value = value;
      }
    };

    ramp(this.highpassNode.frequency, this.effects.highpass);
    ramp(this.lowpassNode.frequency, this.effects.lowpass);
    ramp(this.bassNode.gain, this.effects.bass);
    ramp(this.trebleNode.gain, this.effects.treble);

    (this.effects.eqBands ?? []).forEach((band, i) => {
      if (this.eqNodes[i]) {
        this.eqNodes[i].type = band.type;
        ramp(this.eqNodes[i].frequency, band.freq);
        ramp(this.eqNodes[i].gain, band.gain);
        ramp(this.eqNodes[i].Q, band.q);
      }
    });

    this.distortionNode.curve = this.effects.distortion > 0 ? this.makeDistortionCurve(this.effects.distortion) : null;
    ramp(this.delayNode.delayTime, this.effects.delay / 1000);
    ramp(this.pannerLfoGain.gain, this.effects.pan8D);

    const comp = this.effects.compressor;
    if (comp) {
      ramp(this.compressorNode.threshold, comp.threshold);
      ramp(this.compressorNode.ratio, comp.ratio);
      ramp(this.compressorNode.attack, comp.attack);
      ramp(this.compressorNode.release, comp.release);
      ramp(this.compressorNode.knee, comp.knee);
    }

    ramp(this.volumeNode.gain, this.effects.volume);
    this.onStateChange();
  }

  private connectNodes() {
    if (!this.source) return;

    this.source.disconnect();
    this.highpassNode.disconnect();
    this.lowpassNode.disconnect();
    this.bassNode.disconnect();
    this.trebleNode.disconnect();
    this.eqNodes.forEach(node => node.disconnect());
    this.distortionNode.disconnect();
    this.delayNode.disconnect();
    this.delayMix.disconnect();
    this.reverbNode.disconnect();
    this.reverbMix.disconnect();
    this.pannerNode.disconnect();
    this.compressorNode.disconnect();
    this.volumeNode.disconnect();

    this.source.connect(this.highpassNode);
    this.highpassNode.connect(this.lowpassNode);
    this.lowpassNode.connect(this.bassNode);
    this.bassNode.connect(this.trebleNode);

    let currentLast = this.trebleNode as AudioNode;
    this.eqNodes.forEach(node => {
      currentLast.connect(node);
      currentLast = node;
    });
    currentLast.connect(this.distortionNode);

    const afterDistortion = this.distortionNode;

    afterDistortion.connect(this.pannerNode);

    afterDistortion.connect(this.delayNode);
    this.delayNode.connect(this.delayMix);
    this.delayMix.gain.value = this.effects.delay > 0 ? 0.5 : 0;
    this.delayMix.connect(this.pannerNode);

    afterDistortion.connect(this.reverbNode);
    this.reverbNode.connect(this.reverbMix);
    this.reverbMix.gain.value = this.effects.reverb;
    this.reverbMix.connect(this.pannerNode);

    this.pannerNode.connect(this.compressorNode);

    // The studio FX rack sits post-compressor, pre-analysis, so the visualizer
    // and the exported file both reflect what the user hears.
    this.mountStudioFx();
  }

  /**
   * (Re)build and insert the studio FX rack into the live master chain.
   *
   * This owns the whole static master bus — `compressor → volume → FX rack →
   * analyser → output` — rather than leaving the `compressor → volume` link to
   * `connectNodes()`. A track-only session never calls `connectNodes()`, so
   * without this the bus was never completed: playback was silent and the
   * MediaStream stayed empty, which is why Android showed no notification.
   */
  private mountStudioFx() {
    if (this.studioFxChain) {
      this.studioFxChain.dispose();
      this.studioFxChain = null;
    }
    try {
      this.volumeNode.disconnect();
    } catch (e) {}

    const chain = new StudioFxChain(this.ctx, this.studioFx, true);
    this.volumeNode.connect(chain.input);
    chain.output.connect(this.analyser);

    try {
      this.compressorNode.disconnect(this.volumeNode);
    } catch (e) {}
    this.compressorNode.connect(this.volumeNode);

    this.studioFxChain = chain;
    this.connectMasterOutput();
  }

  /**
   * Route the analyser (the true end of the master bus) to the speakers.
   *
   * Web Audio is the authoritative output path. Audio must NOT also be sent to
   * `mediaStreamDestination` while a media element plays that stream: on Android
   * Chrome the two output clocks drift against each other and the graph is
   * throttled, which is heard as wow/flutter and pitch bending. The keep-alive
   * element instead plays its own silent clip, so there is exactly one audible
   * path (this one) and no feedback loop.
   *
   * `mediaStreamDestination` is retained as a master-bus tap (useful for
   * capturing the mix) but is deliberately left out of the default output path.
   */
  private connectMasterOutput() {
    try {
      this.analyser.disconnect();
    } catch (e) {}
    this.analyser.connect(this.ctx.destination);
  }

  /**
   * Apply studio FX settings. Smooth parameter ramps keep knob moves click-free;
   * bypassing a unit is a mix ramp, never a rewire, so toggles are silent.
   */
  applyStudioFx(next: Partial<StudioFxSettings>) {
    this.studioFx = normalizeStudioFx({
      echo: { ...this.studioFx.echo, ...(next.echo ?? {}) },
      reverb: { ...this.studioFx.reverb, ...(next.reverb ?? {}) },
      saturation: { ...this.studioFx.saturation, ...(next.saturation ?? {}) },
      widener: { ...this.studioFx.widener, ...(next.widener ?? {}) },
      chorus: { ...this.studioFx.chorus, ...(next.chorus ?? {}) },
    });
    if (this.studioFxChain) {
      this.studioFxChain.setSettings(this.studioFx);
    }
    this.onStateChange();
  }


  play() {
    if (!this.buffer && this.tracks.length === 0) return;
    this.resumeContext();

    // Start the silent keep-alive clip inside the user gesture. Web Audio (not
    // this element) is what produces the audible output; the element exists so
    // Android Chrome raises and retains the media notification / lock-screen
    // transport. It must be started from a real user gesture or the browser
    // suspends it and drops the session.
    if (this.audioBridge) {
      const started = this.audioBridge.play();
      if (started && typeof started.catch === 'function') {
        started.catch(e => {
          console.warn('AudioBridge keep-alive play failed:', e);
        });
      }
    }

    const offset = this.pauseTime;

    if (this.buffer) {
      this.source = this.ctx.createBufferSource();
      this.source.buffer = this.buffer;

      if (this.isLooping) {
        this.source.loop = true;
        this.source.loopStart = this.loopStart;
        this.source.loopEnd = this.loopEnd;
      }

      this.source.onended = () => {
        if (this.isPlaying && this.getCurrentTime() >= this.getDuration()) {
          this.isPlaying = false;
          this.pauseTime = 0;
          this.onEnded();
          this.onStateChange();
        }
      };

      this.connectNodes();
      this.applyEffects(this.effects);
      this.source.start(0, offset);
    }

    const hasSolo = this.tracks.some(t => t.solo);
    this.tracks.forEach(track => {
      if (track.sourceNode) {
        try { track.sourceNode.stop(); } catch (e) {}
        track.sourceNode = undefined;
      }

      if (offset >= track.buffer.duration && !this.isLooping) return;

      const sourceNode = this.ctx.createBufferSource();
      sourceNode.buffer = track.buffer;

      const gainNode = this.ctx.createGain();
      gainNode.gain.value = hasSolo
        ? (track.solo && !track.muted ? track.volume : 0)
        : (track.muted ? 0 : track.volume);

      const pannerNode = this.ctx.createStereoPanner();
      pannerNode.pan.value = track.pan;

      sourceNode.connect(gainNode);
      gainNode.connect(pannerNode);
      pannerNode.connect(this.compressorNode);

      track.sourceNode = sourceNode;
      track.gainNode = gainNode;
      track.pannerNode = pannerNode;

      if (this.isLooping) {
        sourceNode.loop = true;
        sourceNode.loopStart = this.loopStart;
        sourceNode.loopEnd = this.loopEnd;
      }

      const trackStartOffset = this.isLooping ? (offset % track.buffer.duration) : offset;
      sourceNode.start(0, trackStartOffset);
    });

    this.startTime = this.ctx.currentTime - (offset / this.effects.speed);
    this.isPlaying = true;
    this.onStateChange();
  }

  pause() {
    if (!this.isPlaying) return;

    if (this.audioBridge) {
      this.audioBridge.pause();
    }
    this.pauseTime = this.getCurrentTime();

    if (this.source) {
      try { this.source.stop(); } catch (e) {}
      this.source = null;
    }

    this.tracks.forEach(track => {
      if (track.sourceNode) {
        try { track.sourceNode.stop(); } catch (e) {}
        track.sourceNode = undefined;
      }
    });

    this.isPlaying = false;
    this.onStateChange();
  }

  stop() {
    if (this.audioBridge) {
      this.audioBridge.pause();
    }

    if (this.source) {
      try { this.source.stop(); } catch (e) {}
      this.source = null;
    }

    this.tracks.forEach(track => {
      if (track.sourceNode) {
        try { track.sourceNode.stop(); } catch (e) {}
        track.sourceNode = undefined;
      }
    });

    this.pauseTime = 0;
    this.isPlaying = false;
    this.onStateChange();
  }

  seek(time: number) {
    if (this.isPlaying) {
      this.pause();
      this.pauseTime = time;
      this.play();
    } else {
      this.pauseTime = time;
    }
  }

  getCurrentTime(): number {
    if (this.isPlaying) {
      return this.pauseTime + (this.ctx.currentTime - this.startTime) * this.effects.speed;
    }
    return this.pauseTime;
  }

  getDuration(): number {
    let maxDur = this.buffer ? this.buffer.duration : 0;
    this.tracks.forEach(t => {
      if (t.buffer.duration > maxDur) maxDur = t.buffer.duration;
    });
    return maxDur;
  }

  getAnalyserData(): Uint8Array {
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    return dataArray;
  }

  getWaveformData(): Uint8Array {
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(dataArray);
    return dataArray;
  }

  getFloatFrequencyData(): Float32Array {
    const dataArray = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(dataArray);
    return dataArray;
  }

  getFloatTimeDomainData(): Float32Array {
    const dataArray = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(dataArray);
    return dataArray;
  }

  addTrack(buffer: AudioBuffer, name: string) {
    const id = Math.random().toString(36).substring(7);
    const track: Track = { id, name, buffer, muted: false, solo: false, volume: 1, pan: 0 };
    this.tracks.push(track);

    if (this.isPlaying) {
      const offset = this.getCurrentTime();
      if (offset < buffer.duration || this.isLooping) {
        const sourceNode = this.ctx.createBufferSource();
        sourceNode.buffer = buffer;

        const gainNode = this.ctx.createGain();
        const hasSolo = this.tracks.some(t => t.solo);
        gainNode.gain.value = hasSolo
          ? (track.solo && !track.muted ? track.volume : 0)
          : (track.muted ? 0 : track.volume);

        const pannerNode = this.ctx.createStereoPanner();
        pannerNode.pan.value = track.pan;

        sourceNode.connect(gainNode);
        gainNode.connect(pannerNode);
        pannerNode.connect(this.compressorNode);

        track.sourceNode = sourceNode;
        track.gainNode = gainNode;
        track.pannerNode = pannerNode;

        if (this.isLooping) {
          sourceNode.loop = true;
          sourceNode.loopStart = this.loopStart;
          sourceNode.loopEnd = this.loopEnd;
        }

        const trackStartOffset = this.isLooping ? (offset % buffer.duration) : offset;
        sourceNode.start(0, trackStartOffset);
      }
    }

    this.rebuildMixer();
    this.onStateChange();
  }

  removeTrack(id: string) {
    const track = this.tracks.find(t => t.id === id);
    if (track && track.sourceNode) {
      try { track.sourceNode.stop(); } catch (e) {}
    }
    this.tracks = this.tracks.filter(t => t.id !== id);
    this.rebuildMixer();
    this.onStateChange();
  }

  setTrackGain(id: string, vol: number) {
    const track = this.tracks.find(t => t.id === id);
    if (track) {
      track.volume = vol;
      if (track.gainNode) track.gainNode.gain.value = track.muted ? 0 : vol;
      this.onStateChange();
    }
  }

  setTrackPan(id: string, pan: number) {
    const track = this.tracks.find(t => t.id === id);
    if (track) {
      track.pan = pan;
      if (track.pannerNode) track.pannerNode.pan.value = pan;
      this.onStateChange();
    }
  }

  muteTrack(id: string) {
    const track = this.tracks.find(t => t.id === id);
    if (track) {
      track.muted = !track.muted;
      this.updateTrackGains();
      this.onStateChange();
    }
  }

  soloTrack(id: string) {
    const track = this.tracks.find(t => t.id === id);
    if (track) {
      track.solo = !track.solo;
      this.updateTrackGains();
      this.onStateChange();
    }
  }

  private updateTrackGains() {
    const hasSolo = this.tracks.some(t => t.solo);
    this.tracks.forEach(track => {
      if (track.gainNode) {
        track.gainNode.gain.value = hasSolo
          ? (track.solo && !track.muted ? track.volume : 0)
          : (track.muted ? 0 : track.volume);
      }
    });
  }

  private rebuildMixer() {}

  async startRecording() {
    try {
      this.recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(this.recordingStream);
      this.recordedChunks = [];
      this.mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) this.recordedChunks.push(e.data);
      };
      this.mediaRecorder.start();
      this.isRecording = true;
      this.onStateChange();
    } catch (e) {
      console.error("Mic access denied", e);
    }
  }

  async stopRecording(): Promise<AudioBuffer | null> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) return resolve(null);
      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        this.isRecording = false;
        if (this.recordingStream) {
          this.recordingStream.getTracks().forEach(t => t.stop());
        }
        const arrayBuffer = await blob.arrayBuffer();
        let buffer: AudioBuffer;
        try {
          const rawBuffer = await this.ctx.decodeAudioData(arrayBuffer);
          buffer = downmixToStereo(rawBuffer, this.ctx);
        } catch (e) {
          console.error('decodeAudioData failed during recording stop:', e);
          this.onStateChange();
          return resolve(null);
        }
        this.onStateChange();
        resolve(buffer);
      };
      this.mediaRecorder.stop();
    });
  }

  async separateStems(buffer: AudioBuffer) {
    const sr = buffer.sampleRate;
    const len = buffer.length;

    const renderStem = async (filterConfig: (ctx: OfflineAudioContext, source: AudioBufferSourceNode) => AudioNode) => {
      const offline = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(buffer.numberOfChannels, len, sr);
      const source = offline.createBufferSource();
      source.buffer = buffer;
      const lastNode = filterConfig(offline, source);
      lastNode.connect(offline.destination);
      source.start();
      return await offline.startRendering();
    };

    const bass = await renderStem((ctx, source) => {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 200;
      source.connect(lp);
      return lp;
    });

    const drums = await renderStem((ctx, source) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2500;
      bp.Q.value = 1;
      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = 5000;
      peak.gain.value = 5;
      source.connect(bp);
      bp.connect(peak);
      return peak;
    });

    const vocals = await renderStem((ctx, source) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500;
      bp.Q.value = 0.5;
      source.connect(bp);
      return bp;
    });

    const other = await renderStem((ctx, source) => {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3500;
      source.connect(hp);
      return hp;
    });

    return { vocals, drums, bass, other };
  }

  analyzeLoudness(buffer: AudioBuffer): LoudnessData {
    let sumSquares = 0;
    let maxAbs = 0;
    let totalSamples = 0;

    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const val = data[i];
        sumSquares += val * val;
        const abs = Math.abs(val);
        if (abs > maxAbs) maxAbs = abs;
      }
      totalSamples += data.length;
    }

    const rms = Math.sqrt(sumSquares / totalSamples);
    const integratedLUFS = (rms > 0) ? 20 * Math.log10(rms) - 0.691 : -70;
    const truePeak = (maxAbs > 0) ? 20 * Math.log10(maxAbs) : -70;
    const dynamicRange = Math.abs(truePeak - integratedLUFS);

    return { integratedLUFS, truePeak, dynamicRange, rms };
  }

  autoMaster(buffer: AudioBuffer): Partial<AudioEffects> {
    const data = this.analyzeLoudness(buffer);
    const suggested: Partial<AudioEffects> = {
      volume: 1.0,
      compressor: { ...this.effects.compressor },
      eqBands: JSON.parse(JSON.stringify(this.effects.eqBands))
    };

    if (data.integratedLUFS < -16) {
      suggested.volume = Math.min(1.5, Math.pow(10, (-14 - data.integratedLUFS) / 20));
    }

    suggested.compressor = {
      threshold: -18,
      ratio: 3,
      attack: 0.003,
      release: 0.25,
      knee: 30
    };

    const highShelf = suggested.eqBands?.find(b => b.type === 'highshelf');
    if (highShelf) {
      highShelf.freq = 10000;
      highShelf.gain = 1.5;
    }

    return suggested;
  }

  detectBPM(_buffer: AudioBuffer): number {
    return 120;
  }

  // ── Time-stretch via OfflineAudioContext resampling trick ─────────────────
  // ── renderOffline: the single source of truth for export ──────────────────
  async renderOffline(): Promise<AudioBuffer> {
    let maxDur = this.buffer ? this.buffer.duration : 0;
    this.tracks.forEach(t => {
      if (t.buffer.duration > maxDur) maxDur = t.buffer.duration;
    });
    if (maxDur === 0) throw new Error("No audio loaded to export");

    const sr    = this.ctx.sampleRate;
    const speed = this.effects.speed > 0 ? this.effects.speed : 1;

    // totalSamples = how long the rendered output will be in samples
    // playbackRate slows/speeds the source but the OfflineAudioContext keeps rendering
    // until its buffer is full — so we size it to the stretched duration
    const stretchedSamples = Math.ceil((maxDur / speed) * sr);
    const fxReverbTail = this.studioFx.reverb.enabled ? this.studioFx.reverb.decay + 0.5 : 0;
    const fxEchoTail = this.studioFx.echo.enabled ? this.studioFx.echo.time * 8 : 0;
    const tailSamples      = (
      (this.effects.reverb > 0 ? 3 : 0) +
      (this.effects.delay > 0 ? 2 : 0) +
      Math.min(fxReverbTail + fxEchoTail, 12)
    ) * sr;
    const totalSamples     = stretchedSamples + Math.ceil(tailSamples);

    const offlineCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(
      2,
      totalSamples,
      sr
    );

    // Rebuild full effects chain in offline context
    const hpNode = offlineCtx.createBiquadFilter();
    hpNode.type = 'highpass';
    hpNode.frequency.value = this.effects.highpass;

    const lpNode = offlineCtx.createBiquadFilter();
    lpNode.type = 'lowpass';
    lpNode.frequency.value = this.effects.lowpass;

    const bassNode = offlineCtx.createBiquadFilter();
    bassNode.type = 'lowshelf';
    bassNode.frequency.value = 200;
    bassNode.gain.value = this.effects.bass;

    const trebleNode = offlineCtx.createBiquadFilter();
    trebleNode.type = 'highshelf';
    trebleNode.frequency.value = 8000;
    trebleNode.gain.value = this.effects.treble;

    const eqNodes: BiquadFilterNode[] = [];
    this.effects.eqBands.forEach((band) => {
      const node = offlineCtx.createBiquadFilter();
      node.type = band.type;
      node.frequency.value = band.freq;
      node.gain.value = band.gain;
      node.Q.value = band.q;
      eqNodes.push(node);
    });

    const distortionNode = offlineCtx.createWaveShaper();
    distortionNode.oversample = '4x';
    distortionNode.curve = this.effects.distortion > 0 ? this.makeDistortionCurve(this.effects.distortion) : null;

    const delayNode = offlineCtx.createDelay(1.0);
    delayNode.delayTime.value = this.effects.delay / 1000;
    const delayMix = offlineCtx.createGain();
    delayMix.gain.value = this.effects.delay > 0 ? 0.5 : 0;

    const reverbNode = offlineCtx.createConvolver();
    reverbNode.buffer = this.reverbNode.buffer;
    const reverbMix = offlineCtx.createGain();
    reverbMix.gain.value = this.effects.reverb;

    const pannerNode = offlineCtx.createStereoPanner();
    const pannerLfo = offlineCtx.createOscillator();
    pannerLfo.type = 'sine';
    pannerLfo.frequency.value = 0.15;
    const pannerLfoGain = offlineCtx.createGain();
    pannerLfoGain.gain.value = this.effects.pan8D;
    pannerLfo.connect(pannerLfoGain);
    pannerLfoGain.connect(pannerNode.pan);
    pannerLfo.start(0);

    const compressorNode = offlineCtx.createDynamicsCompressor();
    compressorNode.threshold.value = this.effects.compressor.threshold;
    compressorNode.ratio.value     = this.effects.compressor.ratio;
    compressorNode.attack.value    = this.effects.compressor.attack;
    compressorNode.release.value   = this.effects.compressor.release;
    compressorNode.knee.value      = this.effects.compressor.knee;

    const volumeNode = offlineCtx.createGain();
    volumeNode.gain.value = this.effects.volume;

    // Wire up master chain
    hpNode.connect(lpNode);
    lpNode.connect(bassNode);
    bassNode.connect(trebleNode);

    let lastMasterNode: AudioNode = trebleNode;
    eqNodes.forEach(node => {
      lastMasterNode.connect(node);
      lastMasterNode = node;
    });
    lastMasterNode.connect(distortionNode);

    distortionNode.connect(pannerNode);

    distortionNode.connect(delayNode);
    delayNode.connect(delayMix);
    delayMix.connect(pannerNode);

    distortionNode.connect(reverbNode);
    reverbNode.connect(reverbMix);
    reverbMix.connect(pannerNode);

    pannerNode.connect(compressorNode);
    compressorNode.connect(volumeNode);

    // Mirror the live master chain: volume → studio FX rack → destination.
    const fxChain = new StudioFxChain(offlineCtx, this.studioFx, false);
    volumeNode.connect(fxChain.input);
    fxChain.output.connect(offlineCtx.destination);

    // Main editor buffer
    if (this.buffer) {
      const source = offlineCtx.createBufferSource();
      source.buffer = this.buffer;
      source.playbackRate.value = speed;
      source.detune.value = this.effects.pitch * 100;
      source.connect(hpNode);
      source.start(0);
    }

    // Multi-track mixer
    const hasSolo = this.tracks.some(t => t.solo);
    this.tracks.forEach(track => {
      const sourceNode = offlineCtx.createBufferSource();
      sourceNode.buffer = track.buffer;

      const gainNode = offlineCtx.createGain();
      gainNode.gain.value = hasSolo
        ? (track.solo && !track.muted ? track.volume : 0)
        : (track.muted ? 0 : track.volume);

      const tPanner = offlineCtx.createStereoPanner();
      tPanner.pan.value = track.pan;

      sourceNode.connect(gainNode);
      gainNode.connect(tPanner);
      tPanner.connect(compressorNode);
      sourceNode.start(0);
    });

    return await offlineCtx.startRendering();
  }

  async exportWAV(): Promise<Blob> {
    const renderedBuffer = await this.renderOffline();
    return audioBufferToWav(renderedBuffer);
  }

  /**
   * Encode an AudioBuffer to MP3 via lamejs.
   *
   * The upstream `lamejs` 1.2.1 package ships a broken CJS build: `Lame.js`
   * references a bare `MPEGMode` global it never requires, so constructing an
   * encoder throws `ReferenceError: MPEGMode is not defined` as soon as the
   * module is bundled for the browser. We use the maintained
   * `@breezystack/lamejs` fork, which ships a correct ESM build.
   */
  exportMP3(buffer: AudioBuffer, sampleRate: number): Blob {
    const channels = Math.min(Math.max(buffer.numberOfChannels, 1), 2);
    // 192 kbps as specified for the export pipeline. MPEG-1 Layer III needs
    // >= 32 kHz; below that the encoder falls back to a valid lower bitrate
    // rather than producing a stream it cannot express.
    const kbps = sampleRate >= 32000 ? 192 : 96;
    const encoder = new Mp3Encoder(channels, sampleRate, kbps);

    const left = buffer.getChannelData(0);
    const right = channels > 1 ? buffer.getChannelData(1) : left;

    const sampleBlockSize = 1152;
    const leftInt16 = new Int16Array(left.length);
    const rightInt16 = new Int16Array(right.length);

    // Clamp before scaling: a sample outside [-1, 1] would otherwise wrap
    // around to the opposite polarity and produce a loud click in the export.
    for (let i = 0; i < left.length; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      leftInt16[i] = l < 0 ? l * 0x8000 : l * 0x7fff;
      rightInt16[i] = r < 0 ? r * 0x8000 : r * 0x7fff;
    }

    const chunks: Uint8Array[] = [];
    for (let i = 0; i < leftInt16.length; i += sampleBlockSize) {
      const leftChunk = leftInt16.subarray(i, i + sampleBlockSize);
      const rightChunk = rightInt16.subarray(i, i + sampleBlockSize);
      const mp3buf = channels > 1
        ? encoder.encodeBuffer(leftChunk, rightChunk)
        : encoder.encodeBuffer(leftChunk);
      if (mp3buf.length > 0) chunks.push(mp3buf);
    }
    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(tail);

    if (chunks.length === 0) {
      throw new Error('MP3 encoder produced no output');
    }
    // Merge into one contiguous buffer: lamejs hands back many small views, and
    // a single ArrayBuffer is both cheaper for the Blob and avoids the
    // ArrayBufferLike variance that `new Blob(chunks)` trips in TS 5.7+.
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return new Blob([merged.buffer], { type: 'audio/mpeg' });
  }

  async saveProject(name: string, playlists: any[] = []) {
    const db = await this.dbPromise;
    const id = Date.now().toString();
    const proj: any = {
      id,
      name,
      savedAt: Date.now(),
      effects: this.effects,
      studioFx: this.studioFx,
      playlists
    };
    if (this.buffer) {
      proj.duration = this.buffer.duration;
    }
    await db.put('projects', proj);
    return id;
  }

  async loadProject(id: string): Promise<any> {
    const db = await this.dbPromise;
    const proj = await db.get('projects', id);
    if (!proj) return null;

    if (proj.effects) {
      this.applyEffects(proj.effects);
    }
    if (proj.studioFx) {
      this.applyStudioFx(proj.studioFx);
    }
    return proj;
  }

  async listProjects() {
    const db = await this.dbPromise;
    const all = await db.getAll('projects');
    return all.map(p => ({ id: p.id, name: p.name, savedAt: p.savedAt, duration: p.duration }));
  }

  async deleteProject(id: string) {
    const db = await this.dbPromise;
    await db.delete('projects', id);
  }

  /**
   * Tear the engine down completely: stop sources, drop the FX rack, detach the
   * hidden bridge element and close the AudioContext. Without this the
   * AudioContext, its oscillators and the MediaStream destination survive every
   * remount, which is a hard leak on hot-reload and in tests.
   */
  dispose() {
    try {
      this.stop();
    } catch (e) {}

    if (this.studioFxChain) {
      this.studioFxChain.dispose();
      this.studioFxChain = null;
    }

    try {
      this.pannerLfo.stop();
    } catch (e) {}

    try {
      this.audioBridge.pause();
      this.audioBridge.srcObject = null;
      this.audioBridge.remove();
    } catch (e) {}

    try {
      this.mediaStreamDestination?.disconnect();
    } catch (e) {}

    try {
      void this.ctx.close();
    } catch (e) {}
  }
}


export function downmixToStereo(buffer: AudioBuffer, ctx: AudioContext): AudioBuffer {
  if (buffer.numberOfChannels <= 2) {
    return buffer;
  }

  const numChannels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const stereoBuffer = ctx.createBuffer(2, length, sampleRate);
  const leftOut = stereoBuffer.getChannelData(0);
  const rightOut = stereoBuffer.getChannelData(1);

  const channelsData: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channelsData.push(buffer.getChannelData(c));
  }

  // Multichannel downmixing strategy:
  // FL (0), FR (1), FC (2), LFE (3), BL/SL (4), BR/SR (5)
  if (numChannels >= 6) {
    for (let i = 0; i < length; i++) {
      const fl = channelsData[0][i];
      const fr = channelsData[1][i];
      const fc = channelsData[2][i];
      const sl = channelsData[4][i];
      const sr = channelsData[5][i];

      leftOut[i] = (fl + fc * 0.7071 + sl * 0.7071) * 0.5;
      rightOut[i] = (fr + fc * 0.7071 + sr * 0.7071) * 0.5;
    }
  } else {
    // Generic N-channel average downmix to stereo
    const scale = 1.0 / Math.sqrt(numChannels);
    for (let i = 0; i < length; i++) {
      let leftSum = 0;
      let rightSum = 0;
      for (let c = 0; c < numChannels; c++) {
        if (c % 2 === 0) leftSum += channelsData[c][i];
        else rightSum += channelsData[c][i];
      }
      leftOut[i] = leftSum * scale;
      rightOut[i] = rightSum * scale;
    }
  }

  return stereoBuffer;
}
