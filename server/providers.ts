import { REASONING_EFFORTS } from '../shared/types.js';
import { randomUUID } from 'node:crypto';
import { validContextWindow } from './budget.js';
import type { Model, ReasoningEffort, Provider, StreamChunk, ToolDefinition, Usage } from '../shared/types.js';

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | any[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  providerMetadata?: Record<string, unknown>;
}
export interface CompletionOptions {
  provider: Provider; model: string; messages: ProviderMessage[]; tools?: ToolDefinition[];
  signal: AbortSignal; system?: string; reasoningEffort?: ReasoningEffort;
  /** Reports a scheduled retry, not a guarantee that a failed attempt was unbilled. */
  onRetry?: (retry: ProviderRetry) => void;
}
export interface ProviderRetry { attempt: number; delayMs: number; status: number }
/** Safe local error fields. retryable classifies the failure; it never grants an extra retry budget. */
export class ProviderError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;
  readonly contextOverflow: boolean;
  constructor(message: string, details: { status?: number; code?: string; retryable?: boolean; contextOverflow?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = details.status;
    this.code = details.code;
    this.retryable = details.retryable ?? false;
    this.contextOverflow = details.contextOverflow ?? false;
  }
}
export interface CodexCredential { accessToken: string; accountId?: string; residency?: string }
let codexCredentials: ((providerId: string) => Promise<CodexCredential>) | undefined;
export function configureCodexAuth(resolve: (providerId: string) => Promise<CodexCredential>) { codexCredentials = resolve; }
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';

/** Base URLs are API roots, not operation URLs. Preserve custom gateway prefixes. */
export function endpoint(base: string, operation: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new ProviderError('Provider base URL must be a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new ProviderError('Provider base URL must use HTTP(S), without credentials, query parameters, or fragments.');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|messages|responses|models)$/, '');
  path = path.replace(/(?:\/v1){2,}(?=\/|$)/g, '/v1');
  if (!path) path = '/v1';
  url.pathname = `${path}/${operation}`;
  return url.toString();
}
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;
const PERMANENT_CODES = new Set([
  'invalid_api_key', 'insufficient_quota', 'quota_exceeded', 'quota_exhausted', 'usage_limit_reached',
  'billing_hard_limit_reached', 'billing_not_active', 'budget_exceeded', 'insufficient_credits',
  'authentication_error', 'permission_error', 'permission_denied', 'unauthorized',
  'model_not_found', 'model_not_supported', 'invalid_model', 'invalid_request_error',
  'invalid_request', 'invalid_argument', 'unsupported_parameter',
  'context_length_exceeded', 'context_window_exceeded', 'prompt_too_long', 'input_too_long',
]);
const KNOWN_CODES = new Set([...PERMANENT_CODES, 'rate_limit_exceeded', 'rate_limit_error', 'overloaded_error', 'server_error', 'api_error', 'timeout_error']);
function errorDetails(body: any): { code?: string; permanent: boolean; contextOverflow: boolean } {
  const error = body?.error ?? body;
  const codes = [error?.code, error?.type, body?.code, body?.type].filter((v): v is string => typeof v === 'string');
  // Inspect messages only for classification; never expose raw codes, bodies, headers, or causes.
  const message = typeof error?.message === 'string' ? error.message.slice(0, 8192) : '';
  const contextOverflow = codes.some(code => ['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long', 'input_too_long'].includes(code)) ||
    /maximum context length|context (?:window|length).{0,40}(?:exceed|limit)|(?:prompt|input) (?:is )?too long|exceeds? (?:the )?(?:maximum )?(?:context|input token)/i.test(message);
  const quota = /(?:quota|credits?|budget|balance).{0,40}(?:exhausted|exceeded|insufficient|too low)|(?:insufficient|exhausted).{0,20}(?:quota|credits?|balance)|billing (?:hard )?limit|exceeded (?:your )?(?:current )?quota/i.test(message);
  const authentication = /invalid (?:api[ -]?key|authentication)|incorrect api[ -]?key|authentication (?:failed|required)|permission denied/i.test(message);
  const invalidModel = /model.{0,80}(?:does not exist|not found|not supported|not available)|(?:unknown|invalid|unsupported) model/i.test(message);
  const invalidRequest = /invalid (?:request|parameter|argument)|unsupported (?:parameter|argument)|unrecognized request argument/i.test(message);
  const permanent = contextOverflow || quota || authentication || invalidModel || invalidRequest || codes.some(code => PERMANENT_CODES.has(code));
  const code = contextOverflow ? 'context_length_exceeded' : quota ? 'insufficient_quota' : authentication ? 'authentication_error' :
    invalidModel ? 'model_not_found' : invalidRequest ? 'invalid_request_error' :
    codes.find(code => PERMANENT_CODES.has(code)) || codes.find(code => KNOWN_CODES.has(code));
  return { code, permanent, contextOverflow };
}
function httpError(status: number, body?: any): ProviderError {
  const { code, permanent, contextOverflow } = errorDetails(body);
  const advice: Record<number, string> = {
    400: 'Check the model, tool support, and request settings.',
    401: 'Check your API key or sign in again.', 403: 'Check account entitlements and workspace permissions.',
    404: 'Check the base URL and model ID.', 408: 'The provider timed out.',
    429: 'Rate limit or quota reached. Wait before trying again.',
  };
  return new ProviderError(`Provider request failed (HTTP ${status}${code ? `, ${code}` : ''}). ${contextOverflow ? 'The conversation exceeds the model context window. Shorten or compact it.' : advice[status] || 'The provider could not complete this request.'}`,
    { status, code, contextOverflow, retryable: TRANSIENT_STATUSES.has(status) && !permanent });
}
function streamError(body: any): ProviderError {
  const { code, contextOverflow } = errorDetails(body);
  return new ProviderError(`Provider stream failed${code ? `, ${code}` : ''}.`, { code, contextOverflow });
}
function retryDelay(header: string | null, attempt: number): number {
  let milliseconds = Number.NaN;
  if (header && header.length < 128) {
    const value = header.trim();
    if (/^\d+(?:\.\d+)?$/.test(value)) milliseconds = Number(value) * 1000;
    else if (!/^[+-]?[\d.]+$/.test(value)) milliseconds = Date.parse(value) - Date.now();
  }
  return Number.isFinite(milliseconds) ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, milliseconds)) : 500 * 2 ** (attempt - 1);
}
function waitForRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason || new DOMException('Request cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function request(url: string, init: RequestInit, retry?: { onRetry?: CompletionOptions['onRetry'] }): Promise<Response> {
  for (let retries = 0; ; retries++) {
    init.signal?.throwIfAborted();
    let response: Response;
    try { response = await fetch(url, { ...init, redirect: 'error' }); }
    catch {
      if (init.signal?.aborted) throw init.signal.reason || new DOMException('Request cancelled', 'AbortError');
      // A disconnected POST may have been processed and billed. Never automatically replay it.
      throw new ProviderError('Cannot reach provider. Check the base URL, network, and TLS configuration. The request was not retried; it may have reached the provider.', { code: 'network_error' });
    }
    if (response.ok) return response;
    let body: any;
    try { body = await response.json(); }
    catch (error) {
      init.signal?.throwIfAborted();
      // Non-JSON gateway pages still carry an explicit HTTP status. A disconnected
      // body is different: don't replay when an error's quota/type details were lost.
      if (!(error instanceof SyntaxError)) throw new ProviderError('Provider error response was interrupted. No automatic retry was attempted.', { status: response.status, code: 'network_error' });
    }
    init.signal?.throwIfAborted();
    const error = httpError(response.status, body);
    if (!retry || !error.retryable || retries >= MAX_RETRIES) throw error;
    const attempt = retries + 1, delayMs = retryDelay(response.headers.get('retry-after'), attempt);
    // The callback carries only numeric local fields, never provider text or credential-bearing data.
    retry.onRetry?.({ attempt, delayMs, status: response.status });
    await waitForRetry(delayMs, init.signal);
  }
}

/** Streaming decoder tolerates split UTF-8, CRLF, comments, and multiline data fields. */
export async function* parseSSE(response: Response, signal: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) throw new ProviderError('Provider returned an empty streaming response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = '', fields: string[] = [], eventSize = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  function line(value: string): { event: string; data: string } | undefined {
    if (value === '') {
      const result = fields.length ? { event, data: fields.join('\n') } : undefined;
      event = ''; fields = []; eventSize = 0;
      return result;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const key = colon < 0 ? value : value.slice(0, colon);
    const raw = colon < 0 ? '' : value.slice(colon + 1);
    const content = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (key === 'event') event = content;
    if (key === 'data') {
      eventSize += content.length;
      if (eventSize > MAX_EVENT_BYTES) throw new ProviderError('Provider stream event exceeded the size limit.');
      fields.push(content);
    }
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      let offset = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] !== '\n' && buffer[i] !== '\r') continue;
        if (buffer[i] === '\r' && i === buffer.length - 1 && !done) break;
        const parsed = line(buffer.slice(offset, i));
        if (buffer[i] === '\r' && buffer[i + 1] === '\n') i++;
        offset = i + 1;
        if (parsed) yield parsed;
      }
      buffer = buffer.slice(offset);
      if (buffer.length > MAX_EVENT_BYTES) throw new ProviderError('Provider stream line exceeded the size limit.');
      if (done) {
        if (buffer) { const parsed = line(buffer); if (parsed) yield parsed; }
        const parsed = line(''); if (parsed) yield parsed;
        break;
      }
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason || new DOMException('Request cancelled', 'AbortError');
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('Provider stream connection was interrupted. No automatic retry was attempted.', { code: 'stream_interrupted' });
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function jsonEvent(data: string): any {
  try { return JSON.parse(data); } catch { throw new ProviderError('Provider returned malformed streaming JSON.'); }
}
function usage(value: any): Usage {
  return {
    inputTokens: value.prompt_tokens ?? value.input_tokens ?? 0,
    outputTokens: value.completion_tokens ?? value.output_tokens ?? 0,
    cachedTokens: value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens ?? value.cache_read_input_tokens,
  };
}
async function* chatStream(response: Response, signal: AbortSignal, scope: { providerId: string; model: string }): AsyncGenerator<StreamChunk> {
  let finished = false, reasoningText = '', toolsSeen = false;
  const thinkingBlocks: any[] = [], reasoningItems: any[] = [];
  const remember = function* (): Generator<StreamChunk> {
    if (thinkingBlocks.length || reasoningItems.length || reasoningText) yield { type: 'metadata', metadata: { ...scope,
      ...(reasoningText ? { reasoning_content: reasoningText } : {}),
      ...(thinkingBlocks.length ? { thinking_blocks: thinkingBlocks } : {}),
      ...(reasoningItems.length ? { reasoning_items: reasoningItems } : {}),
    } };
  };
  for await (const { data } of parseSSE(response, signal)) {
    if (data.trim() === '[DONE]') { if (!toolsSeen) finished = true; break; }
    const chunk = jsonEvent(data);
    if (chunk.error) throw streamError(chunk);
    if (chunk.usage) yield { type: 'usage', usage: usage(chunk.usage) };
    // n is always one; don't combine unrelated alternatives into one assistant message.
    const choice = chunk.choices?.find((c: any) => (c.index ?? 0) === 0);
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) { reasoningText += reasoning; yield { type: 'reasoning', text: reasoning }; }
    // LiteLLM emits unsigned thinking fragments followed by a complete signed block.
    // Only signed blocks (and opaque redacted blocks) are safe to replay.
    for (const block of delta.thinking_blocks || delta.provider_specific_fields?.thinking_blocks || []) {
      if ((block.type === 'thinking' && typeof block.signature === 'string') || block.type === 'redacted_thinking') {
        if (!thinkingBlocks.some(existing => JSON.stringify(existing) === JSON.stringify(block))) thinkingBlocks.push(block);
      }
    }
    for (const item of delta.reasoning_items || []) if (!reasoningItems.some(existing => JSON.stringify(existing) === JSON.stringify(item))) reasoningItems.push(item);
    if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) {
      toolsSeen = true;
      if (!Number.isInteger(call.index) || call.index < 0) throw new ProviderError('Provider returned a tool call without a valid stream index.');
      yield { type: 'tool', tool: {
        index: call.index, id: call.id, name: call.function?.name, arguments: call.function?.arguments,
      } };
    }
    if (choice.finish_reason) {
      if (choice.finish_reason === 'length') throw new ProviderError('The model reached its output limit. No partial tool calls were executed.');
      if (choice.finish_reason === 'content_filter') throw new ProviderError('The provider stopped the response because of content filtering.');
      finished = true;
    }
  }
  if (!finished) throw new ProviderError('Provider stream ended before completion. No partial tool calls were executed.');
  yield* remember();
}

function contentText(value: ProviderMessage['content']): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(p => p.type === 'text' ? p.text : '').filter(Boolean).join('\n');
}
function imagePart(value: any): any {
  const url = value.image_url?.url;
  if (typeof url !== 'string') return undefined;
  const match = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  if (/^https:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } };
  throw new ProviderError('This provider requires HTTPS or base64 image attachments.');
}
function anthropicMessages(messages: ProviderMessage[], providerId: string, model: string): any[] {
  const result: any[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: any[] = [];
    const metadata = scopedMetadata(message, providerId, model);
    if (message.role === 'assistant' && Array.isArray(metadata.anthropicThinking)) content.push(...metadata.anthropicThinking);
    // Anthropic tool_result accepts an array of text and image blocks, so a
    // tool message carrying image parts (view_image) maps each part directly;
    // plain string results keep the existing scalar shape byte-for-byte.
    if (message.role === 'tool') content.push({ type: 'tool_result', tool_use_id: message.tool_call_id, content: Array.isArray(message.content)
      ? message.content.map(part => part.type === 'image_url' ? imagePart(part) : { type: 'text', text: part.type === 'text' ? part.text : '' }).filter(Boolean)
      : contentText(message.content) });
    else {
      if (Array.isArray(message.content)) for (const part of message.content) {
        if (part.type === 'text' && part.text) content.push({ type: 'text', text: part.text });
        if (part.type === 'image_url') content.push(imagePart(part));
      }
      else if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls || []) {
        let input: unknown;
        try { input = JSON.parse(call.function.arguments); } catch { throw new ProviderError('Conversation contains invalid tool arguments.'); }
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
    }
    if (!content.length) continue;
    if (result.at(-1)?.role === role) result.at(-1).content.push(...content);
    else result.push({ role, content });
  }
  return result;
}
async function* anthropicStream(response: Response, signal: AbortSignal, scope: { providerId: string; model: string }): AsyncGenerator<StreamChunk> {
  let finished = false, tokens: Usage = { inputTokens: 0, outputTokens: 0 };
  const thinking = new Map<number, any>();
  for await (const { event, data } of parseSSE(response, signal)) {
    const chunk = jsonEvent(data), type = chunk.type || event;
    if (type === 'error') throw streamError(chunk);
    if (type === 'message_start' && chunk.message?.usage) {
      tokens = usage(chunk.message.usage);
      // Anthropic's input_tokens excludes cache writes and hits; normalize total input.
      tokens.inputTokens += (chunk.message.usage.cache_read_input_tokens || 0) + (chunk.message.usage.cache_creation_input_tokens || 0);
    }
    if (type === 'content_block_start' && ['thinking', 'redacted_thinking'].includes(chunk.content_block?.type)) thinking.set(chunk.index, { ...chunk.content_block });
    if (type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
      yield { type: 'tool', tool: { index: chunk.index, id: chunk.content_block.id, name: chunk.content_block.name } };
      const input = chunk.content_block.input;
      if (input && Object.keys(input).length) yield { type: 'tool', tool: { index: chunk.index, arguments: JSON.stringify(input) } };
    }
    if (type === 'content_block_delta') {
      if (chunk.delta?.type === 'text_delta') yield { type: 'text', text: chunk.delta.text };
      if (chunk.delta?.type === 'thinking_delta') {
        const block = thinking.get(chunk.index);
        if (block) block.thinking = (block.thinking || '') + chunk.delta.thinking;
        yield { type: 'reasoning', text: chunk.delta.thinking };
      }
      if (chunk.delta?.type === 'signature_delta') {
        const block = thinking.get(chunk.index);
        if (block) block.signature = (block.signature || '') + chunk.delta.signature;
      }
      if (chunk.delta?.type === 'input_json_delta') yield { type: 'tool', tool: { index: chunk.index, arguments: chunk.delta.partial_json } };
    }
    if (type === 'message_delta') {
      if (chunk.usage?.output_tokens !== undefined) tokens.outputTokens = chunk.usage.output_tokens;
      if (chunk.delta?.stop_reason === 'max_tokens') throw new ProviderError('The model reached its output limit. No partial tool calls were executed.');
    }
    if (type === 'message_stop') {
      const blocks = [...thinking].sort(([a], [b]) => a - b).map(([, block]) => block).filter(block => block.type === 'redacted_thinking' || block.signature);
      if (blocks.length) yield { type: 'metadata', metadata: { ...scope, anthropicThinking: blocks } };
      finished = true; yield { type: 'usage', usage: tokens }; break;
    }
  }
  if (!finished) throw new ProviderError('Provider stream ended before completion. No partial tool calls were executed.');
}
function scopedMetadata(message: ProviderMessage, providerId: string, model: string): Record<string, any> {
  const data = message.providerMetadata;
  return data?.providerId === providerId && data?.model === model ? data : {};
}
function chatMessages(messages: ProviderMessage[], providerId: string, model: string): any[] {
  return messages.map(({ providerMetadata: _metadata, ...message }, i) => {
    if (message.role !== 'assistant') return message;
    const data = scopedMetadata(messages[i], providerId, model);
    return { ...message, ...(typeof data.reasoning_content === 'string' ? { reasoning_content: data.reasoning_content } : {}),
      ...(Array.isArray(data.thinking_blocks) ? { thinking_blocks: data.thinking_blocks } : {}),
      ...(Array.isArray(data.reasoning_items) ? { reasoning_items: data.reasoning_items } : {}) };
  });
}
function codexInput(messages: ProviderMessage[], providerId: string, model: string): any[] {
  const input: any[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') { input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: contentText(message.content) }); continue; }
    const metadata = scopedMetadata(message, providerId, model);
    if (message.role === 'assistant' && Array.isArray(metadata.responseItems) && metadata.responseItems.length) {
      input.push(...metadata.responseItems.filter((item: any) => ['reasoning', 'message', 'function_call'].includes(item.type)));
      continue;
    }
    const content = typeof message.content === 'string' ? message.content : null;
    if (content) input.push({ role: message.role, content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: content }] });
    if (Array.isArray(message.content)) {
      const parts = message.content.flatMap<any>(part => {
        if (part.type === 'text') return [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }];
        if (part.type === 'image_url') return [{ type: 'input_image', image_url: part.image_url.url }];
        return [];
      });
      if (parts.length) input.push({ role: message.role, content: parts });
    }
    for (const call of message.tool_calls || []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  return input;
}
async function* responsesStream(response: Response, signal: AbortSignal, scope: { providerId: string; model: string }): AsyncGenerator<StreamChunk> {
  let finished = false;
  const responseItems = new Map<number, any>();
  const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
  for await (const { data } of parseSSE(response, signal)) {
    if (data.trim() === '[DONE]') break;
    const chunk = jsonEvent(data);
    if (chunk.type === 'error' || chunk.type === 'response.failed') throw streamError(chunk.response || chunk);
    if (chunk.type === 'response.output_text.delta') yield { type: 'text', text: chunk.delta };
    if (['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(chunk.type)) yield { type: 'reasoning', text: chunk.delta };
    if (chunk.type === 'response.output_item.added' && chunk.item?.type === 'function_call') {
      calls.set(chunk.output_index, { id: chunk.item.call_id, name: chunk.item.name, arguments: chunk.item.arguments || '' });
      yield { type: 'tool', tool: { index: chunk.output_index, id: chunk.item.call_id, name: chunk.item.name, arguments: chunk.item.arguments || undefined } };
    }
    if (chunk.type === 'response.function_call_arguments.delta') {
      const current = calls.get(chunk.output_index) || { arguments: '' };
      current.arguments += chunk.delta;
      calls.set(chunk.output_index, current);
      yield { type: 'tool', tool: { index: chunk.output_index, arguments: chunk.delta } };
    }
    if (chunk.type === 'response.output_item.done' && chunk.item && ['reasoning', 'message', 'function_call'].includes(chunk.item.type)) {
      const { id: _id, ...item } = chunk.item;
      if (item.type !== 'reasoning' || item.encrypted_content) responseItems.set(chunk.output_index, item);
    }
    if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
      const current = calls.get(chunk.output_index);
      const complete = chunk.item.arguments || '';
      if (!current) yield { type: 'tool', tool: { index: chunk.output_index, id: chunk.item.call_id, name: chunk.item.name, arguments: complete } };
      else if (complete !== current.arguments) {
        if (!complete.startsWith(current.arguments)) throw new ProviderError('Provider returned inconsistent tool argument deltas.');
        yield { type: 'tool', tool: { index: chunk.output_index, arguments: complete.slice(current.arguments.length) } };
      }
    }
    if (chunk.type === 'response.incomplete') throw new ProviderError('Provider returned an incomplete response. No partial tool calls were executed.');
    if (chunk.type === 'response.completed') {
      if (responseItems.size) yield { type: 'metadata', metadata: { ...scope, responseItems: [...responseItems].sort(([a], [b]) => a - b).map(([, item]) => item) } };
      if (chunk.response?.usage) yield { type: 'usage', usage: usage(chunk.response.usage) };
      finished = true; break;
    }
  }
  if (!finished) throw new ProviderError('Provider stream ended before completion. No partial tool calls were executed.');
}

async function getCodexCredential(provider: Provider): Promise<CodexCredential> {
  if (!codexCredentials) throw new ProviderError('ChatGPT is not connected. Sign in through this application first.');
  return codexCredentials(provider.id);
}
function codexHeaders(credential: CodexCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`, 'User-Agent': 'speedrail/0.1.0', originator: 'speedrail',
    ...(credential.accountId ? { 'ChatGPT-Account-Id': credential.accountId } : {}),
    ...(credential.residency ? { 'x-openai-internal-codex-residency': credential.residency } : {}),
  };
}
export async function* streamCompletion(options: CompletionOptions): AsyncGenerator<StreamChunk> {
  const { provider, model, messages, system, tools } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  signal.throwIfAborted();
  if (!model) throw new ProviderError('Select a model before sending a message.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  let body: any, url: string;
  if (provider.kind === 'anthropic') {
    if (!provider.apiKey) throw new ProviderError('Anthropic requires an API key. Subscription login is not supported for third-party applications.');
    headers['x-api-key'] = provider.apiKey; headers['anthropic-version'] = '2023-06-01';
    const instructions = [system, ...messages.filter(m => m.role === 'system').map(m => contentText(m.content))].filter(Boolean).join('\n\n');
    // Anthropic prompt caching is opt-in per request: breakpoints on the last
    // tool schema and the system block mark the stable prefix as cacheable.
    // Harmless when the provider or gateway has caching disabled.
    const anthropicTools = tools?.length ? tools.map((t, index) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters, ...(index === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) })) : undefined;
    body = { model, ...(options.reasoningEffort ? { output_config: { effort: options.reasoningEffort } } : {}), max_tokens: 8192, stream: true, messages: anthropicMessages(messages, provider.id, model),
      ...(instructions ? { system: [{ type: 'text', text: instructions, cache_control: { type: 'ephemeral' } }] } : {}),
      ...(anthropicTools ? { tools: anthropicTools } : {}) };
    url = endpoint(provider.baseUrl || 'https://api.anthropic.com', 'messages');
  } else if (provider.kind === 'codex') {
    Object.assign(headers, codexHeaders(await getCodexCredential(provider)));
    headers['session-id'] = randomUUID();
    body = { model, ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}), instructions: [system, ...messages.filter(m => m.role === 'system').map(m => contentText(m.content))].filter(Boolean).join('\n\n') || 'You are a helpful coding assistant.',
      input: codexInput(messages, provider.id, model), stream: true, store: false, include: ['reasoning.encrypted_content'],
      ...(tools?.length ? { tools: tools.map(t => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false })), tool_choice: 'auto', parallel_tool_calls: true } : {}) };
    // Subscription credentials must never be forwarded to a configurable endpoint.
    url = `${CODEX_BASE}/responses`;
  } else {
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    // Anthropic-family models behind an OpenAI-compatible gateway need the same
    // explicit cache breakpoint, carried in a content part per the gateway
    // convention. Scoped to models that require opt-in caching; other models
    // keep plain string content so strict endpoints see an unmodified request.
    const optInCache = /\bclaude\b|anthropic/i.test(model);
    body = { model, ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}), messages: [...(system ? [{ role: 'system', content: optInCache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system }] : []), ...chatMessages(messages, provider.id, model)], stream: true,
      stream_options: { include_usage: true }, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) };
    url = endpoint(provider.baseUrl, 'chat/completions');
  }
  const response = await request(url, { method: 'POST', headers, body: JSON.stringify(body), signal }, { onRetry: options.onRetry });
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    throw new ProviderError('Provider did not return an SSE stream. Check that this endpoint supports streaming.');
  }
  if (provider.kind === 'anthropic') yield* anthropicStream(response, signal, { providerId: provider.id, model });
  else if (provider.kind === 'codex') yield* responsesStream(response, signal, { providerId: provider.id, model });
  else yield* chatStream(response, signal, { providerId: provider.id, model });
}
/** Bounded reviewer (4.2): ONE tool-less, history-less completion — a fixed
 * review system text plus a single user message — under a hard timeout, that
 * returns the trimmed text. The shape is a guarantee, not a convention: no
 * tools are advertised so a reviewer can never act, no history is sent so it
 * can never be steered by transcript content, and the timeout bounds spend.
 * Provider errors and timeouts throw; the CALLER decides the fallback (the
 * goal evaluator, for example, treats any failure as 'continue'). */
export async function boundedReview(options: { provider: Provider; model: string; system: string; prompt: string; timeoutMs?: number; signal?: AbortSignal; reasoningEffort?: ReasoningEffort; onUsage?: (usage:Usage)=>void }): Promise<string> {
  let text = '';
  for await (const chunk of streamCompletion({ provider: options.provider, model: options.model, reasoningEffort:options.reasoningEffort, signal: AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(options.timeoutMs ?? 15_000)]),
    system: options.system, messages: [{ role: 'user', content: options.prompt }] })) {
    if (chunk.type === 'text') text += chunk.text || '';
    if (chunk.type === 'usage'&&chunk.usage)options.onUsage?.(chunk.usage);
    if (text.length > 100_000) break; // Reviews are short verdicts; never buffer a runaway stream.
  }
  return text.trim();
}
export async function listModels(provider: Provider, signal?: AbortSignal): Promise<Model[]> {
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
  let headers: Record<string, string> = {}, url: string;
  if (provider.kind === 'codex') {
    headers = codexHeaders(await getCodexCredential(provider));
    // The subscription catalog is separate from the billed public API catalog.
    url = `${CODEX_BASE}/models?client_version=0.1.0`;
  } else {
    if (provider.kind === 'anthropic') {
      if (!provider.apiKey) throw new ProviderError('Anthropic requires an API key.');
      headers = { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' };
    } else if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    url = endpoint(provider.baseUrl || 'https://api.anthropic.com', 'models');
  }
  const response = await request(url, { headers, signal: requestSignal });
  let result: any;
  try { result = await response.json(); } catch { throw new ProviderError('Provider returned an invalid model catalog.'); }
  const data = Array.isArray(result) ? result : result?.data || result?.models;
  if (!Array.isArray(data)) throw new ProviderError('Provider returned an unsupported model catalog. Configure explicit model IDs instead.');
  const models: Model[] = [];
  const validName = (value: unknown): value is string => typeof value === 'string' && !!value && value === value.trim() && value.length <= 250 && !/[\p{Cc}\p{Cf}]/u.test(value);
  const seen = new Set<string>();
  for (const value of data.slice(0, 2000)) {
    if (!value || typeof value !== 'object') continue;
    const id = validName(value.id) ? value.id : validName(value.slug) ? value.slug : undefined;
    if (!id) continue;
    if (seen.has(id)) {
      // Ambiguous duplicate metadata is not authoritative for budgeting.
      const previous = models.find(model => model.id === id);
      if (previous) { delete previous.contextWindow; delete previous.maxInputTokens; delete previous.reasoningEfforts; }
      continue;
    }
    seen.add(id);
    const levels=value.supported_reasoning_efforts??value.supported_reasoning_levels;
    const efforts=Array.isArray(levels)?levels.map((item:unknown)=>typeof item==='string'?item:(item as {effort?:string})?.effort).filter((effort:unknown):effort is ReasoningEffort=>REASONING_EFFORTS.includes(effort as ReasoningEffort)):undefined;
    models.push({ ...(efforts?{reasoningEfforts:efforts}:{}), id, name: validName(value.display_name) ? value.display_name : validName(value.name) ? value.name : id, providerId: provider.id,
      ...(validContextWindow(value.context_window) ? { contextWindow: value.context_window } : {}),
      // LiteLLM gateways publish max_input_tokens rather than context_window.
      // Kept as a separate field: an input cap is not a total context window.
      ...(validContextWindow(value.max_input_tokens) ? { maxInputTokens: value.max_input_tokens } : {}),
    });
  }
  for (const id of provider.models || []) if (validName(id) && !models.some(m => m.id === id)) models.push({ id, name: id, providerId: provider.id });
  return models.sort((a, b) => a.name.localeCompare(b.name));
}
