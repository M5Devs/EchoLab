import { useAudio } from '../contexts/AudioContext';
import { Slider } from './ui/slider';
import { Switch } from './ui/switch';
import {
  StudioFxSettings,
  REVERB_PRESETS,
  ReverbPreset,
  defaultStudioFx,
} from '../utils/studioFx';
import { RotateCcw, Waves, Mountain, Flame, Maximize2, Radio } from 'lucide-react';
import { ReactNode } from 'react';

interface KnobDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Formats the raw value for the readout. */
  format: (v: number) => string;
}

interface UnitDef {
  id: keyof StudioFxSettings;
  name: string;
  hint: string;
  icon: ReactNode;
  knobs: KnobDef[];
  /** Extra controls rendered under the sliders (mode/preset pickers). */
  extra?: ReactNode;
}

function UnitCard({
  def,
  enabled,
  onToggle,
  children,
}: {
  def: UnitDef;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-4 flex flex-col gap-4 transition-colors ${
        enabled ? 'border-primary/40 bg-primary/[0.04]' : 'border-white/10 bg-black/20'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={enabled ? 'text-primary' : 'text-muted-foreground'}>{def.icon}</span>
          <div className="min-w-0">
            <h3 className={`text-sm font-medium truncate ${enabled ? 'text-white' : 'text-muted-foreground'}`}>
              {def.name}
            </h3>
            <p className="text-[11px] text-muted-foreground/70 truncate">{def.hint}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[10px] font-mono uppercase ${enabled ? 'text-primary' : 'text-muted-foreground/60'}`}>
            {enabled ? 'On' : 'Bypass'}
          </span>
          <Switch checked={enabled} onCheckedChange={onToggle} aria-label={`Toggle ${def.name}`} />
        </div>
      </div>
      {def.extra}
      <div className={`space-y-4 ${enabled ? '' : 'opacity-50 pointer-events-none'}`}>{children}</div>
    </div>
  );
}

function Knob({ knob, value, onChange }: { knob: KnobDef; value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-2 group">
      <div className="flex justify-between items-center text-xs">
        <span className="text-muted-foreground group-hover:text-white/80 transition-colors">{knob.label}</span>
        <span className="font-mono text-[11px] text-muted-foreground bg-black/50 px-1.5 py-0.5 rounded border border-white/5">
          {knob.format(value)}
        </span>
      </div>
      <Slider
        min={knob.min}
        max={knob.max}
        step={knob.step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}

const ms = (v: number) => `${Math.round(v * 1000)} ms`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => `${v.toFixed(2)} s`;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

export function StudioFxRackPanel() {
  const { studioFx, updateStudioFx } = useAudio();

  const set = <K extends keyof StudioFxSettings>(unit: K, patch: Partial<StudioFxSettings[K]>) =>
    updateStudioFx({ [unit]: { ...studioFx[unit], ...patch } } as Partial<StudioFxSettings>);

  const units: UnitDef[] = [
    {
      id: 'echo',
      name: 'Echo / Tape Delay',
      hint: 'Damped feedback repeats',
      icon: <Radio className="w-4 h-4" />,
      knobs: [
        { key: 'time', label: 'Time', min: 0.02, max: 1.5, step: 0.01, format: ms },
        { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, format: pct },
        { key: 'tone', label: 'Tone (high-cut)', min: 800, max: 8000, step: 50, format: hz },
        { key: 'mix', label: 'Dry / Wet', min: 0, max: 1, step: 0.01, format: pct },
      ],
      extra: (
        <div className="flex gap-1.5">
          {(['tape', 'digital'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => set('echo', { mode })}
              className={`px-2.5 py-1 rounded-md text-[11px] capitalize transition-colors ${
                studioFx.echo.mode === mode
                  ? 'bg-primary/20 text-primary border border-primary/40'
                  : 'bg-white/5 text-muted-foreground border border-white/10 hover:text-white'
              }`}
            >
              {mode === 'tape' ? 'Tape' : 'Digital'}
            </button>
          ))}
        </div>
      ),
    },
    {
      id: 'reverb',
      name: 'Reverb',
      hint: 'Synthetic impulse response',
      icon: <Mountain className="w-4 h-4" />,
      knobs: [
        { key: 'decay', label: 'Decay Time', min: 0.5, max: 5, step: 0.1, format: secs },
        { key: 'preDelay', label: 'Pre-Delay', min: 0, max: 0.2, step: 0.005, format: ms },
        { key: 'damping', label: 'High Damping', min: 0, max: 1, step: 0.01, format: pct },
        { key: 'mix', label: 'Dry / Wet', min: 0, max: 1, step: 0.01, format: pct },
      ],
      extra: (
        <div className="flex gap-1.5 flex-wrap">
          {(Object.keys(REVERB_PRESETS) as ReverbPreset[]).map(preset => (
            <button
              key={preset}
              onClick={() => {
                const p = REVERB_PRESETS[preset];
                set('reverb', { preset, decay: p.decay, preDelay: p.preDelay, damping: p.damping });
              }}
              className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                studioFx.reverb.preset === preset
                  ? 'bg-primary/20 text-primary border border-primary/40'
                  : 'bg-white/5 text-muted-foreground border border-white/10 hover:text-white'
              }`}
            >
              {REVERB_PRESETS[preset].label}
            </button>
          ))}
        </div>
      ),
    },
    {
      id: 'saturation',
      name: 'Analog Saturation',
      hint: 'Tube & tape harmonics',
      icon: <Flame className="w-4 h-4" />,
      knobs: [
        { key: 'drive', label: 'Drive', min: 0, max: 100, step: 1, format: v => `${Math.round(v)}` },
        { key: 'outputGain', label: 'Output Gain', min: -12, max: 12, step: 0.5, format: db },
      ],
      extra: (
        <div className="flex gap-1.5">
          {(['tape', 'overdrive'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => set('saturation', { mode })}
              className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                studioFx.saturation.mode === mode
                  ? 'bg-primary/20 text-primary border border-primary/40'
                  : 'bg-white/5 text-muted-foreground border border-white/10 hover:text-white'
              }`}
            >
              {mode === 'tape' ? 'Tape Warmth' : 'Overdrive'}
            </button>
          ))}
        </div>
      ),
    },
    {
      id: 'widener',
      name: 'Stereo Widener',
      hint: 'Haas effect + mid/side',
      icon: <Maximize2 className="w-4 h-4" />,
      knobs: [
        { key: 'width', label: 'Width', min: 0, max: 2, step: 0.05, format: v => `${Math.round(v * 100)}%` },
        { key: 'delayMs', label: 'Haas Delay', min: 5, max: 25, step: 0.5, format: v => `${v.toFixed(1)} ms` },
      ],
    },
    {
      id: 'chorus',
      name: 'Chorus',
      hint: 'Vocal doubling modulation',
      icon: <Waves className="w-4 h-4" />,
      knobs: [
        { key: 'rate', label: 'Rate', min: 0.1, max: 4, step: 0.05, format: v => `${v.toFixed(2)} Hz` },
        { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, format: pct },
        { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, format: pct },
      ],
    },
  ];

  return (
    <div className="glass-panel rounded-xl flex flex-col overflow-hidden">
      <div className="p-4 border-b border-white/10 flex items-center justify-between bg-black/20">
        <div className="flex items-center gap-2 text-foreground font-medium">
          <Waves className="w-5 h-5 text-primary" />
          <h2>Studio FX Rack</h2>
          <span className="text-[10px] font-mono bg-white/10 px-1.5 py-0.5 rounded text-muted-foreground">
            real-time
          </span>
        </div>
        <button
          onClick={() => updateStudioFx(defaultStudioFx)}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-muted-foreground hover:text-white transition-all"
          title="Reset the FX rack"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Reset Rack
        </button>
      </div>

      <div className="p-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
        {units.map(def => (
          <UnitCard
            key={def.id}
            def={def}
            enabled={studioFx[def.id].enabled}
            onToggle={next => set(def.id, { enabled: next } as never)}
          >
            {def.knobs.map(knob => (
              <Knob
                key={knob.key}
                knob={knob}
                value={(studioFx[def.id] as unknown as Record<string, number>)[knob.key]}
                onChange={v => set(def.id, { [knob.key]: v } as never)}
              />
            ))}
          </UnitCard>
        ))}
      </div>
    </div>
  );
}
