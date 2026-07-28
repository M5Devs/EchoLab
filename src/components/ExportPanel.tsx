import { useState } from 'react';
import { useAudio } from '../contexts/AudioContext';
import { useFirebase } from '../hooks/useFirebase';
import { Download, Loader2, Cloud, CloudOff } from 'lucide-react';
import { toast } from 'sonner';

export function ExportPanel() {
  const { isLoaded, exportWav, exportMp3, currentTrack } = useAudio();
  const { user, uploadAudio, login } = useFirebase();
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav');
  const [isExporting, setIsExporting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [cloudUrl, setCloudUrl] = useState<string | null>(null);

  const getBlob = async (): Promise<Blob | null> => {
    if (format === 'wav') return exportWav();
    const mp3 = await exportMp3();
    return mp3 ?? null;
  };

  const handleExport = async () => {
    if (!isLoaded) return;
    try {
      setIsExporting(true);
      const blob = await getBlob();
      if (!blob) throw new Error('Export failed');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentTrack?.name || 'echolab-master'}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported as ${format.toUpperCase()}`);
    } catch (e) {
      console.error(e);
      toast.error('Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const handleUploadToCloud = async () => {
    if (!isLoaded) return;
    if (!user) { login(); return; }
    try {
      setIsUploading(true);
      const blob = await getBlob();
      if (!blob) throw new Error('Export failed');
      const filename = `${currentTrack?.name || 'echolab-master'}-${Date.now()}.${format}`;
      const url = await uploadAudio(filename, blob);
      if (url) {
        setCloudUrl(url);
        await navigator.clipboard.writeText(url).catch(() => {});
      }
    } catch (e) {
      console.error(e);
      toast.error('Upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="glass-panel p-6 rounded-xl space-y-6 max-w-md mx-auto mt-10">
      <h2 className="text-xl font-medium">Export Master</h2>

      <div className="space-y-4">
        <label className="text-sm text-muted-foreground block">Format</label>
        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={() => setFormat('wav')}
            className={`p-4 rounded-lg border text-center transition-all ${format === 'wav' ? 'bg-primary/20 border-primary text-primary' : 'bg-black/40 border-white/10 text-muted-foreground hover:bg-white/5'}`}
          >
            <div className="font-bold text-lg">WAV</div>
            <div className="text-xs opacity-70 mt-1">Lossless / 16-bit</div>
          </button>
          <button
            onClick={() => setFormat('mp3')}
            className={`p-4 rounded-lg border text-center transition-all ${format === 'mp3' ? 'bg-secondary/20 border-secondary text-secondary' : 'bg-black/40 border-white/10 text-muted-foreground hover:bg-white/5'}`}
          >
            <div className="font-bold text-lg">MP3</div>
            <div className="text-xs opacity-70 mt-1">320 kbps</div>
          </button>
        </div>
      </div>

      {/* Download locally */}
      <button
        onClick={handleExport}
        disabled={!isLoaded || isExporting}
        className="w-full py-4 rounded-xl bg-gradient-accent text-black font-bold flex items-center justify-center gap-2 hover:scale-[1.02] transition-transform shadow-[0_0_20px_rgba(0,212,255,0.4)] disabled:opacity-50 disabled:pointer-events-none"
      >
        {isExporting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
        {isExporting ? 'Rendering Audio…' : `Download ${format.toUpperCase()}`}
      </button>

      {/* Divider */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <div className="flex-1 h-px bg-white/10" />OR<div className="flex-1 h-px bg-white/10" />
      </div>

      {/* Upload to cloud */}
      <button
        onClick={handleUploadToCloud}
        disabled={!isLoaded || isUploading}
        className="w-full py-4 rounded-xl border border-primary/40 bg-primary/5 hover:bg-primary/10 text-primary font-bold flex items-center justify-center gap-2 hover:scale-[1.02] transition-transform disabled:opacity-50 disabled:pointer-events-none"
      >
        {isUploading
          ? <Loader2 className="w-5 h-5 animate-spin" />
          : user ? <Cloud className="w-5 h-5" /> : <CloudOff className="w-5 h-5" />}
        {isUploading ? 'Uploading…' : user ? 'Upload to Cloud' : 'Sign in to Upload'}
      </button>

      {/* Cloud URL result */}
      {cloudUrl && (
        <div className="mt-2 p-3 bg-black/40 border border-primary/20 rounded-lg space-y-1">
          <p className="text-xs text-muted-foreground">Download URL (copied to clipboard):</p>
          <a
            href={cloudUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary break-all hover:underline"
          >
            {cloudUrl}
          </a>
        </div>
      )}
    </div>
  );
}
