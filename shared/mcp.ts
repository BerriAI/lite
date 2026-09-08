/** Cache-only lifecycle observations; neither status nor saved config connects. */
export interface McpServerStatus {
  name: string;
  revision: string;
  status: 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'refreshing' | 'stale' | 'error';
  tools: { name: string; remoteName: string; description: string }[];
  error?: string;
  reason?: string;
  updatedAt?: number;
}
