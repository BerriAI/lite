import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { configurePath } from '../bin/install-path.mjs';

let directory:string;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'litespeed-install-path-'));});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
it.each(['/bin/zsh','/bin/bash'])('makes the bare command work in a fresh %s without replacing existing configuration',async shell=>{
  const bin=join(directory,"bin with ' quotes $(exit 42)"),dotdir=join(directory,'dotfiles');await mkdir(bin);await mkdir(dotdir);
  const command=join(bin,'litespeed');await writeFile(command,'#!/bin/sh\nprintf "ready"\n',{mode:0o755});
  const profile=shell.endsWith('zsh')?join(dotdir,'.zshrc'):join(directory,'.bash_profile');
  await writeFile(profile,'export EXISTING_SETUP=preserved');
  const input={bin,userHome:directory,shell,zdotdir:dotdir};
  await configurePath(input);const first=await readFile(profile,'utf8');await configurePath(input);
  expect(await readFile(profile,'utf8')).toBe(first);expect(first).toContain('export EXISTING_SETUP=preserved');
  const output=execFileSync(shell,['-lic','command -v litespeed; litespeed; printf " $EXISTING_SETUP"'],{env:{HOME:directory,ZDOTDIR:dotdir,PATH:'/usr/bin:/bin',SHELL:shell},encoding:'utf8',stdio:['ignore','pipe','pipe']});
  expect(output).toContain(command);expect(output).toContain('ready preserved');
});
it('honors the existing Bash login profile and supports opting out',async()=>{
  const bin=join(directory,'bin');await writeFile(join(directory,'.profile'),'# existing profile\n');
  expect(await configurePath({bin,userHome:directory,shell:'/bin/bash',skip:true})).toMatchObject({configured:false});
  expect(await readFile(join(directory,'.profile'),'utf8')).toBe('# existing profile\n');
  const configured=await configurePath({bin,userHome:directory,shell:'/bin/bash'});
  expect(configured.files).toEqual([join(directory,'.profile'),join(directory,'.bashrc')]);
  expect(await configurePath({bin,userHome:directory,shell:'/usr/local/bin/fish'})).toMatchObject({configured:false});
});
