import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { AudioEngine, AudioEffects, Track as EngineTrack, LoudnessData } from '../utils/AudioEngine';
import { StudioFxSettings, normalizeStudioFx } from '../utils/studioFx';
import { parseBlob } from 'music-metadata';
import { toast } from 'sonner';
import { safeLocalStorageGet, safeLocalStorageSet } from '../utils/storage';

export type Track = {
  id: string;
  name: string;
  artist?: string;
  album?: string;
  year?: string;
  coverArt?: string; // base64 or URL
  url?: string; // For streaming
  file?: File; // Local file
  duration?: number;
};

export type Playlist = {
  id: string;
  name: string;
  tracks: Track[];
};

/**
 * What actually reaches localStorage. AudioBuffers, blobs, base64 cover art and
 * waveform peaks stay in memory; only cheap metadata is persisted so a large
 * session can never trip `QuotaExceededError`.
 */
export type StoredPlaylist = {
  id: string;
  name: string;
  duration: number;
  trackCount: number;
  createdAt: number;
};

export function toStoredPlaylists(playlists: Playlist[]): StoredPlaylist[] {
  return playlists.map(playlist => ({
    id: playlist.id,
    name: playlist.name,
    duration: playlist.tracks.reduce((sum, track) => sum + (track.duration || 0), 0),
    trackCount: playlist.tracks.length,
    createdAt: Number(playlist.id) || Date.now(),
  }));
}

export function fromStoredPlaylists(stored: StoredPlaylist[]): Playlist[] {
  return stored.map(item => ({
    id: String(item.id),
    name: String(item.name || 'Untitled Playlist'),
    // Audio lives in memory only — restored playlists start empty by design.
    tracks: [],
  }));
}

type AudioContextType = {
  engine: AudioEngine;
  isPlaying: boolean;
  isLoaded: boolean;
  currentTrack: Track | null;
  effects: AudioEffects;
  studioFx: StudioFxSettings;
  playlists: Playlist[];
  activePlaylistId: string | null;
  
  // Extended state
  tracks: EngineTrack[];
  isRecording: boolean;
  undoCount: number;
  redoCount: number;
  projects: any[];
  loudnessData: LoudnessData | null;
  bpm: number | null;
  isShuffle: boolean;
  isRepeat: boolean;

  togglePlay: () => void;
  stop: () => void;
  seek: (time: number) => void;
  loadTrack: (track: Track) => Promise<void>;
  playNextTrack: () => Promise<void>;
  playPreviousTrack: () => Promise<void>;
  toggleShuffle: () => void;
  toggleRepeat: () => void;
  updateEffects: (effects: Partial<AudioEffects>) => void;
  updateStudioFx: (fx: Partial<StudioFxSettings>) => void;
  updateMetadata: (updates: Partial<Track>) => void;
  exportWav: () => Promise<Blob>;
  exportMp3: () => Promise<Blob | null>;
  createPlaylist: (name: string) => void;
  addTrackToPlaylist: (playlistId: string, track: Track) => void;
  removeTrackFromPlaylist: (playlistId: string, trackId: string) => void;
  reorderPlaylist: (playlistId: string, startIndex: number, endIndex: number) => void;
  setActivePlaylist: (id: string | null) => void;

  // New Actions
  undo: () => void;
  redo: () => void;
  trim: (start: number, end: number) => void;
  reverse: () => void;
  normalize: () => void;
  setLoopRegion: (start: number, end: number) => void;
  clearLoop: () => void;

  addMixerTrack: (buffer: AudioBuffer, name: string) => void;
  removeMixerTrack: (id: string) => void;
  setTrackGain: (id: string, vol: number) => void;
  setTrackPan: (id: string, pan: number) => void;
  muteTrack: (id: string) => void;
  soloTrack: (id: string) => void;

  startRecording: () => Promise<void>;
  stopRecording: () => Promise<AudioBuffer | null>;

  autoMaster: () => void;
  analyzeLoudness: () => void;
  detectBPM: () => void;
  separateStems: () => Promise<any>;

  saveProject: (name: string) => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  listProjects: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  getShareableLink: () => string;
};

const AudioContext = createContext<AudioContextType | null>(null);

export function AudioProvider({ children }: { children: React.ReactNode }) {
  // Lazy initialiser: `useRef(new AudioEngine())` would build a throwaway engine
  // (AudioContext, oscillators, media-stream destination, audio element) on every
  // render, which leaks hard. Construct exactly once per mount.
  const [engine] = useState(() => new AudioEngine());
  const engineRef = useRef<AudioEngine>(engine);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [effects, setEffects] = useState<AudioEffects>(engineRef.current.effects);
  const [studioFx, setStudioFx] = useState<StudioFxSettings>(engineRef.current.studioFx);
  const [playlists, setPlaylists] = useState<Playlist[]>(() => {
    const fallback: Playlist[] = [{ id: 'default', name: 'My Tracks', tracks: [] }];
    const saved = safeLocalStorageGet<StoredPlaylist[]>('echolab_playlists', []);
    if (!Array.isArray(saved) || saved.length === 0) return fallback;
    return fromStoredPlaylists(saved);
  });
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>('default');
  const [isShuffle, setIsShuffle] = useState(false);
  const [isRepeat, setIsRepeat] = useState(false);

  const toggleShuffle = useCallback(() => setIsShuffle(prev => !prev), []);
  const toggleRepeat = useCallback(() => setIsRepeat(prev => !prev), []);

  const [tracks, setTracks] = useState<EngineTrack[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [projects, setProjects] = useState<any[]>([]);
  const [loudnessData, setLoudnessData] = useState<LoudnessData | null>(null);
  const [bpm, setBpm] = useState<number | null>(null);

  const updateState = useCallback(() => {
    const eng = engineRef.current;
    setIsPlaying(eng.isPlaying);
    setIsLoaded(!!eng.buffer);
    setEffects(JSON.parse(JSON.stringify(eng.effects)));
    setStudioFx(normalizeStudioFx(eng.studioFx));
    setTracks([...eng.tracks]);
    setIsRecording(eng.isRecording);
    setUndoCount(eng.historyIndex);
    setRedoCount(eng.historyStack.length - 1 - eng.historyIndex);
  }, []);

  const stop = useCallback(() => {
    engineRef.current.stop();
  }, []);

  const loadTrack = useCallback(async (track: Track) => {
    const engine = engineRef.current;
    setIsLoaded(false);
    stop();
    
    try {
      if (track.file) {
        if (!track.file.arrayBuffer) {
          throw new Error("Local file reference is missing. Please re-upload or select a new track.");
        }
        const arrayBuffer = await track.file.arrayBuffer();
        await engine.loadBuffer(arrayBuffer);
        
        try {
          const metadata = await parseBlob(track.file);
          track.name = metadata.common.title || track.file.name.replace(/\.[^/.]+$/, "");
          track.artist = metadata.common.artist;
          track.album = metadata.common.album;
          track.year = metadata.common.year?.toString();
          
          if (metadata.common.picture && metadata.common.picture.length > 0) {
            const pic = metadata.common.picture[0];
            const base64 = btoa(
              new Uint8Array(pic.data).reduce((data, byte) => data + String.fromCharCode(byte), '')
            );
            track.coverArt = `data:${pic.format};base64,${base64}`;
          }
        } catch (e) {
          console.warn("Metadata parsing failed", e);
        }
      } else if (track.url) {
        await engine.loadUrl(track.url);
      } else {
        throw new Error("Track has no file or URL data to stream.");
      }
      
      track.duration = engine.getDuration();
      const updatedTrack = { ...track };
      setCurrentTrack(updatedTrack);

      // Auto add track to active playlist if not already there
      if (activePlaylistId) {
        setPlaylists(prev => prev.map(p => {
          if (p.id === activePlaylistId) {
            const exists = p.tracks.some(t => t.id === updatedTrack.id || (updatedTrack.name && t.name === updatedTrack.name));
            if (!exists) {
              return { ...p, tracks: [...p.tracks, updatedTrack] };
            }
          }
          return p;
        }));
      }

      engine.play();
    } catch (err: any) {
      console.error("Failed to load track:", err);
      toast.error(err.message || "Failed to load track");
      setIsLoaded(!!engine.buffer);
    }
  }, [activePlaylistId, stop]);

  const playNextTrack = useCallback(async () => {
    if (!activePlaylistId || !currentTrack) return;
    const activePlaylist = playlists.find(p => p.id === activePlaylistId);
    if (!activePlaylist || activePlaylist.tracks.length === 0) return;

    let nextTrack: Track;
    if (isShuffle && activePlaylist.tracks.length > 1) {
      const otherTracks = activePlaylist.tracks.filter(t => t.id !== currentTrack.id);
      nextTrack = otherTracks[Math.floor(Math.random() * otherTracks.length)];
    } else {
      const currentIndex = activePlaylist.tracks.findIndex(t => t.id === currentTrack.id);
      if (currentIndex === -1) return;

      const nextIndex = currentIndex + 1;
      if (nextIndex < activePlaylist.tracks.length) {
        nextTrack = activePlaylist.tracks[nextIndex];
      } else if (isRepeat) {
        nextTrack = activePlaylist.tracks[0];
      } else {
        return;
      }
    }
    await loadTrack(nextTrack);
  }, [activePlaylistId, currentTrack, playlists, isShuffle, isRepeat, loadTrack]);

  const playPreviousTrack = useCallback(async () => {
    if (!activePlaylistId || !currentTrack) return;
    const activePlaylist = playlists.find(p => p.id === activePlaylistId);
    if (!activePlaylist || activePlaylist.tracks.length === 0) return;

    let prevTrack: Track;
    if (isShuffle && activePlaylist.tracks.length > 1) {
      const otherTracks = activePlaylist.tracks.filter(t => t.id !== currentTrack.id);
      prevTrack = otherTracks[Math.floor(Math.random() * otherTracks.length)];
    } else {
      const currentIndex = activePlaylist.tracks.findIndex(t => t.id === currentTrack.id);
      if (currentIndex === -1) return;

      const prevIndex = currentIndex - 1;
      if (prevIndex >= 0) {
        prevTrack = activePlaylist.tracks[prevIndex];
      } else if (isRepeat) {
        prevTrack = activePlaylist.tracks[activePlaylist.tracks.length - 1];
      } else {
        return;
      }
    }
    await loadTrack(prevTrack);
  }, [activePlaylistId, currentTrack, playlists, isShuffle, isRepeat, loadTrack]);

  // The engine's ended/state callbacks are installed exactly once and read the
  // latest context through a ref. They used to live in an effect whose cleanup
  // called `engine.stop()`, so *every* dependency change tore playback down —
  // and each track load commits `currentTrack`/`playlists`, so the effect
  // cleanup fired right after `loadTrack()` started playback and the track
  // silently appeared to load without playing. Nothing here stops the transport;
  // `loadTrack` already stops before loading, and the real unmount is handled by
  // the dispose effect below.
  const endedCtxRef = useRef({
    activePlaylistId, currentTrack, playlists, isShuffle, isRepeat, loadTrack,
  });
  endedCtxRef.current = {
    activePlaylistId, currentTrack, playlists, isShuffle, isRepeat, loadTrack,
  };

  useEffect(() => {
    const engine = engineRef.current;

    const handleEnded = () => {
      updateState();

      // Auto play next track if there is an active playlist and we have a next track
      const {
        activePlaylistId: playlistId,
        currentTrack: track,
        playlists: allPlaylists,
        isShuffle: shuffle,
        isRepeat: repeat,
        loadTrack: load,
      } = endedCtxRef.current;
      if (playlistId && track) {
        const activePlaylist = allPlaylists.find(p => p.id === playlistId);
        if (activePlaylist && activePlaylist.tracks.length > 0) {
          if (shuffle && activePlaylist.tracks.length > 1) {
            const otherTracks = activePlaylist.tracks.filter(t => t.id !== track.id);
            load(otherTracks[Math.floor(Math.random() * otherTracks.length)]);
          } else {
            const currentIndex = activePlaylist.tracks.findIndex(t => t.id === track.id);
            if (currentIndex !== -1) {
              const nextIndex = currentIndex + 1;
              if (nextIndex < activePlaylist.tracks.length) {
                load(activePlaylist.tracks[nextIndex]);
              } else if (repeat) {
                load(activePlaylist.tracks[0]);
              }
            }
          }
        }
      }
    };

    engine.onEnded = handleEnded;
    engine.onStateChange = updateState;

    engine.listProjects().then(setProjects);
  }, [updateState]);

  // Release the AudioContext, oscillators, FX rack and hidden bridge element on
  // real unmount only. Stopping the transport belongs here too: it must happen
  // when the provider goes away, not on every render dependency change.
  useEffect(() => {
    const engine = engineRef.current;
    return () => {
      engine.stop();
      engine.dispose();
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isLoaded || tracks.length > 0) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isLoaded, tracks.length]);

  useEffect(() => {
    safeLocalStorageSet('echolab_playlists', toStoredPlaylists(playlists));
  }, [playlists]);

  // ── Media Session Integration ──────────────────────────────────────────────
  // Drives the Android notification drawer, lock screen and Bluetooth/headset
  // buttons. Web Audio is the audible output; a hidden <audio> element loops a
  // silent clip so Android keeps the media session alive in the background (see
  // AudioEngine.startBridge).

  // Latest track-navigation callbacks, read through refs so the action handlers
  // below can be registered exactly once. Re-registering on every track change
  // (the previous approach) leaves a window where no handler is installed, and a
  // headset button pressed in that window does nothing.
  const mediaNavRef = useRef({ playNextTrack, playPreviousTrack });
  mediaNavRef.current = { playNextTrack, playPreviousTrack };

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    if (currentTrack) {
      // Derive the artwork MIME from the data URI rather than assuming PNG: a
      // JPEG cover declared as image/png is rejected by some lock screens, which
      // then show no artwork at all.
      const coverType = /^data:(image\/[a-z0-9.+-]+)/i.exec(currentTrack.coverArt || '')?.[1];
      const artwork = currentTrack.coverArt
        ? [{ src: currentTrack.coverArt, sizes: '512x512', type: coverType || 'image/png' }]
        : [
            { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          ];

      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrack.name || 'Untitled Track',
          artist: currentTrack.artist || 'EchoLab Studio',
          album: currentTrack.album || 'In-Memory Session',
          artwork,
        });
      } catch (e) {
        console.warn('MediaSession metadata failed:', e);
      }
    } else {
      navigator.mediaSession.metadata = null;
    }
  }, [currentTrack]);

  // Keep playbackState and position in sync; both are polled from the engine
  // because playback can advance without React re-rendering.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const sync = () => {
      const eng = engineRef.current;
      const speed = eng.effects.speed || 1;
      const duration = eng.getDuration() / speed;
      const position = Math.min(eng.getCurrentTime() / speed, duration || 0);

      try {
        navigator.mediaSession.playbackState = eng.isPlaying ? 'playing' : 'paused';
      } catch (e) {
        /* playbackState is read-only on some engines */
      }

      if (
        duration > 0 &&
        Number.isFinite(duration) &&
        Number.isFinite(position) &&
        typeof navigator.mediaSession.setPositionState === 'function'
      ) {
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: speed,
            position: Math.max(0, position),
          });
        } catch (e) {
          /* some browsers reject certain rate/position combinations */
        }
      }
    };

    // Publish once immediately so a play/pause reflects on the lock screen at
    // once, then keep the position fresh on a slow poll (playback advances
    // without React re-rendering, so a timer is the only source of truth).
    sync();
    const interval = window.setInterval(sync, 1000);
    return () => window.clearInterval(interval);
  }, [isPlaying, isLoaded]);

  // Action handlers — these are what headset and lock-screen buttons dispatch.
  // They only ever touch the engine, which is the single source of truth for
  // playback state, so the lock screen and the in-app controls stay in lockstep.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const seekBy = (delta: number) => {
      const eng = engineRef.current;
      const speed = eng.effects.speed || 1;
      const duration = eng.getDuration() / speed;
      const next = Math.min(Math.max(0, eng.getCurrentTime() / speed + delta), duration || 0);
      eng.seek(next * speed);
    };

    const actionHandlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      [
        'play',
        () => {
          engineRef.current.resumeContext().then(() => {
            if (!engineRef.current.isPlaying) engineRef.current.play();
          });
        },
      ],
      [
        'pause',
        () => {
          engineRef.current.pause();
        },
      ],
      [
        'seekto',
        (details) => {
          if (details.seekTime === undefined) return;
          const speed = engineRef.current.effects.speed || 1;
          engineRef.current.seek(details.seekTime * speed);
        },
      ],
      ['seekforward', (details) => seekBy(details.seekOffset ?? 10)],
      ['seekbackward', (details) => seekBy(-(details.seekOffset ?? 10))],
      ['previoustrack', () => { void mediaNavRef.current.playPreviousTrack(); }],
      ['nexttrack', () => { void mediaNavRef.current.playNextTrack(); }],
    ];

    for (const [action, handler] of actionHandlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (e) {
        console.warn(`MediaSession action handler for ${action} not supported`, e);
      }
    }

    return () => {
      for (const [action] of actionHandlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch (e) {}
      }
    };
  }, []);


  const togglePlay = () => {
    const engine = engineRef.current;
    if (engine.isPlaying) {
      engine.pause();
    } else {
      engine.play();
    }
  };

  const seek = (time: number) => {
    engineRef.current.seek(time);
  };

  const updateEffects = (newEffects: Partial<AudioEffects>) => {
    engineRef.current.applyEffects(newEffects);
  };

  const updateStudioFx = (fx: Partial<StudioFxSettings>) => {
    engineRef.current.applyStudioFx(fx);
  };

  const updateMetadata = (updates: Partial<Track>) => {
    if (currentTrack) {
      setCurrentTrack({ ...currentTrack, ...updates });
    }
  };

  const exportWav = async () => {
    return engineRef.current.exportWAV();
  };
  
  const exportMp3 = useCallback(async () => {
    const eng = engineRef.current;
    if (!eng.buffer && eng.tracks.length === 0) return null;
    const renderedBuffer = await eng.renderOffline();
    return eng.exportMP3(renderedBuffer, renderedBuffer.sampleRate);
  }, []);

  const createPlaylist = (name: string) => {
    const newPlaylist: Playlist = {
      id: Date.now().toString(),
      name,
      tracks: []
    };
    setPlaylists([...playlists, newPlaylist]);
  };

  const addTrackToPlaylist = (playlistId: string, track: Track) => {
    setPlaylists(playlists.map(p => p.id === playlistId ? { ...p, tracks: [...p.tracks, track] } : p));
  };

  const removeTrackFromPlaylist = (playlistId: string, trackId: string) => {
    setPlaylists(playlists.map(p => p.id === playlistId ? { ...p, tracks: p.tracks.filter(t => t.id !== trackId) } : p));
  };

  const reorderPlaylist = (playlistId: string, startIndex: number, endIndex: number) => {
    setPlaylists(playlists.map(p => {
      if (p.id === playlistId) {
        const result = Array.from(p.tracks);
        const [removed] = result.splice(startIndex, 1);
        result.splice(endIndex, 0, removed);
        return { ...p, tracks: result };
      }
      return p;
    }));
  };

  const undo = () => engineRef.current.undo();
  const redo = () => engineRef.current.redo();
  const trim = (start: number, end: number) => engineRef.current.trimBuffer(start, end);
  const reverse = () => engineRef.current.reverseBuffer();
  const normalize = () => engineRef.current.normalizeBuffer();
  const setLoopRegion = (s: number, e: number) => engineRef.current.setLoopRegion(s, e);
  const clearLoop = () => engineRef.current.clearLoop();

  const addMixerTrack = (b: AudioBuffer, n: string) => engineRef.current.addTrack(b, n);
  const removeMixerTrack = (id: string) => engineRef.current.removeTrack(id);
  const setTrackGain = (id: string, vol: number) => engineRef.current.setTrackGain(id, vol);
  const setTrackPan = (id: string, pan: number) => engineRef.current.setTrackPan(id, pan);
  const muteTrack = (id: string) => engineRef.current.muteTrack(id);
  const soloTrack = (id: string) => engineRef.current.soloTrack(id);

  const startRecording = () => engineRef.current.startRecording();
  const stopRecording = () => engineRef.current.stopRecording();

  const analyzeLoudness = () => {
    if (engineRef.current.buffer) {
      setLoudnessData(engineRef.current.analyzeLoudness(engineRef.current.buffer));
    }
  };

  const detectBPM = () => {
    if (engineRef.current.buffer) {
      setBpm(engineRef.current.detectBPM(engineRef.current.buffer));
    }
  };

  const autoMaster = () => {
    if (engineRef.current.buffer) {
      const rec = engineRef.current.autoMaster(engineRef.current.buffer);
      updateEffects(rec);
    }
  };

  const separateStems = () => {
    if (!engineRef.current.buffer) return Promise.reject();
    return engineRef.current.separateStems(engineRef.current.buffer);
  };

  const listProjects = async () => {
    const list = await engineRef.current.listProjects();
    setProjects(list);
  };

  const saveProject = async (name: string) => {
    await engineRef.current.saveProject(name, playlists);
    await listProjects();
  };

  const loadProject = async (id: string) => {
    const proj = await engineRef.current.loadProject(id);
    if (proj?.playlists && Array.isArray(proj.playlists)) {
      // Local projects store full playlists; cloud projects store lightweight
      // metadata. Normalise both into the in-memory Playlist shape.
      const restored: Playlist[] = proj.playlists.map((p: any) => ({
        id: String(p.id),
        name: String(p.name || 'Untitled Playlist'),
        tracks: Array.isArray(p.tracks) ? p.tracks : [],
      }));
      setPlaylists(restored.length > 0 ? restored : [{ id: 'default', name: 'My Tracks', tracks: [] }]);
    }
  };

  const deleteProject = async (id: string) => {
    await engineRef.current.deleteProject(id);
    await listProjects();
  };

  const getShareableLink = () => engineRef.current.getShareableLink();

  return (
    <AudioContext.Provider value={{
      engine: engineRef.current,
      isPlaying, isLoaded, currentTrack, effects, studioFx, playlists, activePlaylistId,
      tracks, isRecording, undoCount, redoCount, projects, loudnessData, bpm, isShuffle, isRepeat,
      togglePlay, stop, seek, loadTrack, playNextTrack, playPreviousTrack, toggleShuffle, toggleRepeat, updateEffects, updateStudioFx, updateMetadata, exportWav, exportMp3,
      createPlaylist, addTrackToPlaylist, removeTrackFromPlaylist, reorderPlaylist, setActivePlaylist: setActivePlaylistId,
      undo, redo, trim, reverse, normalize, setLoopRegion, clearLoop,
      addMixerTrack, removeMixerTrack, setTrackGain, setTrackPan, muteTrack, soloTrack,
      startRecording, stopRecording, autoMaster, analyzeLoudness, detectBPM, separateStems,
      saveProject, loadProject, listProjects, deleteProject, getShareableLink
    }}>
      {children}
    </AudioContext.Provider>
  );
}

export function useAudio() {
  const context = useContext(AudioContext);
  if (!context) throw new Error('useAudio must be used within an AudioProvider');
  return context;
}
