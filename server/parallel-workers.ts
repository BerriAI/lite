import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, rm, symlink, lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { FileChange } from '../shared/types.js';
import { snapshotWorkspace, snapshotChanges, SNAPSHOT_IGNORES, type WorkspaceSnapshot } from './workspace-snapshot.js';
import { readRestoreTarget, restoreChanges } from './tools.js';
import type { History } from './history.js';

export interface WorkerWorkspace { workspace: string; batch: ParallelWorkers; key: string }
interface Outcome { accepted: boolean; changes: FileChange[]; note: string }

/** One bounded batch. Copy the current workspace, including uncommitted source,
 * then integrate nonconflicting patches only after every worker has stopped.
 * This isolates ordinary relative file operations, not arbitrary hostile code. */
export class ParallelWorkers {
  private inputs = new Map<string,{success:boolean;actorSessionId?:string;invocationId?:string}>();
  private outcomes = new Map<string,Outcome>();
  private ready: Promise<void>;
  private resolveReady!: () => void;
  readonly workspaces = new Map<string,WorkerWorkspace>();
  private constructor(private root:string,private parentId:string,private keys:string[],private baseline:WorkspaceSnapshot,private history:History,private signal:AbortSignal,private directory:string,private isCurrent:()=>boolean) {
    this.ready=new Promise(resolve=>{this.resolveReady=resolve;});
  }
  static async create(root:string,parentId:string,keys:string[],history:History,signal:AbortSignal,isCurrent:()=>boolean=()=>true):Promise<ParallelWorkers> {
    const data=resolve(history.store.directory), baseline=await snapshotWorkspace(root,[data]);
    if(baseline.truncated)throw new Error('This workspace exceeds the parallel snapshot limit. Use one worker or a smaller workspace.');
    const directory=join(data,'workers',randomUUID()),batch=new ParallelWorkers(root,parentId,keys,baseline,history,signal,directory,isCurrent);
    await mkdir(directory,{recursive:true});
    try {
      for(const key of keys) {
        signal.throwIfAborted();const destination=join(directory,randomUUID());
        let copiedBytes=0;
        const copy=async(source:string,target:string):Promise<void>=>{
          signal.throwIfAborted();const path=resolve(source),parts=relative(root,path).split(sep);
          if(path===data||path.startsWith(data+sep)||parts.some(part=>SNAPSHOT_IGNORES.has(part)))return;
          const stat=await lstat(source);copiedBytes+=stat.isFile()?stat.size:0;
          if(copiedBytes>256*1024*1024)throw new Error('This workspace exceeds the 256 MiB parallel copy budget. Choose one worker or a smaller workspace.');
          if(stat.isDirectory()) {await mkdir(target,{recursive:true});for(const entry of await readdir(source))await copy(join(source,entry),join(target,entry));}
          else await cp(source,target,{preserveTimestamps:true,dereference:false,verbatimSymlinks:true});
        };
        await copy(root,destination);
        // Reuse installed packages. They are explicitly outside file history;
        // copied source and test outputs remain local to the worker workspace.
        try {if((await lstat(join(root,'node_modules'))).isDirectory())await symlink(join(root,'node_modules'),join(destination,'node_modules'),'dir');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        const git=promisify(execFile);
        await git('git',['-C',destination,'-c','core.hooksPath=/dev/null','init','-q'],{signal});
        await git('git',['-C',destination,'-c','core.hooksPath=/dev/null','add','-A'],{signal});
        await git('git',['-C',destination,'-c','core.hooksPath=/dev/null','-c','user.name=Lite','-c','user.email=lite@localhost','commit','-qm','Workspace baseline','--allow-empty'],{signal});
        batch.workspaces.set(key,{workspace:destination,batch,key});
      }
      return batch;
    } catch(error) {await rm(directory,{recursive:true,force:true});throw error;}
  }
  async complete(key:string,success:boolean,actorSessionId?:string,invocationId?:string):Promise<Outcome> {
    this.arrive(key,{success,actorSessionId,invocationId});
    await this.ready;return this.outcomes.get(key)!;
  }
  abandon(key:string):void {this.arrive(key,{success:false});}
  private arrive(key:string,input:{success:boolean;actorSessionId?:string;invocationId?:string}) {
    if(this.inputs.has(key))return;
    this.inputs.set(key,input);
    if(this.inputs.size===this.keys.length)void this.integrate().catch(error=>{
      for(const key of this.keys)if(!this.outcomes.has(key))this.outcomes.set(key,{accepted:false,changes:[],note:`Integration needs review: ${error instanceof Error?error.message:String(error)}`});
    }).finally(()=>this.resolveReady());
  }
  private async integrate() {
    const candidates=new Map<string,FileChange[]>();
    for(const key of this.keys) {
      const input=this.inputs.get(key)!;
      if(!input.success||this.signal.aborted||!this.isCurrent()) {this.outcomes.set(key,{accepted:false,changes:[],note:`Isolated changes were not integrated because the worker failed, the task stopped, or new user steering arrived. Review the current request before a fresh assignment. Isolated workspace: ${this.workspaces.get(key)!.workspace}`});continue;}
      const result=snapshotChanges(this.baseline,await snapshotWorkspace(this.workspaces.get(key)!.workspace));
      if(result.incomplete) {this.outcomes.set(key,{accepted:false,changes:[],note:'This assignment changed unsupported binary or large files. Its isolated workspace is retained for review; no patch was integrated.'});continue;}
      candidates.set(key,result.changes.map(change=>({...change,actorSessionId:input.actorSessionId,invocationId:input.invocationId})));
    }
    const ownership=new Map<string,string[]>();
    for(const [key,changes] of candidates)for(const change of changes)ownership.set(change.path,[...(ownership.get(change.path)??[]),key]);
    for(const [key,changes] of candidates) {
      const conflicts=changes.filter(change=>(ownership.get(change.path)?.length??0)>1).map(change=>change.path);
      for(const change of changes)if(await readRestoreTarget(this.root,change.path)!==change.before)conflicts.push(change.path);
      if(conflicts.length) {this.outcomes.set(key,{accepted:false,changes:[],note:`Integration conflict in ${[...new Set(conflicts)].join(', ')}. The root files were preserved. Start a fresh repair assignment against the current workspace. Isolated workspace: ${this.workspaces.get(key)!.workspace}`});continue;}
      const applied:FileChange[]=[];
      try {
        for(const change of changes) {
          this.signal.throwIfAborted();
          if(!this.isCurrent())throw new Error('New user steering arrived; remaining changes were not integrated.');
          // A durable intent precedes each write; interruption uses ordinary
          // root recovery, with no automatic patch or model replay.
          this.history.prepareChange(this.parentId,change);
          await restoreChanges(this.root,[{path:change.path,before:change.after,after:change.before}],()=>{applied.push(change);this.history.commitChange(this.parentId,change);});
        }
        this.outcomes.set(key,{accepted:true,changes:applied,note:`Integrated ${applied.length} file(s). The driver must now verify the combined workspace.`});
      } catch(error) {
        this.outcomes.set(key,{accepted:false,changes:applied,note:`Integration stopped after ${applied.length} file(s): ${error instanceof Error?error.message:String(error)} Inspect the root workspace and recover any pending history before continuing. Isolated workspace: ${this.workspaces.get(key)!.workspace}`});
      }
    }
  }
  async cleanup():Promise<void> {
    await this.ready;
    // Keep failed/conflicting work available for inspection and fresh repairs.
    if([...this.outcomes.values()].every(outcome=>outcome.accepted))await rm(this.directory,{recursive:true,force:true});
  }
}
