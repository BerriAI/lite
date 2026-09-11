export function shellQuote(value: string): string;
export function configurePath(options: {bin: string; userHome: string; shell?: string; zdotdir?: string; skip?: boolean}): Promise<{configured: boolean; line: string; files: string[]}>;
