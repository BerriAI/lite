import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamCompletion, type ProviderMessage } from '../server/providers.js';
import type { Provider, ToolDefinition } from '../shared/types.js';

const ephemeral = { type: 'ephemeral' };
const tool: ToolDefinition = { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } } };
const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } });
const provider: Provider = { id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-key' };
afterEach(() => vi.unstubAllGlobals());
function capture(kind: Provider['kind']) {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const event = kind === 'anthropic' ? { type: 'message_stop' } : { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  }));
  return bodies;
}
async function run(messages: ProviderMessage[], kind: Provider['kind'], model = 'claude-fixture', patch: Partial<Provider> = {}) {
  for await (const _ of streamCompletion({ provider: { ...provider, kind, ...patch }, model, system: 'Stable system', messages, tools: [tool], signal: new AbortController().signal })) { /* drain */ }
}
function frozen<T>(value: T): T {
  const stack: any[] = [value];
  while (stack.length) { const current = stack.pop(); if (current && typeof current === 'object' && !Object.isFrozen(current)) { stack.push(...Object.values(current)); Object.freeze(current); } }
  return value;
}

describe.each(['anthropic', 'openai'] as const)('%s conversation caching', kind => {
  it('moves the history breakpoint through growing multi-tool conversations without modifying stored messages', async () => {
    const bodies = capture(kind), history: ProviderMessage[] = [{ role: 'user', content: 'Inspect the project' }];
    for (let step = 0; step < 3; step++) {
      const snapshot = frozen(structuredClone(history));
      await run(snapshot, kind);
      expect(snapshot).toEqual(history);
      const body = bodies[step];
      const count = JSON.stringify(body).match(/"cache_control"/g)?.length;
      expect(count).toBe(kind === 'anthropic' ? 3 : 2);
      if (step === 0) expect(body.messages.at(-1).content.at(-1).cache_control).toEqual(ephemeral);
      else if (kind === 'anthropic') {
        const results = body.messages.at(-1).content;
        expect(results.map((part: any) => part.cache_control)).toEqual([undefined, ephemeral]);
        expect(results.at(-1).tool_use_id).toBe(`second-${step - 1}`);
      } else {
        expect(body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: `second-${step - 1}`, cache_control: ephemeral });
        expect(body.messages.at(-2)).not.toHaveProperty('cache_control');
      }
      history.push({ role: 'assistant', content: null, tool_calls: [call(`first-${step}`), call(`second-${step}`)] },
        { role: 'tool', tool_call_id: `first-${step}`, content: `First result ${step}` }, { role: 'tool', tool_call_id: `second-${step}`, content: `Second result ${step}` });
    }
    const strip = (body: any) => {
      const value = JSON.parse(JSON.stringify(body, (key, value) => key === 'cache_control' ? undefined : value));
      for (const message of value.messages) if (message.role === 'user' && typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }];
      return value;
    };
    for (let i = 1; i < bodies.length; i++) {
      const before = strip(bodies[i - 1]).messages, after = strip(bodies[i]).messages;
      expect(after.slice(0, before.length)).toEqual(before);
    }
  });

  it('marks only the final image content block and preserves attachments', async () => {
    const bodies = capture(kind);
    const messages = frozen<ProviderMessage[]>([{ role: 'user', content: [
      { type: 'text', text: 'Compare these' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: '' },
    ] }]);
    await run(messages, kind);
    const parts = bodies[0].messages.at(-1).content;
    expect(parts[0]).not.toHaveProperty('cache_control');
    expect(parts[1].cache_control).toEqual(ephemeral);
    expect(parts[1].type).toBe(kind === 'anthropic' ? 'image' : 'image_url');
    expect(JSON.stringify(messages)).not.toContain('cache_control');
  });

  it('marks the outer multimodal tool result including empty results, never inner image or text parts', async () => {
    const bodies = capture(kind);
    for (const content of [[{ type: 'text', text: 'Screenshot' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }], '']) {
      await run(frozen([{ role: 'assistant', content: null, tool_calls: [call('image')] }, { role: 'tool', tool_call_id: 'image', content }]), kind);
      const message = bodies.at(-1).messages.at(-1), result = kind === 'anthropic' ? message.content[0] : message;
      expect(result.cache_control).toEqual(ephemeral);
      expect(JSON.stringify(result.content)).not.toContain('cache_control');
    }
  });

  it('skips empty user suffixes and signed assistant thinking without altering signatures', async () => {
    const bodies = capture(kind), signed = { type: 'thinking', thinking: 'Internal state', signature: 'signature-fixture' };
    const messages = frozen<ProviderMessage[]>([
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Answer', providerMetadata: { providerId: provider.id, model: 'claude-fixture', anthropicThinking: [signed], thinking_blocks: [signed] } },
      { role: 'user', content: '' },
    ]);
    await run(messages, kind);
    expect(bodies[0].messages.find((message: any) => message.role === 'user').content[0].cache_control).toEqual(ephemeral);
    const assistant = bodies[0].messages.find((message: any) => message.role === 'assistant');
    expect(kind === 'anthropic' ? assistant.content[0] : assistant.thinking_blocks[0]).toEqual(signed);
    expect(JSON.stringify(messages)).not.toContain('cache_control');
  });

  it('handles empty or assistant-only history without placing invalid markers', async () => {
    const bodies = capture(kind);
    for (const messages of [[], [{ role: 'assistant' as const, content: 'Continuation' }]]) await run(messages, kind);
    for (const body of bodies) expect(JSON.stringify(body.messages.filter((message: any) => message.role !== 'system'))).not.toContain('cache_control');
  });
});

it('opts exact configured Claude aliases in and keeps unrelated OpenAI requests unchanged', async () => {
  const bodies = capture('openai');
  const messages: ProviderMessage[] = [{ role: 'user', content: 'Inspect' }, { role: 'assistant', content: null, tool_calls: [call('one')] }, { role: 'tool', tool_call_id: 'one', content: 'Result' }];
  for (const [model, patch] of [
    ['coding-alias', { anthropicCacheModels: ['coding-alias'] }], ['coding-alias', {}],
    ['coding-alias-other', { anthropicCacheModels: ['coding-alias'] }], ['gpt-fixture', {}], ['gemini-fixture', {}],
  ] as [string, Partial<Provider>][]) await run(frozen(structuredClone(messages)), 'openai', model, patch);
  expect(bodies[0].messages.at(-1).cache_control).toEqual(ephemeral);
  for (const body of bodies.slice(1)) {
    expect(body.messages).toEqual([{ role: 'system', content: 'Stable system' }, ...messages]);
    expect(JSON.stringify(body)).not.toContain('cache_control');
  }
});
