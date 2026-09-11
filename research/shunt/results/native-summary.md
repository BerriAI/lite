# Native Shunt verification

Verified September 11, 2026, on the native integration branch. [Reproduction](../README.md#native-integration-evaluation) · [Per-trial results](native-results.json) · [Product guide](../../../docs/shunt.md).

## Paired live pilot

The actual Litespeed Runner, provider transport, tools, permissions, file history, worker workspaces and usage ledger ran 48 independent synthetic trials: six tasks × four architectures × Shunt off/on. All requests went through the configured LiteLLM gateway. The main model was `claude-haiku-4-5-20251001`, the worker `gemini/gemini-2.5-flash`, and the independently configured Shunt model `gemini/gemini-2.5-flash-lite`. Expert Fusion reverses the first two roles.

Read answers are checked against exact JSON key/value ground truth, including numeric types. Generation and edits run a separate Node assertion against the actual resulting module. A substring match is insufficient. The final scoring was also reapplied to saved answers without making new model calls.

| Measurement | Shunt off | Shunt on |
| --- | ---: | ---: |
| Tasks passing ground truth | 23 / 24 | 24 / 24 |
| Caller input tokens, summed across requests | 1,260,758 | 561,590 |
| Total input tokens, including Shunt | 1,260,758 | 808,081 |
| Output tokens | 34,245 | 16,620 |
| Model requests | 129 | 122 |
| Sum of trial elapsed time | 292 s | 191 s |

One off-mode Expert cross-file read returned an empty final answer. Excluding that entire pair leaves 23 pairs passing in both modes: caller input falls from 1,151,072 to 553,984 (52%), and total input from 1,151,072 to 800,475 (30%). These are aggregate request tokens, not peak context size or billed cost.

| Task, across four architectures | Caller input, off | Caller input, on |
| --- | ---: | ---: |
| Broad large-file read | 363,050 | 63,374 |
| Cross-file read | 308,729 | 57,165 |
| Small targeted read | 92,869 | 37,779 |
| Small generation | 133,818 | 178,536 |
| Exact edit | 129,876 | 133,888 |
| Debugging read | 232,416 | 90,848 |

The broad-read case used 83% less caller input. The targeted-read difference is **not attributable to Shunt**: those runs made no Shunt requests and the agents chose different execution paths. Small generation and exact edits increased usage. The pilot contains 11 successful reader calls and one rejected writer attempt. In that attempt the worker supplied inline source instead of a reference path, recovered with an ordinary write, and passed the file assertion. The schema now explicitly says the reference is a file path and rejects multiline paths before file access.

## Writer and baseline follow-ups

Eight additional generation trials, paired across all four architectures, passed their file assertions. With Shunt enabled, Single, Sidekick and Team actually used successful Shunt writers; the Expert chose a reader and wrote directly. A follow-up explicitly carried the writer requirement into the Expert assignment and verified a successful Shunt-generated file and test run. Thus actual writer execution and integration were observed in all four architectures.

The four-run Expert follow-up also repeated cross-file reading. Its off-mode baseline again returned an empty final answer, while on-mode passed without selecting Shunt. This remains a baseline behavior, not a demonstrated Shunt fix. Across all 60 live trials, 58 passed; the two failures were these off-mode empty responses. All 30 enabled trials passed their fixture assertions, but several did so with ordinary tools.

The extra writer experiment increased total input from 161,167 to 249,624 and elapsed time from 61 to 79 seconds. A tiny generated fixture is a poor savings benchmark. The writer remains optional and agent-selected.

## Deterministic and interface checks

The regression suite checks disabled wire behavior, fresh isolated requests and root session accounting, 350/351-line boundaries, explicit ranges and bypass reasons, complete-source limits, invalid UTF-8, protected files, symlinks and hardlinks, context-fit rejection, model failure, missing completion markers, truncated generation, cancellation, and late streaming updates.

It also checks real source/write approval and denial, hooks, intervening target edits, generated-content review, change receipts and Undo, configuration revisions, imports starting off, and private worker integration in Sidekick/Team/Expert. Browser tests exercise collapsed Advanced settings, independently selected models, mobile layout, inline root/parallel-worker results during streaming, and reloads. An owned native PTY checks onboarding, live worker attribution, inline Shunt results and narrow/wide layouts. The complete browser suite and the repository typecheck/unit/build checks are run before submission; command results are recorded in the PR.

## Limits of these results

This is a small, synthetic, single-sample pilot per task/architecture/mode. Models choose different tools and numbers of requests; cache state was not controlled. Cache token counts are retained in the results, but the gateway did not report dollar costs. Runtime sums are not a simultaneous wall-clock benchmark. No general claim of 90% lower total usage, latency, cost, or perfect correctness follows from this experiment. Spotify's reported context reduction is an attributed upstream result, not the measured outcome for every Litespeed task.

The product adapts the public reader/writer mechanism to Litespeed's permissions and transport. It does not reproduce private Portal/AiKA infrastructure. The final code keeps provider-default sampling, uses bounded sources/outputs, and adds strict completion and conflict checks. The pilot predates the final wording, accounting-start, model-default and clipboard refinements; those refinements are covered by deterministic/interface checks rather than rerunning every billed trial.
