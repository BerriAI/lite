import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ownDataDirectory } from '../server/ownership.js';

let directory: string, child: ChildProcess | undefined;
afterEach(async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child,'exit'); } if(directory) rmSync(directory,{recursive:true,force:true}); });
it('refuses a second backend and releases ownership after clean shutdown', () => {
  directory=mkdtempSync(join(tmpdir(),'litespeed-owner-'));
  const close=ownDataDirectory(directory);
  try { expect(()=>ownDataDirectory(directory)).toThrow('Another Litespeed server'); }
  finally {close();close();}
  ownDataDirectory(directory)();
});
it('reclaims the directory after its owner is killed without deleting a stale lock', async () => {
  directory=mkdtempSync(join(tmpdir(),'litespeed-owner-crash-'));
  child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',`import {ownDataDirectory} from ${JSON.stringify(resolve('server/ownership.ts'))}; const release=ownDataDirectory(process.argv[1]); process.once('exit',release); console.log('owned'); setInterval(()=>{},1000);`,directory],{stdio:['ignore','pipe','pipe']});
  await once(child.stdout!,'data');
  expect(()=>ownDataDirectory(directory)).toThrow('Another Litespeed server');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  ownDataDirectory(directory)();
});
