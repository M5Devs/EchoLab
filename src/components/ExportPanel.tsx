import { useState } from 'react';
import { useAudio } from '../contexts/AudioContext';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export function ExportPanel() {
  const { isLoaded, exportWav, exportMp3, currentTrack } = useAudio();
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav');
  const [isExporting, setIsExporting] = useState(false);

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
    </div>
  );
}
