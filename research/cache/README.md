# Anthropic conversation cache verification

`verify.ts` calls Litespeed's real streaming provider adapter through a configured LiteLLM gateway. It compares the previous system/tool-only cache behavior with the added conversation breakpoint, over both Chat Completions and native Anthropic Messages routes.

Each variant has a unique synthetic prefix above Haiku 4.5's caching minimum. The model calls a fixture reader three times, receives synthetic tool results, and finishes with `OK`. The harness checks the actual model-selected tool names and arguments, the final answer, and reported cache hits on subsequent requests. The baseline removes only conversation cache markers from the outgoing request; it preserves system/tool breakpoints. The test uses no project files, runs no model-generated shell commands, and does not modify settings or sessions.

This is an explicit, billable live test. Credentials are read into memory from your own configured provider, with an optional `.env` fallback. Output contains only the model ID, route, variant, step, token counts, duration, and correctness. It does not log credentials, gateway addresses, or user conversation history.

```sh
LITESPEED_CACHE_PROBE_DB=/absolute/path/to/litespeed.db \
LITESPEED_CACHE_PROBE_ENV=/optional/path/to/.env \
LITESPEED_CACHE_PROBE_PROVIDER=litellm \
LITESPEED_CACHE_PROBE_MODEL=claude-haiku-4-5-20251001 \
LITESPEED_CACHE_PROBE_OUTPUT=/tmp/litespeed-cache-results.json \
npx tsx research/cache/verify.ts
```

The gateway must expose the selected Claude model through both API formats. This harness opts that exact model ID into Anthropic caching, so it also supports an opaque Claude alias. It makes sixteen requests with an approximately 10K-token initial conversation. Shorter prompts, cache expiration, gateway routing, and provider configuration can change the outcome. A gateway that injects conversation cache markers itself may already show hits in the baseline. This experiment measures cache reuse, not dollar savings or a controlled latency benchmark.

Automated coverage also exercises real Runner file reads, growing multi-tool payloads, image attachments, empty tool results, signed thinking, input immutability, non-Anthropic request compatibility, API persistence/validation, browser settings, and the terminal editor. Run `npm run check`, `npm run test:e2e`, and `npm run test:tui:interactions` for those checks.

## Recorded live result

The [recorded run](results.json) completed all sixteen requests correctly through LiteLLM with Claude Haiku 4.5. Each cell below lists the three follow-up requests after the initial cache write.

| API route | Baseline cached input tokens | Fixed cached input tokens | Fixed follow-up input reused |
| --- | --- | --- | --- |
| Chat Completions | 0, 0, 0 | 10,442, 10,544, 10,641 | 99.0% |
| Anthropic Messages | 0, 0, 0 | 10,442, 10,540, 10,637 | 99.0% |

Initial requests had no cache hits, as expected. The small system and tool prefix was below the caching minimum; the long conversation made the missing history marker observable. This confirms cache reuse for these routes and this gateway, not universal savings for every model or session. Latency varied substantially during the run, so it is not a reliable speed comparison.
