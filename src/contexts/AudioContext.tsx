import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { AudioEngine, AudioEffects, defaultEffects, Track as EngineTrack, LoudnessData } from '../utils/AudioEngine';
import { parseBlob } from 'music-metadata';
import { toast } from 'sonner';

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

type AudioContextType = {
  engine: AudioEngine;
  isPlaying: boolean;
  isLoaded: boolean;
  currentTrack: Track | null;
  effects: AudioEffects;
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

  togglePlay: () => void;
  stop: () => void;
  seek: (time: number) => void;
  loadTrack: (track: Track) => Promise<void>;
  playNextTrack: () => Promise<void>;
  playPreviousTrack: () => Promise<void>;
  updateEffects: (effects: Partial<AudioEffects>) => void;
  updateMetadata: (updates: Partial<Track>) => void;
  exportWav: () => Promise<Blob>;
  exportMp3: () => Blob | null;
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
  const engineRef = useRef<AudioEngine>(new AudioEngine());
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [effects, setEffects] = useState<AudioEffects>(engineRef.current.effects);
  const [playlists, setPlaylists] = useState<Playlist[]>(() => {
    const saved = localStorage.getItem('echolab_playlists');
    return saved ? JSON.parse(saved) : [{ id: 'default', name: 'My Tracks', tracks: [] }];
  });
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>('default');

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

    const currentIndex = activePlaylist.tracks.findIndex(t => t.id === currentTrack.id);
    if (currentIndex === -1) return;

    const nextIndex = (currentIndex + 1) % activePlaylist.tracks.length;
    const nextTrack = activePlaylist.tracks[nextIndex];
    await loadTrack(nextTrack);
  }, [activePlaylistId, currentTrack, playlists, loadTrack]);

  const playPreviousTrack = useCallback(async () => {
    if (!activePlaylistId || !currentTrack) return;
    const activePlaylist = playlists.find(p => p.id === activePlaylistId);
    if (!activePlaylist || activePlaylist.tracks.length === 0) return;

    const currentIndex = activePlaylist.tracks.findIndex(t => t.id === currentTrack.id);
    if (currentIndex === -1) return;

    const prevIndex = (currentIndex - 1 + activePlaylist.tracks.length) % activePlaylist.tracks.length;
    const prevTrack = activePlaylist.tracks[prevIndex];
    await loadTrack(prevTrack);
  }, [activePlaylistId, currentTrack, playlists, loadTrack]);

  useEffect(() => {
    const engine = engineRef.current;

    const handleEnded = () => {
      updateState();

      // Auto play next track if there is an active playlist and we have a next track
      if (activePlaylistId && currentTrack) {
        const activePlaylist = playlists.find(p => p.id === activePlaylistId);
        if (activePlaylist && activePlaylist.tracks.length > 0) {
          const currentIndex = activePlaylist.tracks.findIndex(t => t.id === currentTrack.id);
          if (currentIndex !== -1 && currentIndex < activePlaylist.tracks.length - 1) {
            const nextTrack = activePlaylist.tracks[currentIndex + 1];
            loadTrack(nextTrack);
          }
        }
      }
    };

    engine.onEnded = handleEnded;
    engine.onStateChange = updateState;

    engine.listProjects().then(setProjects);

    return () => {
      engine.stop();
    };
  }, [updateState, activePlaylistId, currentTrack, playlists, loadTrack]);

  useEffect(() => {
    localStorage.setItem('echolab_playlists', JSON.stringify(playlists));
  }, [playlists]);

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

  const updateMetadata = (updates: Partial<Track>) => {
    if (currentTrack) {
      setCurrentTrack({ ...currentTrack, ...updates });
    }
  };

  const exportWav = async () => {
    return engineRef.current.exportWAV();
  };
  
  const exportMp3 = () => {
    const eng = engineRef.current;
    if (!eng.buffer) return null;
    return eng.exportMP3(eng.buffer, eng.buffer.sampleRate);
  };

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
    if (proj?.playlists) {
      setPlaylists(proj.playlists);
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
      isPlaying, isLoaded, currentTrack, effects, playlists, activePlaylistId,
      tracks, isRecording, undoCount, redoCount, projects, loudnessData, bpm,
      togglePlay, stop, seek, loadTrack, playNextTrack, playPreviousTrack, updateEffects, updateMetadata, exportWav, exportMp3,
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
