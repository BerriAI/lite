# Shunt research harness

Research only. Nothing here is imported by the product or enabled in an existing session. See [the design proposal](../../docs/design-shunt.md) for findings, integration boundaries, and open decisions.

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

Repeat with `SHUNT_RESEARCH_REAL_CODE=1` to run the real-source cases. Omit `SHUNT_RESEARCH_ENV_FILE` when the configured provider already has its key. `SHUNT_RESEARCH_PROVIDER` defaults to `litellm`. The gateway adapter is deliberately separate from `server/providers.ts`: it uses nonstreaming OpenAI-compatible requests to control temperature and output bounds, capabilities the production adapter does not currently expose. This is not a Portal backend reproduction or production UI E2E.

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

The observed results do not establish general correctness, dollar savings, an identical private model runtime, or production readiness. The proposal specifies the remaining native integration, UI, fault-injection, and live-quality acceptance matrix.

The checked-in result files are historical evidence from the repository before the Litespeed rename. Original transcripts and measured values are preserved verbatim.
