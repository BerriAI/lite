import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkCommandKey, isCheckCommand } from '../shared/receipts.js';

/** Only a single recognizable check can use the shell exit as its verdict.
 * Compound commands and expansions may hide earlier failures. npm test is an
 * alias only when the actual package script is exactly vitest run, with no hooks. */
export async function commandCheckKey(command: string, cwd: string, verification = false): Promise<string | undefined> {
  let check = checkCommandKey(command), directory = cwd;
  const cd = check.match(/^cd ([a-zA-Z0-9_./-]+) && (.+)$/);
  if (cd) { directory = resolve(cwd, cd[1]); check = cd[2]; }
  if (!/^[a-zA-Z0-9_./:@=+ ,*?-]+$/.test(check) || (!verification && !isCheckCommand(check, true))) return undefined;
  try { directory = await realpath(directory); } catch { return undefined; }
  if (/^npm (?:test|run test)$/.test(check)) {
    try {
      const { scripts } = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
      if (scripts?.test?.trim() === 'vitest run' && !scripts.pretest && !scripts.posttest) check = 'npx vitest run';
    } catch { /* Keep an unknown script's identity exact. */ }
  }
  return JSON.stringify([directory, check]);
}
