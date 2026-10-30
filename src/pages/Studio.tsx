import { AudioVisualizer } from '../components/AudioVisualizer';
import { AudioControls } from '../components/AudioControls';
import { EffectsPanel } from '../components/EffectsPanel';
import { MetadataPanel } from '../components/MetadataPanel';
import { PlaylistPanel } from '../components/PlaylistPanel';
import { AudioUploader } from '../components/AudioUploader';
import { URLStream } from '../components/URLStream';
import { ParametricEQ } from '../components/ParametricEQ';
import { Compressor } from '../components/Compressor';
import { WaveformEditor } from '../components/WaveformEditor';
import { StudioFxRackPanel } from '../components/StudioFxRackPanel';
import { useAudio } from '../contexts/AudioContext';

export default function Studio() {
  const { isLoaded } = useAudio();

  return (
    <div className="flex-1 h-[calc(100dvh-3.5rem)] md:h-[calc(100dvh-3.5rem)] overflow-y-auto overflow-x-hidden p-4 md:p-6 space-y-4 md:space-y-6 pb-20 md:pb-6">
      
      {/* Top Section: Visualizer & Loading */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6 min-h-[250px]">
        <div className="lg:col-span-2">
          <AudioVisualizer />
        </div>
        <div className="flex flex-col gap-4 justify-center">
          <AudioUploader />
          <div className="flex items-center gap-4">
            <div className="h-px bg-white/10 flex-1"></div>
            <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">OR</span>
            <div className="h-px bg-white/10 flex-1"></div>
          </div>
          <URLStream />
        </div>
      </div>

      {/* Main Transport */}
      <AudioControls />
      
      {/* Waveform Editor */}
      <WaveformEditor />

      {/* Main Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        
        {/* Left Col: Metadata & Playlist */}
        <div className="flex flex-col gap-4 md:gap-6 lg:col-span-1">
          <div className="min-h-[200px]">
            <MetadataPanel />
          </div>
          <div className="min-h-[300px]">
            <PlaylistPanel />
          </div>
        </div>

        {/* Right Col: Advanced Effects */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          <EffectsPanel />

          <StudioFxRackPanel />

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="glass-panel p-5 rounded-xl">
              <ParametricEQ />
            </div>
            <div className="glass-panel p-5 rounded-xl">
              <Compressor />
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
