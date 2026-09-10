export interface ProjectCommand { name: string; description: string; content: string }

/** Same template semantics as the web composer. Unknown slash text stays text. */
export function expandProjectCommand(content: string, commands: ProjectCommand[]): string {
  const match = content.match(/^\/(\S+)([\s\S]*)$/);
  const command = match && commands.find(item => item.name === match[1]);
  if (!match || !command) return content;
  const args = match[2].trim();
  const positional = (args.match(/"[^"]*"|\S+/g) ?? []).map(value => value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value);
  return command.content.replace(/\$(ARGUMENTS|[1-9])/g, (_, key: string) => key === 'ARGUMENTS' ? args : positional[Number(key) - 1] ?? '');
}
