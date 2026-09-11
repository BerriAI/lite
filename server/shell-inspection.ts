export interface InspectionCommand { command: string; args: string[]; after: ';' | '&&' | '||' }

// This recognizes a small literal shell subset for scheduling, never permission approval.
// Execute the returned argv directly; sending it back through a shell would reintroduce expansion.
export function shellInspection(command: unknown): InspectionCommand[] | null {
  if (typeof command !== 'string' || !command.trim() || command.length > 128 * 1024) return null;
  const commands: InspectionCommand[] = [];
  let words: string[] = [], word = '', started = false, quote = '', after: InspectionCommand['after'] = ';';
  const flush = () => { if (started) words.push(word); word = ''; started = false; };
  const finish = () => {
    flush();
    if (!words.length || !inspectionArgs(words)) return false;
    commands.push({ command: words[0], args: words.slice(1), after }); words = []; return true;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(c) || '$`\\'.includes(c)) return null;
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if ('<>()[{}]*?!~#'.includes(c)) return null;
    if (c === ';' || c === '&' || c === '|' || c === '\n') {
      let next: InspectionCommand['after'] = ';';
      if (c === '&' || c === '|') { if (command[++i] !== c) return null; next = c === '&' ? '&&' : '||'; }
      if (!finish()) return null;
      after = next; continue;
    }
    if (/\s/.test(c)) flush(); else { started = true; word += c; }
  }
  if (quote) return null;
  if (words.length || started) { if (!finish()) return null; }
  else if (after !== ';') return null;
  return commands.length ? commands : null;
}
function inspectionArgs([command, ...args]: string[]): boolean {
  if (command === 'git') {
    const [sub, ...flags] = args;
    if (sub === '--version') return !flags.length;
    if (sub === 'status') return flags.every(flag => /^(?:--short|-s|--branch|-b|--porcelain(?:=v[12])?|--untracked-files(?:=(?:no|normal|all))?|--ignore-submodules(?:=(?:none|untracked|dirty|all))?)$/.test(flag));
    if (sub === 'branch') return flags.length > 0 && flags.every(flag => /^(?:--show-current|--list|--all|-a|--remotes|-r|--verbose|-v|-vv|--no-color)$/.test(flag));
    if (sub === 'remote') return flags.every(flag => flag === '-v' || flag === '--verbose');
    if (sub === 'diff' || sub === 'log') {
      let paths = false;
      return flags.every(flag => {
        if (paths) return true;
        if (flag === '--') { paths = true; return true; }
        if (!flag.startsWith('-')) return true;
        return sub === 'diff'
          ? /^(?:--stat|--check|--name-only|--name-status|--numstat|--shortstat|--cached|--staged|--relative|--no-prefix|--no-color|--exit-code|--quiet|--no-ext-diff|--no-textconv|-U\d+)$/.test(flag)
          : /^(?:--oneline|--stat|--name-only|--name-status|--no-color|--all|--decorate|--no-decorate|--no-ext-diff|--no-textconv|-\d+|-n\d+|--max-count=\d+)$/.test(flag);
      });
    }
    return false;
  }
  if (command === 'gh') return args.length === 1 && args[0] === '--version';
  if (command === 'pwd') return args.every(arg => arg === '-L' || arg === '-P');
  if (!['cat', 'head', 'tail', 'ls', 'wc'].includes(command)) return false;
  let paths = false, number = false;
  for (const arg of args) {
    if (number) { if (!/^\d+$/.test(arg)) return false; number = false; continue; }
    if (paths || !arg.startsWith('-') || arg === '-') continue;
    if (arg === '--') { paths = true; continue; }
    if ((command === 'head' || command === 'tail') && (arg === '-n' || arg === '-c')) { number = true; continue; }
    const allowed = command === 'cat' ? /^-[benstuvAET]+$/ : command === 'ls' ? /^-[aAldhFprtS1]+$/ : command === 'wc' ? /^-[clmwL]+$/ : /^(?:-\d+|-[nc]\d+|-q|-v)$/;
    if (!allowed.test(arg)) return false;
  }
  return !number;
}
