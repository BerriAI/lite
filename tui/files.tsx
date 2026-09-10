/** @jsxImportSource @opentui/react */
import { useEffect, useState } from 'react';
import type { FileEntry } from '../shared/types.js';
import { TerminalController } from './controller.js';
import { Menu, TextPrompt } from './ui.js';

export function FilePicker({ controller, onPick, onClose, initialQuery }: { initialQuery?: string; controller: TerminalController; onPick: (file: FileEntry) => void; onClose: () => void }) {
  const [path, setPath] = useState(''), [entries, setEntries] = useState<FileEntry[]>([]), [error, setError] = useState(''), [searching, setSearching] = useState(false);
  const [results, setResults] = useState<string[] | null>(null);
  const workspace = controller.detail!.session.workspace;
  useEffect(() => { if (initialQuery) { let live = true; controller.client.api<{ files: string[] }>(`/search?workspace=${encodeURIComponent(workspace)}&q=${encodeURIComponent(initialQuery)}`).then(value => { if (live) setResults(value.files); }).catch(error => { if (live) setError(error.message); }); return () => { live = false; }; } }, [initialQuery]);
  useEffect(() => {
    let live = true; setError('');
    controller.client.api<{ entries: FileEntry[] }>(`/files?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}`).then(value => { if (live) setEntries(value.entries); }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [path]);
  if (searching) return <TextPrompt title="Find a workspace file" placeholder="Part of a filename or path" onClose={() => setSearching(false)} onSave={query => { void controller.client.api<{ files: string[] }>(`/search?workspace=${encodeURIComponent(workspace)}&q=${encodeURIComponent(query)}`).then(value => { setResults(value.files); setSearching(false); }).catch(error => setError(error.message)); }} error={error} />;
  if (results) return <Menu title="Matching files" onClose={() => setResults(null)} items={results.map(path => ({ id: path, label: path, action: () => onPick({ name: path.split('/').at(-1)!, path, type: 'file' }) }))} />;
  return <Menu title={path || 'Workspace files'} onClose={onClose} footer={error || 'Select a file to attach a snapshot at send time · Esc cancel'} items={[
    { id: 'search', label: 'Find a file across this workspace…', action: () => setSearching(true) },
    ...(path ? [{ id: 'parent', label: '../', action: () => setPath(path.split('/').slice(0, -1).join('/')) }] : []),
    ...entries.map(entry => ({ id: entry.path, label: `${entry.type === 'directory' ? '▸ ' : ''}${entry.name}`, action: () => entry.type === 'directory' ? setPath(entry.path) : onPick(entry) })),
  ]} />;
}
