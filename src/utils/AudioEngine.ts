import { audioBufferToWav } from './audioBufferToWav';
import lamejs from 'lamejs';
import { openDB, DBSchema, IDBPDatabase } from 'idb';

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
      leftChannel?: Float32Array;
      rightChannel?: Float32Array;
      sampleRate?: number;
      duration?: number;
      effects: AudioEffects;
      playlists: any[];
      tracks?: Array<{
        id: string;
        name: string;
        leftChannel: Float32Array;
        rightChannel: Float32Array;
        sampleRate: number;
        volume: number;
        pan: number;
        muted: boolean;
        solo: boolean;
      }>;
    };
  };
}

export class AudioEngine {
  ctx: AudioContext;
  buffer: AudioBuffer | null = null;
  source: AudioBufferSourceNode | null = null;
  analyser: AnalyserNode;

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

    this.dbPromise = openDB<EchoLabDB>('echolab-projects', 1, {
      upgrade(db) {
        db.createObjectStore('projects', { keyPath: 'id' });
      },
    });

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

  async loadBuffer(arrayBuffer: ArrayBuffer) {
    await this.resumeContext();
    const newBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.setBuffer(newBuffer);
  }

  async loadUrl(url: string) {
    // try direct fetch first, fallback to CORS proxy
    const tryFetch = async (target: string) => {
      const res = await fetch(target);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    };

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await tryFetch(url);
    } catch {
      try {
        arrayBuffer = await tryFetch(`https://corsproxy.io/?${encodeURIComponent(url)}`);
      } catch {
        throw new Error('Could not load audio — the server may not allow cross-origin requests.');
      }
    }
    await this.loadBuffer(arrayBuffer);
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

    if (this.source) {
      this.source.playbackRate.value = this.effects.speed;
      this.source.detune.value = this.effects.pitch * 100;
    }

    this.highpassNode.frequency.value = this.effects.highpass;
    this.lowpassNode.frequency.value = this.effects.lowpass;
    this.bassNode.gain.value = this.effects.bass;
    this.trebleNode.gain.value = this.effects.treble;

    this.effects.eqBands.forEach((band, i) => {
      if (this.eqNodes[i]) {
        this.eqNodes[i].type = band.type;
        this.eqNodes[i].frequency.value = band.freq;
        this.eqNodes[i].gain.value = band.gain;
        this.eqNodes[i].Q.value = band.q;
      }
    });

    this.distortionNode.curve = this.effects.distortion > 0 ? this.makeDistortionCurve(this.effects.distortion) : null;
    this.delayNode.delayTime.value = this.effects.delay / 1000;
    this.pannerLfoGain.gain.value = this.effects.pan8D;

    this.compressorNode.threshold.value = this.effects.compressor.threshold;
    this.compressorNode.ratio.value = this.effects.compressor.ratio;
    this.compressorNode.attack.value = this.effects.compressor.attack;
    this.compressorNode.release.value = this.effects.compressor.release;
    this.compressorNode.knee.value = this.effects.compressor.knee;

    this.volumeNode.gain.value = this.effects.volume;
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
    this.compressorNode.connect(this.volumeNode);
    this.volumeNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  play() {
    if (!this.buffer && this.tracks.length === 0) return;
    this.resumeContext();

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
        const buffer = await this.ctx.decodeAudioData(arrayBuffer);
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
  // playbackRate in OfflineAudioContext changes pitch but NOT duration.
  // Real time-stretching: resample buffer at (sampleRate * speed) → play at
  // original sampleRate → duration becomes originalDuration / speed correctly.
  private async timeStretchBuffer(buffer: AudioBuffer, speed: number): Promise<AudioBuffer> {
    if (Math.abs(speed - 1.0) < 0.001) return buffer;

    const sr           = buffer.sampleRate;
    const stretchedLen = Math.ceil(buffer.length / speed);
    const fakeSr       = Math.round(sr * speed);

    // Copy samples into a buffer tagged with fakeSr — no pitch compensation here
    const fakeBuffer = new OfflineAudioContext(1, 1, fakeSr)
      .createBuffer(buffer.numberOfChannels, buffer.length, fakeSr);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      fakeBuffer.copyToChannel(buffer.getChannelData(c), c);
    }

    // Render at real sr WITH pitch compensation to undo the resampling artifact
    // Then user pitch is applied separately in renderOffline via detune
    const pitchCompCents = -Math.round(Math.log2(speed) * 1200);

    const offCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(
      buffer.numberOfChannels,
      stretchedLen,
      sr
    );
    const src = offCtx.createBufferSource();
    src.buffer        = fakeBuffer;
    src.detune.value  = pitchCompCents; // only compensates resampling, NOT user pitch
    src.connect(offCtx.destination);
    src.start(0);
    return await offCtx.startRendering();
  }

  // ── renderOffline: the single source of truth for export ──────────────────
  async renderOffline(): Promise<AudioBuffer> {
    let maxDur = this.buffer ? this.buffer.duration : 0;
    this.tracks.forEach(t => {
      if (t.buffer.duration > maxDur) maxDur = t.buffer.duration;
    });
    if (maxDur === 0) throw new Error("No audio loaded to export");

    const sr    = this.ctx.sampleRate;
    const speed = this.effects.speed > 0 ? this.effects.speed : 1;

    // Pre-stretch the buffer before feeding to OfflineAudioContext
    const sourceBuffer = this.buffer
      ? await this.timeStretchBuffer(this.buffer, speed)
      : null;

    const stretchedDur = sourceBuffer ? sourceBuffer.duration : maxDur;
    const tail         = (this.effects.reverb > 0 ? 3 : 0) + (this.effects.delay > 0 ? 2 : 0);
    const totalSamples = Math.ceil((stretchedDur + tail) * sr);

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
    volumeNode.connect(offlineCtx.destination);

    // Main editor buffer — already time-stretched, no playbackRate needed
    if (sourceBuffer) {
      const source = offlineCtx.createBufferSource();
      source.buffer = sourceBuffer;
      // timeStretchBuffer already applied pitchCompCents to cancel resampling artifact.
      // We only need to add the user's own pitch on top — no double-counting.
      const pitchCompAlreadyApplied = Math.abs(speed - 1.0) > 0.001
        ? -Math.round(Math.log2(speed) * 1200)
        : 0;
      source.detune.value = (this.effects.pitch * 100) - pitchCompAlreadyApplied;
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

  exportMP3(buffer: AudioBuffer, sampleRate: number): Blob {
    const mp3encoder = new lamejs.Mp3Encoder(buffer.numberOfChannels, sampleRate, 320);
    const mp3Data = [];

    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;

    const sampleBlockSize = 1152;
    const leftInt16 = new Int16Array(left.length);
    const rightInt16 = new Int16Array(right.length);

    for (let i = 0; i < left.length; i++) {
      leftInt16[i] = left[i] < 0 ? left[i] * 0x8000 : left[i] * 0x7FFF;
      rightInt16[i] = right[i] < 0 ? right[i] * 0x8000 : right[i] * 0x7FFF;
    }

    for (let i = 0; i < leftInt16.length; i += sampleBlockSize) {
      const leftChunk = leftInt16.subarray(i, i + sampleBlockSize);
      const rightChunk = rightInt16.subarray(i, i + sampleBlockSize);
      const mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
      if (mp3buf.length > 0) mp3Data.push(mp3buf);
    }
    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) mp3Data.push(mp3buf);

    return new Blob(mp3Data, { type: 'audio/mp3' });
  }

  async saveProject(name: string, playlists: any[] = []) {
    const db = await this.dbPromise;
    const id = Date.now().toString();
    const proj: any = {
      id,
      name,
      savedAt: Date.now(),
      effects: this.effects,
      playlists
    };
    if (this.buffer) {
      proj.leftChannel = this.buffer.getChannelData(0);
      if (this.buffer.numberOfChannels > 1) {
        proj.rightChannel = this.buffer.getChannelData(1);
      }
      proj.sampleRate = this.buffer.sampleRate;
      proj.duration = this.buffer.duration;
    }
    await db.put('projects', proj);
    return id;
  }

  async loadProject(id: string): Promise<any> {
    const db = await this.dbPromise;
    const proj = await db.get('projects', id);
    if (!proj) return null;

    if (proj.leftChannel && proj.sampleRate) {
      const channels = proj.rightChannel ? 2 : 1;
      const buffer = this.ctx.createBuffer(channels, proj.leftChannel.length, proj.sampleRate);
      buffer.copyToChannel(new Float32Array(proj.leftChannel), 0);
      if (proj.rightChannel) {
        buffer.copyToChannel(new Float32Array(proj.rightChannel), 1);
      }
      this.setBuffer(buffer, true);
    } else {
      this.setBuffer(null);
    }
    this.applyEffects(proj.effects);
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
}
