import { useState } from 'react';
import { useAudio, toStoredPlaylists } from '../contexts/AudioContext';
import { useFirebase } from '../hooks/useFirebase';
import {
  Download, ArchiveX, FolderOpen, Save, FileArchive,
  Cloud, CloudOff, Loader2, LogIn, RefreshCw, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

function formatDate(val: any): string {
  const ms = val?.seconds ? val.seconds * 1000 : typeof val === 'number' ? val : null;
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString() + ' ' + new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ProjectsPanel() {
  const { projects, saveProject, loadProject, deleteProject, effects, playlists, currentTrack } = useAudio();
  const { user, cloudProjects, cloudLoading, login, saveToCloud, deleteFromCloud, refreshCloudProjects, isOfflineMode } = useFirebase();

  const [newProjectName, setNewProjectName] = useState('');
  const [tab, setTab] = useState<'local' | 'cloud'>('local');
  const [savingCloud, setSavingCloud] = useState(false);

  // ── Local ──────────────────────────────────────────────────────────────────

  const handleSaveLocal = async () => {
    if (!newProjectName.trim()) { toast.error('Enter a project name'); return; }
    await saveProject(newProjectName);
    setNewProjectName('');
    toast.success('Project saved locally');
  };

  const handleLoadLocal = async (id: string) => {
    await loadProject(id);
    toast.success('Project loaded');
  };

  const handleDeleteLocal = async (id: string) => {
    if (!confirm('Delete this project?')) return;
    await deleteProject(id);
  };

  // ── Cloud ──────────────────────────────────────────────────────────────────

  const handleSaveCloud = async () => {
    if (!newProjectName.trim()) { toast.error('Enter a project name'); return; }
    if (!user) { login(); return; }
    setSavingCloud(true);
    await saveToCloud({
      name: newProjectName,
      effects: effects as object,
      // Strip File/cover-art/base64 payloads — Firestore caps documents at 1 MB
      // and the audio itself is in-memory only anyway.
      playlists: toStoredPlaylists(playlists) as unknown as object[],
      metadata: currentTrack ? {
        name: currentTrack.name,
        artist: currentTrack.artist,
        album: currentTrack.album,
        duration: currentTrack.duration,
      } : null,
      duration: currentTrack?.duration,
    });
    setNewProjectName('');
    setSavingCloud(false);
  };

  const handleDeleteCloud = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete from cloud?')) return;
    await deleteFromCloud(id);
  };

  return (
    <div className="h-full flex flex-col gap-4 max-w-5xl mx-auto p-4 overflow-y-auto">

      {/* Save bar */}
      <div className="glass-panel p-5 rounded-xl border border-primary/20 shadow-[0_0_20px_rgba(0,212,255,0.08)]">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Project name..."
            className="flex-1 bg-black/50 border border-white/10 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-primary transition-colors"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (tab === 'local' ? handleSaveLocal() : handleSaveCloud())}
          />
          <button
            onClick={handleSaveLocal}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white font-medium rounded-lg transition-colors flex items-center gap-2 text-sm whitespace-nowrap"
          >
            <Save className="w-4 h-4" /> Save Local
          </button>
          <button
            onClick={handleSaveCloud}
            disabled={savingCloud}
            className="px-4 py-2 bg-primary text-black font-medium rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2 text-sm whitespace-nowrap disabled:opacity-60"
          >
            {savingCloud
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Cloud className="w-4 h-4" />}
            {user ? 'Save to Cloud' : 'Sign in & Save'}
          </button>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-black/30 p-1 rounded-xl w-fit">
        {(['local', 'cloud'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all capitalize flex items-center gap-2 ${
              tab === t
                ? 'bg-primary/20 text-primary shadow-[0_0_10px_rgba(0,212,255,0.15)]'
                : 'text-muted-foreground hover:text-white'
            }`}
          >
            {t === 'cloud' ? <Cloud className="w-3.5 h-3.5" /> : <FolderOpen className="w-3.5 h-3.5" />}
            {t === 'local' ? 'Local' : 'Cloud'}
            {t === 'cloud' && cloudProjects.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 bg-primary/30 rounded-full text-[10px] font-bold text-primary">
                {cloudProjects.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Local projects ───────────────────────────────────────────── */}
      {tab === 'local' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <div
              key={p.id}
              className="glass-panel p-5 rounded-xl flex flex-col gap-4 group hover:border-white/30 transition-colors cursor-pointer"
              onClick={() => handleLoadLocal(p.id)}
            >
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-medium text-lg text-white group-hover:text-primary transition-colors">{p.name}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{formatDate(p.savedAt)}</p>
                </div>
                <div className="p-2 bg-white/5 rounded-lg group-hover:bg-primary/20 transition-colors">
                  <FolderOpen className="w-5 h-5 text-muted-foreground group-hover:text-primary" />
                </div>
              </div>
              <div className="flex justify-between items-center border-t border-white/5 pt-4">
                <span className="text-xs font-mono text-muted-foreground">
                  {p.duration ? `${Math.floor(p.duration / 60)}:${Math.floor(p.duration % 60).toString().padStart(2, '0')}` : '--:--'}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteLocal(p.id); }}
                  className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                >
                  <ArchiveX className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
          {projects.length === 0 && (
            <div className="col-span-full py-20 flex flex-col items-center justify-center text-muted-foreground gap-4 border border-dashed border-white/10 rounded-xl">
              <FileArchive className="w-10 h-10 opacity-50" />
              <p>No local projects yet</p>
            </div>
          )}
        </div>
      )}

      {/* ── Cloud projects ───────────────────────────────────────────── */}
      {tab === 'cloud' && (
        <>
          {isOfflineMode ? (
            <div className="flex-1 py-24 flex flex-col items-center justify-center text-muted-foreground gap-4 border border-dashed border-white/10 rounded-xl">
              <CloudOff className="w-12 h-12 opacity-40" />
              <p className="text-sm">Cloud sync is unavailable</p>
              <p className="text-xs opacity-70 max-w-sm text-center">
                EchoLab is running in local offline mode. Projects, playlists and
                exports are saved on this device and work exactly as normal.
              </p>
            </div>
          ) : !user ? (
            <div className="flex-1 py-24 flex flex-col items-center justify-center text-muted-foreground gap-5 border border-dashed border-white/10 rounded-xl">
              <CloudOff className="w-12 h-12 opacity-40" />
              <p className="text-sm">Sign in to access your cloud projects</p>
              <button
                onClick={login}
                className="flex items-center gap-2 px-6 py-3 bg-primary text-black font-semibold rounded-xl hover:bg-primary/90 transition-colors"
              >
                <LogIn className="w-4 h-4" /> Sign in with Google
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Signed in as <span className="text-white">{user.displayName ?? user.email}</span>
                </p>
                <button
                  onClick={refreshCloudProjects}
                  disabled={cloudLoading}
                  className="p-2 text-muted-foreground hover:text-white transition-colors"
                  title="Refresh"
                >
                  <RefreshCw className={`w-4 h-4 ${cloudLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {cloudLoading && cloudProjects.length === 0 ? (
                <div className="py-20 flex items-center justify-center">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {cloudProjects.map((p) => (
                    <div
                      key={p.id}
                      className="glass-panel p-5 rounded-xl flex flex-col gap-4 group hover:border-primary/30 transition-colors"
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <h3 className="font-medium text-lg text-white group-hover:text-primary transition-colors">{p.name}</h3>
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatDate((p as any).updatedAt)}
                          </p>
                        </div>
                        <Cloud className="w-4 h-4 text-primary opacity-60" />
                      </div>
                      <div className="flex justify-between items-center border-t border-white/5 pt-4">
                        <span className="text-xs font-mono text-muted-foreground">
                          {p.duration ? `${Math.floor(p.duration / 60)}:${Math.floor(p.duration % 60).toString().padStart(2, '0')}` : '--:--'}
                        </span>
                        <button
                          onClick={(e) => handleDeleteCloud(p.id, e)}
                          className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {cloudProjects.length === 0 && (
                    <div className="col-span-full py-20 flex flex-col items-center justify-center text-muted-foreground gap-4 border border-dashed border-white/10 rounded-xl">
                      <Cloud className="w-10 h-10 opacity-40" />
                      <p>No cloud projects yet</p>
                      <p className="text-xs opacity-70">Save your current session above</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
