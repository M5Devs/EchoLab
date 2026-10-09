import { toast } from 'sonner';
import { downmixToStereo } from '../utils/AudioEngine';
import { useAudio } from '../contexts/AudioContext';
import { Slider } from './ui/slider';
import { Mic, Plus, Trash2, Volume2, VolumeX } from 'lucide-react';

export function MultiTrackMixer() {
  const { tracks, setTrackGain, setTrackPan, muteTrack, soloTrack, removeMixerTrack, isRecording, startRecording, stopRecording, engine } = useAudio();

  const handleAddFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const arr = ev.target?.result as ArrayBuffer;
        try {
          const rawBuf = await engine.ctx.decodeAudioData(arr);
          const buf = downmixToStereo(rawBuf, engine.ctx);
          engine.addTrack(buf, file.name);
        } catch (err: any) {
          console.error('MultiTrackMixer audio decode error:', err);
          toast.error('Failed to decode audio. Format might be unsupported or corrupt.');
        }
      };
      reader.readAsArrayBuffer(file);
    }
  };

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex items-center gap-4 bg-black/20 p-3 rounded-xl border border-white/5">
        <label className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm cursor-pointer transition-colors flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Audio File
          <input type="file" accept="audio/*" className="hidden" onChange={handleAddFile} />
        </label>
        
        <button 
          onClick={isRecording ? stopRecording : startRecording}
          className={`px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${isRecording ? 'bg-red-500/20 text-red-400 border border-red-500/50 animate-pulse' : 'bg-white/10 hover:bg-white/20'}`}
        >
          <Mic className="w-4 h-4" /> {isRecording ? 'Recording...' : 'Record Mic'}
        </button>
      </div>

      <div className="flex-1 overflow-x-auto flex gap-4 pb-4 scrollbar-hide">
        {tracks.map(track => (
          <div key={track.id} className="min-w-[140px] w-[140px] flex flex-col bg-black/40 border border-white/10 rounded-xl p-3 gap-4 shrink-0">
            <div className="text-sm font-medium truncate text-center" title={track.name}>{track.name}</div>
            
            <div className="flex gap-2 justify-center">
              <button 
                onClick={() => muteTrack(track.id)}
                className={`w-8 h-8 rounded flex items-center justify-center font-bold text-xs transition-colors ${track.muted ? 'bg-red-500/20 text-red-500 border border-red-500/50' : 'bg-white/5 text-muted-foreground'}`}
              >M</button>
              <button 
                onClick={() => soloTrack(track.id)}
                className={`w-8 h-8 rounded flex items-center justify-center font-bold text-xs transition-colors ${track.solo ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/50' : 'bg-white/5 text-muted-foreground'}`}
              >S</button>
            </div>
            
            <div className="flex-1 flex flex-col items-center justify-end min-h-[150px]">
              <div className="h-full py-2">
                <Slider 
                  orientation="vertical" 
                  min={0} max={1.5} step={0.01} 
                  value={[track.volume]} 
                  onValueChange={([v]) => setTrackGain(track.id, v)} 
                />
              </div>
            </div>
            
            <div className="flex flex-col gap-1 items-center">
              <span className="text-[10px] text-muted-foreground uppercase">Pan</span>
              <Slider 
                min={-1} max={1} step={0.1} 
                value={[track.pan]} 
                onValueChange={([v]) => setTrackPan(track.id, v)} 
              />
            </div>
            
            <button onClick={() => removeMixerTrack(track.id)} className="mt-auto py-1 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 rounded flex justify-center">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}

        {tracks.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-white/10 rounded-xl text-muted-foreground gap-3">
            <VolumeX className="w-8 h-8 opacity-50" />
            <p>No tracks added. Add a file or record to start mixing.</p>
          </div>
        )}

        {/* Master Bus pseudo-lane */}
        <div className="min-w-[140px] w-[140px] flex flex-col bg-primary/5 border border-primary/20 rounded-xl p-3 gap-4 shrink-0 shadow-[0_0_20px_rgba(0,212,255,0.05)]">
          <div className="text-sm font-bold text-primary text-center">MASTER</div>
          <div className="flex-1 flex flex-col items-center justify-end min-h-[150px]">
            <div className="h-full py-2">
              <Slider 
                orientation="vertical" 
                min={0} max={1.5} step={0.01} 
                value={[engine.effects.volume]} 
                onValueChange={([v]) => engine.applyEffects({ volume: v })} 
              />
            </div>
          </div>
          <div className="flex items-center justify-center h-8">
            <Volume2 className="w-5 h-5 text-primary" />
          </div>
        </div>
      </div>
    </div>
  );
}
