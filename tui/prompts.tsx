/** @jsxImportSource @opentui/react */
import { useEffect, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { PermissionRequest, QuestionRequest } from '../shared/types.js';
import type { TerminalController } from './controller.js';
import { useTheme } from './context.js';
import { toHex } from './theme.js';
import { createTwoFilesPatch } from 'diff';
import { Button, Dialog, TextViewer } from './ui.js';
import { terminalText } from './protocol.js';

export function PermissionPrompt({ request, controller, disabled, onOverlayChange, active = true }: { request: PermissionRequest; controller: TerminalController; disabled: boolean; active?: boolean; onOverlayChange: (open: boolean) => void }) {
  const theme = useTheme(), { height } = useTerminalDimensions(), [preview, setPreview] = useState(false), [previewText, setPreviewText] = useState('');
  useEffect(() => {
    if (!preview) return;
    let live = true; const args = request.args;
    setPreviewText('');
    if ((request.tool === 'write_file' || request.tool === 'edit_file') && typeof args.path === 'string') {
      void (async () => {
        let before = '';
        const root = controller.detail!;
        let workspace = root.session.workspace;
        // Public permissions belong to the root, even when an isolated child
        // requested the edit. Match the tool in its scoped invocation view.
        if (!root.messages.some(message => message.toolCalls?.some(call => call.id === request.toolCallId))) {
          for (const invocation of root.delegations?.filter(item => item.status === 'running') ?? []) {
            const child = await controller.client.api<import('../shared/types.js').DelegationDetail>(controller.path(`/delegations/${encodeURIComponent(invocation.id)}`));
            if (child.messages.some(message => message.toolCalls?.some(call => call.id === request.toolCallId))) { workspace = child.session.workspace; break; }
          }
        }
        try { before = (await controller.client.api<{ content: string }>(`/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(args.path as string)}`)).content; }
        catch (error) { if (request.tool !== 'write_file' || (error as { status?: number }).status !== 404) throw error; }
        const endings = (text: string) => before.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
        const old = typeof args.old_string === 'string' ? endings(args.old_string) : '';
        if (request.tool === 'edit_file' && (!old || !before.includes(old) || (!args.replace_all && before.indexOf(old, before.indexOf(old) + 1) >= 0))) throw new Error('The edit does not uniquely match the current file. Review the original arguments below.');
        const replacement = typeof args.new_string === 'string' ? endings(args.new_string) : '';
        const after = request.tool === 'write_file' ? String(args.content ?? '') : args.replace_all ? before.split(old).join(replacement) : before.replace(old, () => replacement);
        if (live) setPreviewText('Proposed edit · current file at preview time\n\n' + createTwoFilesPatch(args.path as string, args.path as string, before, after));
      })().catch(error => { if (live) setPreviewText(`Preview unavailable: ${error.message}`); });
    }
    return () => { live = false; };
  }, [preview, request.id]);
  useEffect(() => { onOverlayChange(preview); return () => onOverlayChange(false); }, [preview, onOverlayChange]);
  const decide = (decision: 'allow' | 'always' | 'deny') => { if (!disabled) void controller.decide(request, decision); };
  useKeyboard(key => {
    if (!active || key.defaultPrevented || preview) return;
    const decision = key.name === '1' ? 'allow' : key.name === '2' ? 'always' : key.name === '3' ? 'deny' : null;
    if (decision || (key.ctrl && key.name === 'f')) { key.preventDefault(); key.stopPropagation(); if (decision) decide(decision); else setPreview(true); }
  });
  const summary = terminalText(request.description || request.tool, true);
  const args = terminalText(JSON.stringify(request.args, null, 2), true);
  return <><box border borderColor={toHex(theme.warning)} paddingLeft={1} paddingRight={1} flexDirection="column" flexShrink={0}>
    <text fg={toHex(theme.warning)}><strong>Permission requested · {request.tool}</strong></text>
    <text height={1} fg={toHex(theme.text)}>{summary.slice(0, 300)}</text>
    <text height={height < 20 ? 1 : 3} fg={toHex(theme.textMuted)}>{args.split('\n').slice(0, 3).join('\n')}</text>
    <box flexDirection="row" gap={1}><Button disabled={disabled} onPress={() => decide('allow')}>1 Allow once</Button><Button disabled={disabled} onPress={() => decide('always')}>2 Always</Button><Button disabled={disabled} onPress={() => decide('deny')}>3 Deny</Button><Button onPress={() => setPreview(true)}>Ctrl+F Details</Button></box>
  </box>
    {preview && <Dialog title={`Review ${request.tool}`} onClose={() => setPreview(false)}><scrollbox height={Math.max(4, height - 10)} focused><text fg={toHex(theme.text)}>{previewText + '\n\n' + summary + '\n\n' + args}</text></scrollbox></Dialog>}
  </>;
}

export function QuestionPrompt({ request, controller, disabled, onOverlayChange, active = true }: { request: QuestionRequest; controller: TerminalController; disabled: boolean; active?: boolean; onOverlayChange: (open: boolean) => void }) {
  const theme = useTheme(), { height } = useTerminalDimensions(), [preview, setPreview] = useState(false), [custom, setCustom] = useState(false), [answer, setAnswer] = useState('');
  useEffect(() => { onOverlayChange(preview || custom); return () => onOverlayChange(false); }, [preview, custom, onOverlayChange]);
  const choose = (id: string) => { if (!disabled) void controller.answer(request, { kind: 'option', optionId: id }); };
  useKeyboard(key => {
    if (!active || key.defaultPrevented || preview) return;
    if (key.ctrl && key.name === 'f') { key.preventDefault(); key.stopPropagation(); setPreview(true); return; }
    if (custom && key.name === 'escape') { key.preventDefault(); key.stopPropagation(); setCustom(false); return; }
    if (custom) return;
    if (/^[0-9]$/.test(key.name)) {
      const option = request.options[Number(key.name) - 1];
      if (key.name === '0' || option) { key.preventDefault(); key.stopPropagation(); if (option) choose(option.id); else setCustom(true); }
    }
  });
  const send = (value = answer) => { if (value.trim() && !disabled) void controller.answer(request, { kind: 'text', text: value.trim() }); };
  return <><box border borderColor={toHex(theme.warning)} paddingLeft={1} paddingRight={1} flexDirection="column" flexShrink={0}>
    <text fg={toHex(theme.warning)}><strong>Question from agent</strong></text>
    <text height={2} fg={toHex(theme.text)}>{terminalText(request.question, true)}</text>
    {custom ? <><input focused={!disabled && !preview} placeholder="Your answer…" value={answer} onInput={setAnswer} onSubmit={value => send(typeof value === 'string' ? value : answer)} /><box flexDirection="row"><Button disabled={disabled || !answer.trim()} onPress={() => send()}>Submit answer</Button><Button onPress={() => setCustom(false)}>Back to choices</Button></box></> : <>
      <scrollbox height={Math.max(1, Math.min(request.options.length * 2, height - 10))} focused={!preview}>
      {request.options.map((option, index) => <box key={option.id} flexDirection="column"><Button disabled={disabled} onPress={() => choose(option.id)}>{`${index + 1} ${terminalText(option.label)}`}</Button>{option.description && <text fg={toHex(theme.textMuted)}>{`  ${terminalText(option.description)}`}</text>}</box>)}
      </scrollbox><box flexDirection="row"><Button disabled={disabled} onPress={() => setCustom(true)}>0 Custom reply</Button><Button onPress={() => setPreview(true)}>Ctrl+F Full question</Button></box>
    </>}
  </box>{preview && <TextViewer title="Question" text={[request.question, ...request.options.map((option, index) => `${index + 1}. ${option.label}\n${option.description ?? ''}`)].join('\n\n')} onClose={() => setPreview(false)} />}</>;
}
