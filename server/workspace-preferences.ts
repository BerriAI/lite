import type { Session } from '../shared/types.js';
import { architectureWorker } from '../shared/architectures.js';
import type { Store } from './store.js';

export type WorkspaceSelection = Pick<Session,'providerId'|'model'|'shunt'|'architecture'|'planner'|'modelReasoning'|'outputStyle'> & { permissionMode?: Session['permissionMode']; setupComplete?: boolean };
export class WorkspacePreferences {
  constructor(private store: Store) {store.db.exec('CREATE TABLE IF NOT EXISTS workspace_preferences (workspace TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS model_defaults (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);');}
  get(workspace: string): Partial<WorkspaceSelection> {
    const row=this.store.db.prepare('SELECT data FROM workspace_preferences WHERE workspace=?').get(workspace) as {data:string}|undefined;
    const global=this.store.db.prepare('SELECT data FROM model_defaults WHERE id=1').get() as {data:string}|undefined;
    if(!row&&!global)return {};
    const selection={...(row?JSON.parse(row.data):{}),...(global?JSON.parse(global.data):{})} as WorkspaceSelection;
    for(const key of ['shunt','architecture','planner','modelReasoning','outputStyle'] as const)if(selection[key]===null)delete selection[key];
    const available=(id:string)=>this.store.settings().providers.some(provider=>provider.id===id);
    if(!available(selection.providerId))return {};
    if(selection.architecture&&!available(architectureWorker(selection.architecture).providerId))delete selection.architecture;
    if(selection.planner&&!available(selection.planner.providerId))delete selection.planner;
    return selection;
  }
  save(workspace: string, selection: WorkspaceSelection, rememberModels = false) {
    const {providerId,model,shunt,architecture,planner,modelReasoning,outputStyle}=selection;
    const permissionMode=selection.permissionMode ?? this.get(workspace).permissionMode;
    const setupComplete=selection.setupComplete ?? this.get(workspace).setupComplete;
    this.store.db.prepare('INSERT INTO workspace_preferences(workspace,data) VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET data=excluded.data').run(workspace,JSON.stringify({providerId,model,shunt,architecture,planner,modelReasoning,outputStyle,permissionMode,setupComplete}));
    if(rememberModels&&model.trim()){
      this.store.db.prepare('INSERT INTO model_defaults(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify({providerId,model,shunt:shunt??null,architecture:architecture??null,planner:planner??null,modelReasoning:modelReasoning??null,outputStyle:outputStyle??null}));
      this.store.saveSettings({defaultProvider:providerId,defaultModel:model});
    }
  }
}
