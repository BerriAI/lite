/** Descriptive origin of user input, never a permission or policy signal. */
export type ClientSurface = 'web' | 'terminal' | 'cli' | 'api';
export function clientSurface(value: unknown): ClientSurface {
  return value === 'web' || value === 'terminal' || value === 'cli' ? value : 'api';
}
