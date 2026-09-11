import { test as base, expect } from '@playwright/test';
export * from '@playwright/test';

export const test=base.extend<{savedModelDefaults:void}>({
  savedModelDefaults:[async({request},use)=>{
    const settings=await(await request.get('/api/settings')).json();
    const original=await(await request.get(`/api/workspace-preferences?workspace=${encodeURIComponent(settings.workspace)}`)).json();
    try{await use();}finally{
      const response=await request.post('/api/workspace-preferences',{data:{
        workspace:settings.workspace,providerId:original.providerId??settings.defaultProvider,model:original.model??settings.defaultModel,
        architecture:original.architecture??null,planner:original.planner??null,shunt:original.shunt??null,modelReasoning:original.modelReasoning??{},outputStyle:original.outputStyle??null,
        permissionMode:original.permissionMode??settings.permissionMode,setupComplete:original.setupComplete??false,
      }});
      expect(response.ok(),await response.text()).toBe(true);
    }
  },{auto:true}],
});
