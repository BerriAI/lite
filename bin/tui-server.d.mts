export function ensureTuiServer(options: { base: string; root: string; workspace: string; explicit: boolean; env?: NodeJS.ProcessEnv }): Promise<{ pid: number; log: string } | undefined>;
