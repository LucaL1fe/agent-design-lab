import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/500.css';
import './styles/app.css';
import { createRoot } from 'react-dom/client';
import { App } from './chrome/App.tsx';
import { initConnection, loadWorkspace } from './state/app.ts';

initConnection();
void loadWorkspace();
createRoot(document.getElementById('root')!).render(<App />);
