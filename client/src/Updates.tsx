import { useEffect, useState } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';
import type { UpdateStatus } from '../../shared/updates';
import { api, post } from './api';

export function Updates() {
  const [status, setStatus] = useState<UpdateStatus>(), [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const check = () => { void api<UpdateStatus>('/updates').then(value => { if (live) setStatus(value); }).catch(() => {}); };
    check(); const timer = setInterval(check, 3600000); window.addEventListener('focus', check);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', check); };
  }, []);
  async function action(kind: 'check' | 'install' | 'restart') {
    setBusy(kind); setError('');
    try {
      if (kind === 'restart') {
        const target = await post<{version:string}>('/updates/restart', {});
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          await new Promise(done => setTimeout(done, 500));
          try { const health = await api<{version:string}>('/health'); if (health.version === target.version) { window.location.reload(); return; } } catch { /* A restart temporarily closes the connection. */ }
        }
        throw new Error('The server is taking longer to restart. Reload this page to reconnect.');
      }
      const next = kind === 'install' ? await post<UpdateStatus>('/updates/install', {}) : await api<UpdateStatus>('/updates?check=true');
      setStatus(next); if (kind === 'check' && next.error) setError(next.error);
    } catch (error) { setError(error instanceof Error ? error.message : 'The update could not finish.'); }
    finally { setBusy(''); }
  }
  if (!status) return null;
  const available = status.available || status.restartRequired;
  return <div className="updates"><button className="sidebar-footer-button" onClick={() => setOpen(value => !value)}><Download size={15} /><span>{status.restartRequired ? 'Restart to update' : available ? `Update to ${status.latestVersion}` : 'Updates'}</span>{available && <span className="update-dot" />}</button>
    {open && <div className="update-details" role="region" aria-label="Speedrail updates"><div className="update-heading"><strong>Speedrail {status.currentVersion}</strong><button className="icon-button" aria-label="Close updates" onClick={() => setOpen(false)}><X size={14} /></button></div>
      <p>{status.restartRequired ? `${status.installedVersion} is installed. Restart when your tasks and workspace terminals are finished.` : status.available ? `${status.latestVersion} is available.` : status.error && !status.latestVersion ? 'Could not check for updates. Keep working and try again later.' : status.checkedAt ? 'You have the latest checked version.' : 'Check for a newer version of Speedrail.'}</p>
      {busy && <p role="status">{busy === 'install' ? 'Downloading and checking the update…' : busy === 'restart' ? 'Restarting Speedrail…' : 'Checking for updates…'}</p>}
      {error && <p role="alert">{error}</p>}
      {available && !status.packaged && <p>Install the macOS package for automatic updates, or update your source checkout and rebuild.</p>}
      <div className="update-actions">{status.packaged && (status.restartRequired ? <button className="button primary" disabled={Boolean(busy)} onClick={() => void action('restart')}>Restart</button> : status.available ? <button className="button primary" disabled={Boolean(busy)} onClick={() => void action('install')}>Install update</button> : null)}<button className="button" disabled={Boolean(busy)} onClick={() => void action('check')}><RefreshCw size={13} />Check</button><a href={status.releaseUrl} target="_blank" rel="noreferrer">Release notes</a></div>
    </div>}
  </div>;
}
