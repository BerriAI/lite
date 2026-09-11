import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import type { CliRenderer } from '@opentui/core';
import type { Attachment } from '../shared/types.js';

export async function attachmentFromFile(filename: string, workspace: string): Promise<Attachment> {
  const path = resolve(workspace, filename), info = await stat(path), name = basename(path);
  if (!info.isFile()) throw new Error('Choose a file to attach.');
  if (info.size > 4_400_000) throw new Error('Attachments must be smaller than 4.4 MB.');
  const data = await readFile(path);
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[extname(path).toLowerCase()];
  if (mime) return { name, mimeType: mime, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error('Attach UTF-8 text or a PNG, JPEG, GIF, or WebP image.'); }
  if (content.includes('\0')) throw new Error('This file contains binary data. Attach text or an image.');
  if (content.length > 200_000) throw new Error('Text attachments must be shorter than 200,000 characters. Use a file reference for larger files.');
  return { name, content, mimeType: 'text/plain' };
}

let handoff = false;
export async function withTerminal(renderer: CliRenderer, operation: () => Promise<void>) {
  if (handoff) throw new Error('The terminal is already in use.');
  handoff = true;
  const ignoreInterrupt = () => {};
  process.on('SIGINT', ignoreInterrupt);
  renderer.suspend();
  try { await operation(); }
  finally { process.off('SIGINT', ignoreInterrupt); handoff = false; renderer.resume(); }
}
function child(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`Command exited with ${signal || code}.`)));
  });
}
export async function editDraft(renderer: CliRenderer, text: string, workspace: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'litespeed-draft-')), path = join(directory, 'message.md');
  await writeFile(path, text, { mode: 0o600 });
  let keep = false;
  try {
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    await withTerminal(renderer, () => child(process.env.SHELL || '/bin/sh', ['-c', `${editor} '${path.replace(/'/g, `'\\''`)}'`], workspace));
    const next = await readFile(path, 'utf8');
    if (next.length > 200_000) throw new Error('The edited message exceeds 200,000 characters.');
    return next;
  } catch (error) {
    keep = true;
    throw new Error(`${(error as Error).message} Your editor file is preserved at ${path}.`);
  } finally { if (!keep) await rm(directory, { recursive: true, force: true }); }
}
export async function openShell(renderer: CliRenderer, workspace: string) {
  await withTerminal(renderer, async () => { process.stdout.write('Litespeed shell · type exit to return to your session.\n'); await child(process.env.SHELL || '/bin/sh', ['-i'], workspace); });
}
export function suspendTerminal(renderer: CliRenderer) {
  renderer.suspend();
  process.once('SIGCONT', () => renderer.resume());
  // Stop the foreground job, including the Node launcher. Stopping only
  // Bun leaves the parent running and prevents the shell from regaining control.
  process.kill(0, 'SIGTSTP');
}
