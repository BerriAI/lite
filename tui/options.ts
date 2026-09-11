/** CLI options for the terminal client. The launcher validates --url before
 * re-execing this process, so parsing here is deliberately forgiving. */
export interface Options {
  url: string;
  workspace: string;
  sessionId?: string;
  model?: string;
  providerId?: string;
  mode?: 'plan' | 'build';
  permissionMode?: 'auto';
}

export function parseOptions(args: string[], env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Options {
  const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  return {
    url: (value('--url') ?? env.LITESPEED_URL ?? `http://localhost:${env.LITESPEED_PORT || 3210}`).replace(/\/+$/, ''),
    workspace: value('--workspace') ?? cwd,
    sessionId: value('--session'),
    model: value('--model'),
    providerId: value('--provider'),
    mode: args.includes('--plan') ? 'plan' : args.includes('--build') ? 'build' : undefined,
    permissionMode: args.includes('--auto') ? 'auto' : undefined,
  };
}
