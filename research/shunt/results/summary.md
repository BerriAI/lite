# Shunt live experiment results

Two independent trials per variant, using Claude Haiku 4.5 as driver and Gemini 2.5 Flash as worker through the configured gateway. Temperature 0.2; eight-step research-loop bound; not production Speedrail UI E2E. Input/output are provider-reported totals across all calls, including repeated corpus sends. Costs are unknown. Warm worker caches may affect timings.

| Case | Off/on factual passes | Mean driver input, off → on | Driver input reduction | Mean total input + output, off → on | Mean seconds, off → on |
| --- | --- | --- | --- | --- | --- |
| large-read | 2/2 · 2/2 | 20162 → 3353 | 83.4% | 20322 → 21421 | 4.61 → 5.07 |
| cross-file-read | 2/2 · 2/2 | 38369 → 3789 | 90.1% | 38668 → 38986 | 4.83 → 9.71 |
| targeted-read | 2/2 · 2/2 | 1718 → 2167 | -26.1% | 1910 → 2359 | 2.93 → 2.65 |
| code-write | 2/2 · 2/2 | 2791 → 3496 | -25.2% | 3103 → 4070 | 4.11 → 8.50 |
| provider-implementation | 2/2 · 2/2 | 13760 → 4222 | 69.3% | 14144 → 21266 | 6.29 → 11.79 |
| provider-and-file-tools | 0/2 · 2/2 | 45961 → 4135 | Not a valid quality-matched comparison | 46223 → 192284 | 4.92 → 16.08 |

22/24 final factual checks passed across 81 recorded requests (including the separate direct-writer request). These are not 24 successful production E2E tests.

- provider-and-file-tools/off/1: failed (Unexpected output target.). No savings claim is made for this pair.
- provider-and-file-tools/off/2: failed (Unexpected output target.). No savings claim is made for this pair.

The initial smoke run is excluded. Its JSON parser treated explanatory prose as a failed fact check, and identical prompts likely reused gateway responses. It also recorded the driver sometimes choosing ordinary write_file rather than code_write. The final nonce-bearing synthetic runs chose code_write; that does not establish reliable writer routing for all tasks.

The real-code multi-file reader resent both files for five separate questions in each on trial. The baseline attempted to write an answer to an unrequested path and was stopped by the harness. Thus that pair demonstrates failure modes, not a valid savings estimate. Reader input reduction can coexist with much higher total usage. One single-file on trial made a second reader request to verify a field that could have been checked with a targeted read.

Generated synthetic modules were loaded and checked against exact expected properties. The separate direct writer also passed. No claim is made about generated production tests, arbitrary edits, debugging, private Portal behavior, cold latency, or dollar savings.
