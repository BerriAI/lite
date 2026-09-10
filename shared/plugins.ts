// Plugin packages (design note 4.4): install-time trust. A package is a LOCAL
// directory with speedrail-plugin.json (or a compatible .claude-plugin/plugin.json
// where the shapes map). Install is dry-run-plan first, then an explicit apply;
// every installed item is recorded with provenance (kind + exact target +
// sha256 of the installed content) so uninstall removes exactly what the
// plugin owns and never a file the user modified. Git URLs are OUT OF SCOPE in
// v1: users clone first — the installer never touches the network.

/** One provenance record. `target` is an exact workspace-relative file path
 * (skills/commands) or a settings key (mcp/hooks). `hash` is the sha256 of the
 * installed content: file text for files, canonical JSON for settings entries
 * (mcp hashes EXCLUDE `enabled` so connecting a server later does not strand
 * the entry at uninstall). */
export interface PluginItem { kind: 'skill' | 'command' | 'mcp' | 'hook'; target: string; hash: string }

/** Registry entry under Settings.plugins, keyed by plugin name. `workspace` is
 * the canonical workspace the file items were installed into: file ownership
 * is per-workspace, while mcp/hook items live in global settings. */
export interface PluginRegistryEntry { version: string; description?: string; installedAt: number; workspace: string; items: PluginItem[] }

/** One planned install step. `preview` is bounded (500 chars) display text.
 * conflict 'exists' = the target is present and NOT owned by this plugin
 * (v1 always skips it — no force); 'same-plugin-update' = owned, will be
 * overwritten in place. */
export interface InstallAction { kind: PluginItem['kind']; name: string; target: string; preview: string; conflict?: 'exists' | 'same-plugin-update' }

/** The dry-run plan. `unmapped` lists top-level compat-manifest keys that have
 * no speedrail equivalent and were ignored. */
export interface InstallPlan { plugin: { name: string; version: string; description?: string }; actions: InstallAction[]; warnings: string[]; unmapped?: string[] }

export interface UninstallResult { removed: { kind: PluginItem['kind']; target: string }[]; warnings: string[] }

export const PLUGIN_LIMITS = {
  sourcePath: 4096,    // Local directory path length.
  relPath: 1024,       // Manifest-referenced file path length.
  description: 200,
  version: 32,
  skills: 64,          // Mirrors PROFILE_LIMITS.skills.
  commands: 100,       // Mirrors the /api/commands listing bound.
  previewChars: 500,
  manifestBytes: 128 * 1024,
  skillBytes: 32 * 1024,   // Mirrors PROFILE_LIMITS.skillBytes.
  commandBytes: 64 * 1024, // Mirrors the readCommand bound.
} as const;
