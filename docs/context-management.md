# Context management

Speedrail keeps a task running across multiple context windows. Tool results are bounded, older results can be pruned from the next request, and completed work can be summarized without ending the current turn. The original transcript is archived and local usage accounting is retained.

## Defaults

| Control | Speedrail behavior |
| --- | --- |
| Model steps | No fixed ceiling for the driver, sidekick, workers, experts, or researchers. Cancellation, repeated-failure guards, worker stall detection, and provider limits still apply. |
| Automatic compaction | On. Uses an exact-model context override, then discovered catalog limits, then a labeled 200,000-token planning fallback. Reserves output space before triggering. |
| Input measurement | UTF-8 text estimate, corrected conservatively with the last matching provider-reported input count. Corrections do not cross provider/configuration changes or history rewrites. Images and opaque state remain uncertain. |
| Long active turns | Preserve the original user message, delivered steering, and a recent complete continuation. Summarize earlier completed work within the same turn. Successful progress permits another compaction later. |
| Stalled models and workers | Ten minutes without model/tool progress. New progress resets the timer; worker approval waits pause it. There is no total-duration cap for an actively progressing provider response or worker. |
| Recovery | Prune older tool results first when useful. A rejected request can try pruning and summarization; an unsuccessful summary does not loop indefinitely. Partial provider responses are never automatically replayed. |
| File reads | Default and maximum 2,000 lines per call, 256 KiB of selected content, and a 32 KiB UTF-8 preview with a paging receipt when needed. Later line ranges can start beyond the first 256 KiB of a file. Scanning to an offset is bounded to 32 MiB and five seconds. |
| Bash results | 30,000 characters in the preview, with a stored-output receipt when needed. The process collector has its own byte limit. |
| Web fetch | 256 KiB network-body limit and a 50,000-character text preview. HTML is converted to text. Redirects, destination checks, timeout, and cancellation remain enforced. |
| Connected tools | 100,000 UTF-8 bytes of sanitized text, approximately 25,000 tokens under the text heuristic. This is not a provider tokenizer guarantee. |
| Memory | On unless explicitly disabled. Local workspace notes may be saved and updated automatically. Explicit Ask/Deny rules take precedence; Plan mode cannot write memory. Children do not receive the root's memory tools. |
| Session accounting | `x-litellm-session-id` is the root session ID on model requests, including worker, compaction, and review calls. The ID survives additional turns and compaction. |

Use `/context` to inspect the saved context estimate, and provider model settings to supply the real context window when a gateway alias does not expose it. A planning fallback cannot make a smaller model accept 200,000 tokens. A single enormous user message or indivisible tool group may still require smaller inputs.

## What was missing

Previously, the driver stopped after 40 steps by default and workers had additional step ceilings. Automatic summarization required a discovered context limit, ran at most once per turn, and protected the entire active turn. A sufficiently long single task therefore could not make room even when almost all its context came from completed tool work. Token budgeting used only a text estimate. Memory started off, and model calls lacked a stable LiteLLM session header.

File reads also always loaded the first 256 KiB before applying the requested line offset. A request for a later range could never reach it. Some preview limits counted characters while describing their size as bytes.

## Comparison with other harnesses

This audit was performed on September 10, 2026. These are verified behaviors, not a claim that Speedrail reproduces another harness's private implementation.

### Claude Code

The official CLI reference states that agentic turns have no limit by default. Session persistence is enabled unless explicitly disabled. Speedrail now follows those defaults. [CLI reference](https://code.claude.com/docs/en/cli-reference).

Claude Code's automatic compaction window depends on the model, context configuration, and gateway. The documented cases include 200K-window sessions and roughly 967K-token compaction for native 1M sessions. Custom gateway aliases can require an explicit window override. Therefore, one universal 200K trigger would not reproduce its behavior. Speedrail uses provider limits and an output reservation; its unknown-model fallback and reservations are explicit planning policy, not Anthropic's model-specific tuning. [Model configuration](https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds).

Auto memory is enabled by default. Claude Code uses a project memory directory and loads a bounded index, with detailed topic files read on demand. Speedrail retains its existing workspace-scoped SQLite facts, bounded recall, and Settings editor; changing the default does not migrate or overwrite existing notes. [Memory documentation](https://code.claude.com/docs/en/memory#auto-memory).

The installed Claude Code **2.1.268** MCP server was queried for its real tool definitions using `claude mcp serve`, without making model calls. Read advertises a 2,000-line default; Bash declares a 30,000-character result limit; WebFetch declares 50,000 characters, a small-model extraction step, and a 15-minute cache. Synthetic Read calls showed that the MCP endpoint can return more than 2,000 lines and can truncate by its token cap. The advertised default is consequently not proof of a strict runtime line ceiling. No proprietary implementation or prompt text was copied into Speedrail.

Claude Code documents a 25,000-token default MCP output limit and a warning above 10,000 tokens. Speedrail's connected-tool byte budget approximates that size; its tokenizer and warning behavior are not identical. [MCP output limits](https://code.claude.com/docs/en/mcp#mcp-output-limits-and-warnings).

Claude Code also reloads several kinds of context after compaction, including root instructions and memory. It can re-read recent files and re-inject invoked skill bodies within separate caps. Speedrail keeps its captured instructions, active profile, and memory envelope available, but does not implement that same file-refresh and skill-reinjection algorithm. Its bounded summary source may omit excerpts, and the summary explicitly records uncertainty. [What survives compaction](https://code.claude.com/docs/en/context-window#what-survives-compaction).

**Remaining differences:** Speedrail's WebFetch returns bounded text rather than automatically paying a small model to extract an answer. The proposed Shunt integration should make that model-selection and extraction policy explicit. Its memory format, tool tokenizer, summary prompt, post-compaction refresh behavior, and per-model tuning are also distinct. Matching the useful defaults does not mean these systems are interchangeable.

### Codex

Codex exposes a model-specific automatic compaction threshold, an explicit context-window override, and a separate tool-output token budget. Its reference also describes a configurable skill-catalog budget and separate memory generation/use controls. Speedrail now has the basic long-turn continuation behavior, but does not implement every configurable context policy exposed by Codex. [Official configuration reference](https://developers.openai.com/codex/config-reference).

### OpenCode

The inspected OpenCode revision uses reported input/output/cache usage to detect overflow, reserves model output capacity, and can preserve a bounded recent continuation within a turn. Its pruning implementation protects a recent tool-output token budget and prunes only when enough older output can be removed. Speedrail's pruning instead keeps head/tail excerpts and its recent continuation; its constants and algorithm are different. Sources pinned to revision `dac2198b90a999353a33c4f91655e0ff99a204dd`: [overflow accounting](https://github.com/sst/opencode/blob/dac2198b90a999353a33c4f91655e0ff99a204dd/packages/opencode/src/session/overflow.ts), [compaction and pruning](https://github.com/sst/opencode/blob/dac2198b90a999353a33c4f91655e0ff99a204dd/packages/opencode/src/session/compaction.ts).

## LiteLLM session cost

Conversation persistence and gateway billing attribution are separate. Speedrail already stored conversations locally; the missing piece was a stable gateway identifier. LiteLLM's request preprocessing recognizes `x-litellm-session-id` for session/trace grouping. All related Speedrail model calls now use the root session ID. A new session or fork gets a distinct ID. Existing historical gateway calls cannot be retroactively relabeled by this change. Gateway log retention and model pricing configuration still determine which costs appear. [LiteLLM request preprocessing](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/litellm_pre_call_utils.py).

## Verification

The continuation integration test drives a real HTTP/SSE provider fixture through 70 tool steps, multiple compactions, steering, a follow-up turn, and a separate session. It checks the retained user request, complete tool/result groups, stable request headers, and undo availability. Additional regressions cover provider-usage calibration, opt-out persistence, Unicode truncation and paging, later file ranges, compaction failure/cancellation, and sidekick error propagation. These deterministic tests verify orchestration; they do not prove lossless model-generated summaries.
