import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { FileChange } from '../shared/types.js';

export const SNAPSHOT_LIMITS = { files: 10000, bytes: 12 * 1024 * 1024, fileBytes: 2 * 1024 * 1024 };
export const SNAPSHOT_IGNORES = new Set(['.git','.lite','node_modules','dist','build','coverage','.next','.venv','venv','__pycache__','target','test-results','playwright-report']);
export interface WorkspaceSnapshot { files: Record<string,string>; omitted: Record<string,string>; truncated: boolean }

/** Bounded source-file observation. Does not follow symlinks, read outside the
 * workspace, or touch generated dependency/cache directories. */
export async function snapshotWorkspace(workspace: string, excluded: string[] = []): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = {files:Object.create(null),omitted:Object.create(null),truncated:false};
  const exclusions = excluded.map(path => resolve(path)).filter(path=>!resolve(workspace).startsWith(path+sep));
  let count = 0, bytes = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path=join(directory,entry.name), key=relative(workspace,path).split(sep).join('/');
      if (exclusions.some(excluded=>path===excluded||path.startsWith(excluded+sep)) || SNAPSHOT_IGNORES.has(entry.name)) continue;
      if (++count > SNAPSHOT_LIMITS.files) {snapshot.truncated=true;return;}
      if(entry.isDirectory()) {await walk(path);if(snapshot.truncated)return;continue;}
      const stat=await lstat(path);
      if(stat.isSymbolicLink()){snapshot.omitted[key]=`symlink:${await readlink(path)}`;continue;}
      if(!stat.isFile()||stat.size>SNAPSHOT_LIMITS.fileBytes) {snapshot.omitted[key]=`${stat.mode}:${stat.size}:${stat.mtimeMs}`;continue;}
      const data=await readFile(path,{flag:constants.O_RDONLY|constants.O_NOFOLLOW}), text=data.toString('utf8');
      if(data.includes(0)||!Buffer.from(text).equals(data)||bytes+data.length>SNAPSHOT_LIMITS.bytes) {
        snapshot.omitted[key]=createHash('sha256').update(data).digest('hex');continue;
      }
      bytes+=data.length;snapshot.files[key]=text;
    }
  }
  await walk(workspace);
  return snapshot;
}

export function snapshotChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot): {changes:FileChange[]; incomplete:boolean} {
  const paths=new Set([...Object.keys(before.files),...Object.keys(after.files)]), changes:FileChange[]=[];
  let incomplete=before.truncated||after.truncated;
  for(const path of new Set([...Object.keys(before.omitted),...Object.keys(after.omitted)])) {
    if(before.omitted[path]!==after.omitted[path]||Object.hasOwn(before.files,path)||Object.hasOwn(after.files,path))incomplete=true;
  }
  for(const path of paths) {
    if(Object.hasOwn(before.omitted,path)||Object.hasOwn(after.omitted,path))continue;
    const old=Object.hasOwn(before.files,path)?before.files[path]:null,next=Object.hasOwn(after.files,path)?after.files[path]:null;
    if(old!==next)changes.push({path,before:old,after:next});
  }
  return {changes,incomplete};
}
