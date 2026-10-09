import { useEffect, useState } from 'react';
import { useMIDI } from '../hooks/useMIDI';
import { Monitor, Moon, Share2, Link as LinkIcon, Bug } from 'lucide-react';
import { useAudio } from '../contexts/AudioContext';
import { initEruda } from '../utils/eruda';

export default function Settings() {
  const [theme, setTheme] = useState<'dark' | 'oled'>(() => {
    return document.documentElement.classList.contains('oled') ? 'oled' : 'dark';
  });

  const [debugEruda, setDebugEruda] = useState<boolean>(() => {
    return localStorage.getItem('echolab_debug_eruda') === 'true';
  });
  
  const { midiSupported, mappings, learningCC, setLearningCC, setMappings } = useMIDI();
  const { getShareableLink } = useAudio();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (theme === 'oled') {
      document.documentElement.classList.add('oled');
    } else {
      document.documentElement.classList.remove('oled');
    }
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'oled' : 'dark');

  const toggleDebugEruda = () => {
    const nextVal = !debugEruda;
    setDebugEruda(nextVal);
    localStorage.setItem('echolab_debug_eruda', String(nextVal));
    if (nextVal) {
      initEruda();
    } else {
      window.location.reload();
    }
  };

  const handleCopyLink = () => {
    const link = getShareableLink();
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const effectKeys = ['speed', 'pitch', 'reverb', 'delay', 'lowpass', 'highpass', 'volume', 'bass', 'treble'];

  return (
    <div className="flex-1 h-full overflow-y-auto p-6 space-y-8 max-w-4xl mx-auto">
      
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Settings</h1>
        <p className="text-muted-foreground">Configure your studio environment and hardware.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Appearance */}
        <div className="glass-panel p-6 rounded-xl space-y-4">
          <h2 className="text-xl font-medium border-b border-white/10 pb-2">Appearance</h2>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">OLED Mode</div>
              <div className="text-sm text-muted-foreground">True black background for OLED screens</div>
            </div>
            <button 
              onClick={toggleTheme}
              className={`w-14 h-8 rounded-full p-1 transition-colors ${theme === 'oled' ? 'bg-primary' : 'bg-white/10'}`}
            >
              <div className={`w-6 h-6 rounded-full bg-white transition-transform ${theme === 'oled' ? 'translate-x-6' : 'translate-x-0'} flex items-center justify-center`}>
                {theme === 'oled' ? <Moon className="w-4 h-4 text-black" /> : <Monitor className="w-4 h-4 text-black" />}
              </div>
            </button>
          </div>
        </div>

        {/* Debug Console */}
        <div className="glass-panel p-6 rounded-xl space-y-4">
          <h2 className="text-xl font-medium border-b border-white/10 pb-2">Debugging & Tools</h2>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Mobile Debug Console (Eruda)</div>
              <div className="text-sm text-muted-foreground">Toggle inspector & console for mobile browser testing</div>
            </div>
            <button
              onClick={toggleDebugEruda}
              className={`w-14 h-8 rounded-full p-1 transition-colors ${debugEruda ? 'bg-primary' : 'bg-white/10'}`}
            >
              <div className={`w-6 h-6 rounded-full bg-white transition-transform ${debugEruda ? 'translate-x-6' : 'translate-x-0'} flex items-center justify-center`}>
                <Bug className="w-4 h-4 text-black" />
              </div>
            </button>
          </div>
        </div>

        {/* Shareable Link */}
        <div className="glass-panel p-6 rounded-xl space-y-4 md:col-span-2">
          <h2 className="text-xl font-medium border-b border-white/10 pb-2">Share Preset</h2>
          <p className="text-sm text-muted-foreground">Generate a URL that contains your exact effect chain settings.</p>
          <button 
            onClick={handleCopyLink}
            className="w-full py-3 bg-white/5 border border-white/10 hover:bg-white/10 rounded-lg flex items-center justify-center gap-2 transition-colors"
          >
            {copied ? <span className="text-green-400">Copied to Clipboard!</span> : <><LinkIcon className="w-4 h-4" /> Copy Shareable Link</>}
          </button>
        </div>

        {/* MIDI Mappings */}
        <div className="glass-panel p-6 rounded-xl space-y-4 md:col-span-2">
          <h2 className="text-xl font-medium border-b border-white/10 pb-2 flex items-center justify-between">
            <span>MIDI Control</span>
            <span className={`text-xs px-2 py-1 rounded-full ${midiSupported ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
              {midiSupported ? 'Connected' : 'Not Supported'}
            </span>
          </h2>
          
          {midiSupported ? (
            <>
              <p className="text-sm text-muted-foreground">Click 'Learn' then turn a knob on your MIDI controller to bind it.</p>
              
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
                {effectKeys.map(key => {
                  const mappedCC = Object.entries(mappings).find(([_, v]) => v === key)?.[0];
                  
                  return (
                    <div key={key} className="bg-black/30 p-3 rounded-lg border border-white/5 flex items-center justify-between">
                      <span className="text-sm capitalize">{key}</span>
                      <button 
                        onClick={() => setLearningCC(learningCC === key ? null : key)}
                        className={`text-xs px-3 py-1 rounded transition-colors ${learningCC === key ? 'bg-primary text-black animate-pulse' : mappedCC ? 'bg-white/10 text-white' : 'bg-transparent border border-white/20 text-muted-foreground hover:bg-white/5'}`}
                      >
                        {learningCC === key ? 'Listening...' : mappedCC ? `CC ${mappedCC}` : 'Learn'}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="pt-4 flex justify-end">
                <button onClick={() => setMappings({})} className="text-sm text-red-400 hover:text-red-300">Clear All Bindings</button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Your browser does not support Web MIDI API. Try using Chrome or Edge.</p>
          )}
        </div>

        {/* Keyboard Shortcuts */}
        <div className="glass-panel p-6 rounded-xl space-y-4 md:col-span-2">
          <h2 className="text-xl font-medium border-b border-white/10 pb-2">Keyboard Shortcuts</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-3">
            {[
              { k: 'Space', d: 'Play/Pause' },
              { k: 'S', d: 'Stop' },
              { k: 'L', d: 'Toggle Loop' },
              { k: 'R', d: 'Toggle Recording' },
              { k: 'M', d: 'Mute Master' },
              { k: 'Ctrl + Z', d: 'Undo' },
              { k: 'Ctrl + Shift + Z', d: 'Redo' },
              { k: '← / →', d: 'Seek 5s' },
              { k: '1-7', d: 'Apply Presets' },
            ].map(sc => (
              <div key={sc.k} className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">{sc.d}</span>
                <kbd className="px-2 py-1 bg-white/10 rounded border border-white/5 font-mono text-xs text-white">{sc.k}</kbd>
              </div>
            ))}
          </div>
        </div>

      </div>

    </div>
  );
}
