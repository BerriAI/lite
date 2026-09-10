/** Only wired commands are registered. Editor keys remain owned by the editor. */
export const KEY_COMMANDS: Record<string, string> = {
  'messages.copy': 'copy', 'session.timeline': 'timeline', 'model.list': 'models', 'session.list': 'sessions', 'session.new': 'new', 'session.rename': 'rename',
  'session.queued_prompts': 'queue', 'session.undo': 'undo', 'session.redo': 'redo',
  'prompt.editor': 'editor', 'session.export': 'export', 'session.fork': 'fork', 'session.compact': 'compact',
  'diff.open': 'changes', 'session.toggle.thinking': 'thinking', 'session.toggle.actions': 'actions',
  'session.toggle.timestamps': 'timestamps', 'session.toggle.generic_tool_output': 'outputs',
  'app.toggle.animations': 'animations', 'theme.switch': 'theme', 'agent.cycle': 'mode',
};
export const ACTIVE_KEY_ACTIONS = ['terminal_suspend', 'app_exit', 'session_interrupt', 'command_list', 'model_list', 'help_show', 'session_list', 'session_new', 'session_rename', 'messages_undo', 'messages_redo', 'display_thinking', 'tool_details', 'editor_open', 'session_export', 'session_fork', 'session_compact', 'diff_open', 'session_queued_prompts', 'session_timeline', 'messages_copy', 'theme_list', 'session_toggle_timestamps', 'session_toggle_generic_tool_output', 'app_toggle_animations'];
export const COMMAND_ORDER = ['models', 'sessions', 'new', 'mode', 'settings', 'changes', 'work', 'timeline', 'copy', 'workers', 'todos', 'goal', 'queue', 'steer', 'stop', 'files', 'attach', 'attachments', 'editor', 'shell', 'commands', 'drafts', 'history', 'undo', 'redo', 'recover', 'fork', 'compact', 'rename', 'archive', 'export', 'import', 'theme', 'thinking', 'actions', 'timestamps', 'outputs', 'animations', 'refresh', 'notice', 'delete', 'quit'];
