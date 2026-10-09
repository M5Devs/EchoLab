import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useState } from 'react';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AudioProvider } from '@/contexts/AudioContext';
import { FirebaseProvider } from '@/hooks/useFirebase';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { AuthPanel } from '@/components/AuthPanel';

// Tabs
import Studio from '@/pages/Studio';
import { MultiTrackMixer } from '@/components/MultiTrackMixer';
import { ProVisualizer } from '@/components/ProVisualizer';
import { AILab } from '@/components/AILab';
import { ProjectsPanel } from '@/components/ProjectsPanel';
import Settings from '@/pages/Settings';
import { ExportPanel } from '@/components/ExportPanel';
import NotFound from '@/pages/not-found';
import { Toaster } from 'sonner';
import { Activity, LayoutDashboard, Layers, Mic2, FolderOpen, SlidersHorizontal, Share2 } from 'lucide-react';
import { useAudio } from '@/contexts/AudioContext';

function TopBar() {
  const { isLoaded, bpm, getShareableLink } = useAudio();
  const [copied, setCopied] = useState(false);

  const handleShare = () => {
    navigator.clipboard.writeText(getShareableLink());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <header className="h-14 border-b border-white/5 flex items-center justify-between px-6 bg-black/20 shrink-0">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-gradient-accent flex items-center justify-center shadow-[0_0_10px_rgba(0,212,255,0.4)]">
            <Mic2 className="w-4 h-4 text-black" />
          </div>
          <span className="font-bold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-primary to-secondary">ECHOLAB</span>
          <span className="text-[10px] font-mono bg-white/10 px-1.5 py-0.5 rounded text-muted-foreground ml-1">v3</span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {isLoaded && bpm && (
          <div className="flex items-center gap-2 bg-black/40 px-3 py-1 rounded-full border border-white/5">
            <Activity className="w-3 h-3 text-primary" />
            <span className="text-xs font-mono">{bpm} BPM</span>
          </div>
        )}
        
        <div className="items-center gap-2 text-xs font-mono text-muted-foreground hidden lg:flex">
          <kbd className="px-1.5 bg-white/10 rounded">Space</kbd> Play
        </div>

        <button 
          onClick={handleShare}
          className="flex items-center gap-2 text-xs hover:text-primary transition-colors bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-full"
        >
          <Share2 className="w-3 h-3" />
          {copied ? 'Copied!' : 'Share'}
        </button>

        {/* Firebase auth widget */}
        <AuthPanel />
      </div>
    </header>
  );
}

function MainLayout() {
  const [activeTab, setActiveTab] = useState('studio');
  useKeyboardShortcuts();

  const tabs = [
    { id: 'studio', icon: LayoutDashboard, label: 'Studio' },
    { id: 'mixer', icon: SlidersHorizontal, label: 'Mixer' },
    { id: 'visualizer', icon: Activity, label: 'Visualizer' },
    { id: 'ai', icon: Layers, label: 'AI Lab' },
    { id: 'projects', icon: FolderOpen, label: 'Projects' },
    { id: 'export', icon: Share2, label: 'Export' }
  ];

  return (
    <div className="flex flex-col md:flex-row h-[100dvh] bg-background text-foreground overflow-hidden">
      
      <aside className="hidden md:flex w-20 flex-col items-center py-6 glass-panel border-y-0 border-l-0 rounded-none z-50">
        <nav className="flex flex-col gap-6 flex-1 w-full items-center mt-12">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button 
                key={tab.id} 
                onClick={() => setActiveTab(tab.id)} 
                className="w-full flex justify-center group relative"
                title={tab.label}
              >
                <div className={`p-3 rounded-xl transition-all duration-300 ${isActive ? 'bg-primary/20 text-primary shadow-[0_0_15px_rgba(0,212,255,0.2)]' : 'text-muted-foreground hover:bg-white/10 hover:text-white'}`}>
                  <tab.icon className="w-6 h-6" />
                </div>
                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full shadow-[0_0_10px_rgba(0,212,255,0.8)]" />
                )}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 overflow-hidden relative">
          {activeTab === 'studio' && <Studio />}
          {activeTab === 'mixer' && <div className="p-6 h-full"><MultiTrackMixer /></div>}
          {activeTab === 'visualizer' && <div className="p-6 h-full"><ProVisualizer /></div>}
          {activeTab === 'ai' && <div className="p-6 h-full"><AILab /></div>}
          {activeTab === 'projects' && <div className="p-6 h-full"><ProjectsPanel /></div>}
          {activeTab === 'export' && <div className="p-6 h-full"><ExportPanel /></div>}
        </main>
      </div>
      
      {/* Mobile nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-16 glass-panel border-x-0 border-b-0 rounded-none z-50 flex items-center justify-around px-2 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} className="flex flex-col items-center gap-1 group min-w-[60px]">
              <div className={`p-2 rounded-lg transition-all ${isActive ? 'text-primary' : 'text-muted-foreground'}`}>
                <tab.icon className="w-5 h-5" />
              </div>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/settings" component={Settings} />
      <Route path="/" component={MainLayout} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '')}>
        <FirebaseProvider>
          <AudioProvider>
            <Router />
            <Toaster theme="dark" position="bottom-right" />
          </AudioProvider>
        </FirebaseProvider>
      </WouterRouter>
    </ErrorBoundary>
  );
}

export default App;
