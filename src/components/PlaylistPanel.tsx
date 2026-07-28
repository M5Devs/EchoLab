import { useState } from 'react';
import { useAudio } from '../contexts/AudioContext';
import { Play, Trash2, GripVertical, ListMusic, Plus, Music, Shuffle, Repeat } from 'lucide-react';

export function PlaylistPanel() {
  const { playlists, activePlaylistId, setActivePlaylist, loadTrack, currentTrack, removeTrackFromPlaylist, reorderPlaylist, createPlaylist, isShuffle, isRepeat, toggleShuffle, toggleRepeat } = useAudio();
  const [isCreating, setIsCreating] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  
  const activePlaylist = playlists.find(p => p.id === activePlaylistId) || playlists[0];

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPlaylistName.trim()) {
      createPlaylist(newPlaylistName.trim());
      setNewPlaylistName('');
      setIsCreating(false);
    }
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.setData('text/plain', index.toString());
  };

  const handleDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    const sourceIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (sourceIndex !== index && activePlaylist) {
      reorderPlaylist(activePlaylist.id, sourceIndex, index);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  if (!activePlaylist) return null;

  return (
    <div className="glass-panel rounded-xl flex flex-col h-full overflow-hidden">
      <div className="p-4 border-b border-white/10 bg-black/20 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-foreground font-medium">
            <ListMusic className="w-5 h-5 text-secondary" />
            <h2>Playlists</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleShuffle}
              className={`p-1.5 rounded-lg transition-all ${isShuffle ? 'bg-primary/20 text-primary shadow-[0_0_10px_rgba(0,212,255,0.15)]' : 'text-muted-foreground hover:text-white'}`}
              title="Shuffle"
            >
              <Shuffle className="w-4 h-4" />
            </button>
            <button
              onClick={toggleRepeat}
              className={`p-1.5 rounded-lg transition-all ${isRepeat ? 'bg-primary/20 text-primary shadow-[0_0_10px_rgba(0,212,255,0.15)]' : 'text-muted-foreground hover:text-white'}`}
              title="Repeat"
            >
              <Repeat className="w-4 h-4" />
            </button>
            <button
              onClick={() => setIsCreating(!isCreating)}
              className="p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
              title="Add Playlist"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
        
        {isCreating && (
          <form onSubmit={handleCreate} className="flex gap-2 animate-in slide-in-from-top-2">
            <input
              type="text"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              placeholder="Playlist name..."
              className="flex-1 bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-secondary transition-colors"
              autoFocus
            />
            <button type="submit" className="px-3 py-1.5 bg-secondary/20 text-secondary hover:bg-secondary/30 rounded-lg text-sm font-medium transition-colors">
              Add
            </button>
          </form>
        )}

        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          {playlists.map(p => (
            <button
              key={p.id}
              onClick={() => setActivePlaylist(p.id)}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                p.id === activePlaylist.id 
                  ? 'bg-secondary text-white' 
                  : 'bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-white'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {activePlaylist.tracks.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground p-4 text-center">
            No tracks in this playlist. Load a track and it will appear here.
          </div>
        ) : (
          <div className="space-y-1">
            {activePlaylist.tracks.map((track, index) => {
              const isActive = currentTrack?.id === track.id;
              
              return (
                <div
                  key={track.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, index)}
                  className={`group flex items-center gap-3 p-2 rounded-lg transition-all ${
                    isActive 
                      ? 'bg-white/10 border border-white/5 shadow-sm' 
                      : 'hover:bg-white/5 border border-transparent'
                  }`}
                >
                  <div className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground p-1">
                    <GripVertical className="w-4 h-4" />
                  </div>
                  
                  <div 
                    className="w-10 h-10 rounded overflow-hidden bg-black/50 shrink-0 cursor-pointer relative group-hover:shadow-md"
                    onClick={() => loadTrack(track)}
                  >
                    {track.coverArt ? (
                      <img src={track.coverArt} alt="" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-black/40">
                        <Music className="w-4 h-4 text-muted-foreground" />
                      </div>
                    )}
                    <div className={`absolute inset-0 flex items-center justify-center bg-black/40 transition-opacity ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                      <Play className={`w-4 h-4 ${isActive ? 'text-primary' : 'text-white'}`} fill={isActive ? "currentColor" : "none"} />
                    </div>
                  </div>
                  
                  <div 
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => loadTrack(track)}
                  >
                    <h4 className={`text-sm font-medium truncate ${isActive ? 'text-primary' : 'text-foreground'}`}>
                      {track.name}
                    </h4>
                    <p className="text-xs text-muted-foreground truncate">
                      {track.artist || 'Unknown Artist'}
                    </p>
                  </div>
                  
                  <button
                    onClick={() => removeTrackFromPlaylist(activePlaylist.id, track.id)}
                    className="p-2 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
