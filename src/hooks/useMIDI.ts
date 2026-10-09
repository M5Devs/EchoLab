import { safeGetItem, safeSetItem } from '../utils/storage';
import { useEffect, useState } from 'react';
import { useAudio } from '../contexts/AudioContext';

type MIDIMapping = Record<number, string>; // cc -> effect key

export function useMIDI() {
  const { engine, updateEffects, togglePlay, stop } = useAudio();
  const [midiSupported, setMidiSupported] = useState(true);
  const [learningCC, setLearningCC] = useState<string | null>(null); // the effect key waiting to be learned
  
  const [mappings, setMappings] = useState<MIDIMapping>(() => {
    const saved = safeGetItem<MIDIMapping | null>('echolab_midi', null);
    return saved ? saved : {
      1: 'speed',
      2: 'reverb',
      3: 'volume',
      7: 'volume',
      74: 'lowpass'
    };
  });

  useEffect(() => {
    safeSetItem('echolab_midi', mappings);
  }, [mappings]);

  useEffect(() => {
    if (!navigator.requestMIDIAccess) {
      setMidiSupported(false);
      return;
    }

    navigator.requestMIDIAccess().then(access => {
      const inputs = access.inputs.values();
      for (let input = inputs.next(); input && !input.done; input = inputs.next()) {
        input.value.onmidimessage = (msg) => {
          if (!msg.data) return;
          const [status, data1, data2] = msg.data;
          
          // CC Message
          if (status >= 176 && status <= 191) {
            const cc = data1;
            const val = data2 / 127; // 0 to 1

            if (learningCC) {
              setMappings(prev => ({ ...prev, [cc]: learningCC }));
              setLearningCC(null);
              return;
            }

            const effectKey = mappings[cc];
            if (effectKey) {
              // Map 0-1 to effect ranges
              let finalVal = val;
              switch (effectKey) {
                case 'speed': finalVal = 0.25 + val * 1.75; break;
                case 'pitch': finalVal = Math.round(-12 + val * 24); break;
                case 'bass': 
                case 'treble': finalVal = Math.round(-10 + val * 20); break;
                case 'lowpass': finalVal = 100 + val * 19900; break;
                case 'highpass': finalVal = 20 + val * 980; break;
                case 'delay': finalVal = val * 100; break;
                case 'volume': finalVal = val * 1.5; break;
              }
              updateEffects({ [effectKey]: finalVal });
            }
          }

          // Note On
          if (status >= 144 && status <= 159 && data2 > 0) {
            if (data1 === 60) togglePlay(); // C4
            if (data1 === 62) stop(); // D4
          }
        };
      }
    }).catch(() => setMidiSupported(false));
  }, [mappings, learningCC, updateEffects, togglePlay, stop]);

  return { midiSupported, mappings, setMappings, learningCC, setLearningCC };
}
