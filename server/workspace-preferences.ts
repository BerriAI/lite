import type { Session } from '../shared/types.js';
import { architectureWorker } from '../shared/architectures.js';
import type { Store } from './store.js';

export type WorkspaceSelection = Pick<Session,'providerId'|'model'|'architecture'|'planner'|'modelReasoning'|'outputStyle'> & { permissionMode?: Session['permissionMode']; setupComplete?: boolean };
export class WorkspacePreferences {
  constructor(private store: Store) {store.db.exec('CREATE TABLE IF NOT EXISTS workspace_preferences (workspace TEXT PRIMARY KEY, data TEXT NOT NULL);');}
  get(workspace: string): Partial<WorkspaceSelection> {
    const row=this.store.db.prepare('SELECT data FROM workspace_preferences WHERE workspace=?').get(workspace) as {data:string}|undefined;
    if(!row)return {};
    const selection=JSON.parse(row.data) as WorkspaceSelection;
    const available=(id:string)=>this.store.settings().providers.some(provider=>provider.id===id);
    if(!available(selection.providerId))return {};
    if(selection.architecture&&!available(architectureWorker(selection.architecture).providerId))delete selection.architecture;
    if(selection.planner&&!available(selection.planner.providerId))delete selection.planner;
    return selection;
  }
  save(workspace: string, selection: WorkspaceSelection) {
    const {providerId,model,architecture,planner,modelReasoning,outputStyle}=selection;
    const permissionMode=selection.permissionMode ?? this.get(workspace).permissionMode;
    const setupComplete=selection.setupComplete ?? this.get(workspace).setupComplete;
    this.store.db.prepare('INSERT INTO workspace_preferences(workspace,data) VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET data=excluded.data').run(workspace,JSON.stringify({providerId,model,architecture,planner,modelReasoning,outputStyle,permissionMode,setupComplete}));
  }
}
