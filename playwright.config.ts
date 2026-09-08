import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e',fullyParallel:false,workers:1,timeout:30000,
  expect:{timeout:7000},reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://127.0.0.1:3211',trace:'retain-on-failure',screenshot:'only-on-failure',launchOptions:{channel:'chrome'}},
  projects:[{name:'desktop',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:1000}}}],
  webServer:{command:'npx tsx scripts/e2e-server.ts',url:'http://127.0.0.1:3211/api/health',reuseExistingServer:false,timeout:30000},
});
