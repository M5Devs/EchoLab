import { useState } from 'react';
import { useAudio } from '../contexts/AudioContext';
import { Link2, Loader2 } from 'lucide-react';

export function URLStream() {
  const { loadTrack } = useAudio();
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    setIsLoading(true);
    setError('');

    try {
      await loadTrack({
        id: Date.now().toString(),
        name: new URL(url).pathname.split('/').pop() || 'Stream',
        url: url
      });
      setUrl('');
    } catch (err) {
      // loadTrack already surfaced a toast; keep the inline hint too.
      setError(err instanceof Error ? err.message : 'Track unavailable or geo-restricted.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="glass-panel rounded-xl p-4">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Link2 className="h-4 w-4 text-muted-foreground" />
          </div>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste direct audio URL..."
            className="w-full bg-black/50 border border-white/10 rounded-lg pl-10 pr-4 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all placeholder:text-muted-foreground/50"
            disabled={isLoading}
          />
        </div>
        <button
          type="submit"
          disabled={!url.trim() || isLoading}
          className="px-4 py-2 bg-white/5 border border-white/10 hover:bg-white/10 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Load'}
        </button>
      </form>
      {error && <p className="text-destructive text-xs mt-2 ml-1">{error}</p>}
    </div>
  );
}
