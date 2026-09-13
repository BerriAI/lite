# Connecting providers

Open **Settings → Providers** in the web app or terminal to add a provider, save it, and test the connection. Then open **Models** to select its models.

## Providers and subscriptions

**LiteLLM:** Connect any model or routing alias your proxy exposes. Use **Set up Litespeed** in either client to enter the gateway base URL and API key (a virtual key or gateway key). Litespeed verifies model access before saving. New installs do not assume a gateway address. You can also set `LITELLM_BASE_URL` and `LITELLM_API_KEY` in `.env`, or configure them in Settings. Model discovery uses the provider's actual model endpoint; you can also enter a model ID manually.

**API keys:** OpenAI-compatible providers and native Anthropic are supported. Keys are never returned to the browser. Local credential storage is protected by filesystem permissions; it is not encrypted at rest.

**ChatGPT:** Connection uses an explicit browser/device login. Availability depends on account settings, subscription, and provider policies. This is a compatibility integration, not a promise of provider endorsement or perpetual access. No credentials are imported from another application's storage. Device login may need to be enabled in account/workspace security settings.

**Claude subscriptions:** Third-party subscription login/routing is not supported. Use a native API key or a supported provider through LiteLLM instead.

## Native Anthropic output limit

Native Anthropic requests default to **8,192 output tokens per model call**. Large file writes can exhaust this limit while generating a tool's arguments. Litespeed reports an output-limit error and does not execute the incomplete tool calls; resuming with the same limit can fail again.

For models that support a larger response, set the server's `LITESPEED_ANTHROPIC_MAX_TOKENS` environment variable, for example:

```sh
LITESPEED_ANTHROPIC_MAX_TOKENS=32768 litespeed serve
```

Restart an already-running server with the new environment. You can also set this variable in the server's `.env`. Unset or blank values keep the 8,192-token default; other values must be positive whole numbers within the selected model's supported output range. The same value is reserved during context budgeting. Calls with an explicit output limit, such as Shunt generation, keep that limit. This setting applies only to native Anthropic connections; it does not cap OpenAI-compatible or ChatGPT requests.

For benchmark runs, record the configured limit and distinguish output-limit failures from completed quality evaluations. See [Anthropic's guidance on truncated tool calls](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons#max_tokens).

## Prompt caching

Litespeed automatically requests Anthropic prompt caching for native Anthropic connections and Claude/Anthropic model names behind LiteLLM. Each request marks the end of the current user message or tool results, so later steps can reuse the growing conversation. Native requests also retain system and final-tool-schema breakpoints; the OpenAI-compatible route retains its system breakpoint. Markers are added to outgoing copies, not saved conversation history, and never to signed thinking blocks.

If LiteLLM exposes Claude under an opaque name such as `team/coding`, add that exact ID under **Settings → Providers → Claude caching aliases** in the web app or terminal. Leave this list empty for providers that do not route to Claude. This setting adds caching hints; it does not change gateway routing or add model access. Other OpenAI-compatible models keep their existing request format.

The default cache lifetime is five minutes. Cache hits require a sufficiently long, identical prefix and provider support. Changing earlier instructions, tools, models, or compacting history can cause a miss. Anthropic searches a bounded lookback window, so unusually large additions can also miss an earlier cache entry. Caching reduces repeated input processing; it does not guarantee a particular bill or latency. Litespeed reports provider-returned cached token usage when available.

See [Anthropic's prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [LiteLLM's Anthropic integration](https://docs.litellm.ai/docs/providers/anthropic). The [live verification harness](../research/cache/README.md) compares the old and fixed request paths using synthetic tool conversations.

[Back to Litespeed](../README.md)
