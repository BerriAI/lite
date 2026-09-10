import type { KeyEvent, TextareaRenderable } from '@opentui/core';
import { buildBindings, KeymapRouter } from './keymap.js';
import { KEYBIND_DEFAULTS, type BindingValue } from './keybinds.js';

const movements: Record<string, keyof TextareaRenderable> = {
  'left': 'moveCursorLeft', 'right': 'moveCursorRight', 'up': 'moveCursorUp', 'down': 'moveCursorDown',
  'line.home': 'gotoLineHome', 'line.end': 'gotoLineEnd', 'visual.line.home': 'gotoVisualLineHome', 'visual.line.end': 'gotoVisualLineEnd',
  'buffer.home': 'gotoBufferHome', 'buffer.end': 'gotoBufferEnd', 'word.forward': 'moveWordForward', 'word.backward': 'moveWordBackward',
};
const operations: Record<string, keyof TextareaRenderable> = {
  'submit': 'submit', 'newline': 'newLine', 'delete.line': 'deleteLine', 'delete.to.line.end': 'deleteToLineEnd',
  'delete.to.line.start': 'deleteToLineStart', 'backspace': 'deleteCharBackward', 'delete': 'deleteChar', 'undo': 'undo', 'redo': 'redo',
  'delete.word.forward': 'deleteWordForward', 'delete.word.backward': 'deleteWordBackward', 'select.all': 'selectAll',
};
export class EditorKeys {
  private router = new KeymapRouter('none');
  private suppressed = new KeymapRouter('none');
  constructor(overrides: Record<string, BindingValue>) {
    const names = Object.keys(KEYBIND_DEFAULTS).filter(name => name.startsWith('input_') && !['input_clear', 'input_paste'].includes(name));
    this.router.addLayer({ name: 'editor', bindings: buildBindings(overrides, names) });
    this.suppressed.addLayer({ name: 'replaced', bindings: buildBindings({}, names.filter(name => overrides[name] !== undefined)) });
  }
  handle(editor: TextareaRenderable, key: KeyEvent) {
    if (key.defaultPrevented) return;
    const stroke = { name: key.name, ctrl: key.ctrl, shift: key.shift, meta: key.meta };
    const result = this.router.dispatch(stroke), command = result.command?.replace(/^input\./, '');
    if (command) {
      const selected = command.startsWith('select.');
      const movement = command.replace(/^(move|select)\./, '');
      const method = movements[movement] ?? operations[command];
      if (method) {
        key.preventDefault(); key.stopPropagation();
        const fn = editor[method] as (options?: { select: boolean }) => unknown;
        fn.call(editor, movements[movement] ? { select: selected } : undefined);
      }
    } else if (this.suppressed.dispatch(stroke).handled) { key.preventDefault(); key.stopPropagation(); }
  }
  dispose() { this.router.dispose(); this.suppressed.dispose(); }
}
