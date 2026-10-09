import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';

import App from './App';

import './index.css';
import { initEruda } from './utils/eruda';

registerSW({ immediate: true });

initEruda();

createRoot(document.getElementById('root')!).render(<App />);
