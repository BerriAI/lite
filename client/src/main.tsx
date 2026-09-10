import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { migrateBrowserStorage } from './migrate-storage';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist/wght-italic.css';
import '@fontsource-variable/geist-mono';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="app-loading" style={{ minHeight: '100dvh' }}><h1>Let’s try that again.</h1><p>The workspace view encountered an unexpected error. Your saved sessions are still on the server.</p><button className="button primary" onClick={() => window.location.reload()}>Reload Speedrail</button></div>;
    return this.props.children;
  }
}

try { migrateBrowserStorage(localStorage); } catch { /* Storage may be disabled. */ }
createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
