# Shunt research harness

Evaluation scripts are separate from the product. The native integration is now available, off by default: see [Shunt](../../docs/shunt.md) and the [native verification report](results/native-summary.md). The older probes below preserve the research that informed this implementation.

The source reference is Spotify’s Apache-2.0 plugin at `3c24ca30ff63e1f5bbad1c43fe5324daff579123`. The article-linked fork is pinned separately in the proposal. The scripts below run against a separate clone; they do not install a plugin, authenticate to Portal, or modify the main checkout.

## Reproduce local probes

Use the repository’s supported Node version, its locked dependencies, Python 3, Bash, and jq. In a disposable directory, clone the reference and pin it:

```sh
git clone https://github.com/spotify/portal-ai-plugins.git /tmp/shunt-reference
git -C /tmp/shunt-reference checkout 3c24ca30ff63e1f5bbad1c43fe5324daff579123
bash /tmp/shunt-reference/plugins/shunt/evals/run.sh
python3 research/shunt/upstream-audit.py /tmp/shunt-reference
node --import tsx research/shunt/runner-probe.ts /tmp/shunt-reference
```

`upstream-audit.py` uses temporary synthetic files and a stub Portal command. It sends shell command strings to hooks for classification; it never executes those strings. Assertions intentionally reproduce defects. Its benchmark-failure probe confines generated files and TMPDIR to a fresh temporary directory. `runner-probe.ts` uses the real Litespeed Runner/Store against a loopback mock provider and disposable state.

## Reproduce the live experiment

This makes real, potentially billed calls to the selected gateway. Set an explicit read-only settings database path and, only if credentials are supplied through it, an environment-file path. The harness loads the chosen key in memory and never prints it or copies it into results. Only synthetic fixtures and the tracked `server/providers.ts` / `server/tools.ts` sources are sent. The live harness is not a general permission-safe tool host and must not be exposed as a product tool.

```sh
SHUNT_RESEARCH_LIVE=1 \
SHUNT_RESEARCH_SETTINGS_DB=/absolute/path/to/.litespeed/litespeed.db \
SHUNT_RESEARCH_ENV_FILE=/absolute/path/to/.env \
SHUNT_RESEARCH_DRIVER=claude-haiku-4-5-20251001 \
SHUNT_RESEARCH_WORKER=gemini/gemini-2.5-flash \
SHUNT_RESEARCH_REPEATS=2 \
node research/shunt/live-eval.mjs /tmp/shunt-reference
```

Repeat with `SHUNT_RESEARCH_REAL_CODE=1` to run the real-source cases. Omit `SHUNT_RESEARCH_ENV_FILE` when the configured provider already has its key. `SHUNT_RESEARCH_PROVIDER` defaults to `litellm`. The gateway adapter is deliberately separate from `server/providers.ts`: it uses nonstreaming OpenAI-compatible requests to control temperature and output bounds, independently of the production adapter. This is not a Portal backend reproduction or production UI E2E.

The bounded agent chooses native read/write versus the new tools. Reader/writer calls execute the **unmodified** upstream scripts with `PORTAL_CLI_BIN` pointing to `gateway-bridge.mjs`. The bridge translates the mode name into the published prompt and selected worker model. It implements neither AiKA processors nor mode lookup/ownership semantics. No external model tools are available to the one-shot worker.

Results overwrite this harness’s prior result files. They contain fixture prompts/answers and code, never credential headers or database contents. `results/initial/` retains the first smoke experiment, including strict-format scoring errors and repeated identical prompts, and is excluded from reported comparisons. Current scoring independently checks the requested values; `jsonOnly` additionally records whether a final answer included prose. Requests contain unique trial IDs but worker prompts may reuse cached context; timings must not be presented as cold-start latency.

## Evidence files

- [Summary](results/summary.md): comparison table and limitations.
- [Upstream edge cases](results/upstream-audit.json): 32 independently reproduced behaviors.
- [Failed benchmark](results/upstream-failed-benchmark.txt): upstream reports 100% savings when all benchmark requests fail.
- [Runner probe](results/runner-probe.json): off, copied hook, exit-code adapter, and targeted-read comparison.
- [Synthetic live cases](results/live-eval.json) and [real-source live cases](results/real-code/live-eval.json): complete factual checks and tool sequences.
- [Direct writer](results/direct-writer.json): real worker output written and loaded successfully, independent of driver routing.
- `live-requests.jsonl` in each result directory: raw fixture/model exchanges and provider usage for independent audit.

The observed results do not establish general correctness, dollar savings, an identical private model runtime, or production readiness. The native report below records the integration, UI, fault-injection, and live-quality verification.

The older upstream-harness result files are historical evidence from the repository before the Litespeed rename. Original transcripts and measured values are preserved verbatim.

## Native integration evaluation

`native-eval.ts` uses the actual Runner and streaming provider adapter in disposable workspaces with synthetic sources. It does not change saved application settings. It sends real, billable requests and runs fixture code with automatic tool permissions. Run it only against the selected test gateway:

```sh
SHUNT_RESEARCH_LIVE=1 \
SHUNT_RESEARCH_SETTINGS_DB=/absolute/path/to/.litespeed/litespeed.db \
SHUNT_RESEARCH_ENV_FILE=/absolute/path/to/.env \
node --import tsx research/shunt/native-eval.ts
```

The defaults run six tasks × four architectures × off/on, with two trials at once and a three-minute cancellation bound per trial. Override `SHUNT_RESEARCH_DRIVER`, `SHUNT_RESEARCH_WORKER`, and the independent `SHUNT_RESEARCH_SHUNT` model if needed. `SHUNT_RESEARCH_LIMIT` caps the pilot at 1–48 trials. Optional comma-separated `SHUNT_RESEARCH_CASES` and `SHUNT_RESEARCH_ARCHITECTURES` select a subset. `SHUNT_RESEARCH_FORCE_WRITER=1` makes generation prompts explicitly request the writer and carry that requirement into worker assignments. `SHUNT_RESEARCH_OUTPUT` selects a result JSON path.

The [60-trial record](results/native-results.json) combines the paired pilot, writer trials and Expert follow-up. It retains exact final answers, file assertion outcomes, request counts, role counts, cache reports and usage totals; transient request/session UUIDs are omitted. Read answers are rescored by `scoring.ts`; generation is checked on disk by a separate Node assertion during the run. To summarize fresh raw results:

```sh
node --import tsx research/shunt/summarize-native.ts research/shunt/results/native-pilot.json
```

This overwrites `results/native-results.json`. Pass additional result files to retain multiple experiments. See [the report](results/native-summary.md) for failures and limits, including the distinction between caller context, total tokens and cost.
