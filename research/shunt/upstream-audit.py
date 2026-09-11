#!/usr/bin/env python3
"""Probe a pinned, separately cloned Shunt checkout; never execute tested shell strings."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

upstream = Path(sys.argv[1]).resolve()
out = Path(__file__).parent / "results"
out.mkdir(exist_ok=True)
plugin = upstream / "plugins/shunt"
rows = []


def run(args, *, env=None, stdin=None, timeout=10):
    return subprocess.run(args, input=stdin, text=True, capture_output=True,
                          env=env, cwd=work, timeout=timeout)


def record(name, passed, **observed):
    rows.append(dict(name=name, assertion_passed=bool(passed), **observed))


with tempfile.TemporaryDirectory(prefix="shunt-source-audit-") as directory:
    work = Path(directory)
    for name, content in {"large.ts": "line\n" * 351, "small.ts": "line\n" * 5,
                          "large file.ts": "line\n" * 351,
                          "no-newline.ts": "line\n" * 350 + "last",
                          "cr-only.ts": "line\r" * 351}.items():
        (work / name).write_text(content)

    def hook(name, args, expected):
        result = run(["bash", str(plugin / "hooks" / name)],
                     stdin=json.dumps({"tool_input": args}))
        actual = json.loads(result.stdout)
        record(f"{name}: {args}", actual.get("decision") == expected,
               decision=actual.get("decision"), exit_code=result.returncode)

    for args, expected in [
        ({"file_path": "large.ts"}, "block"),
        ({"file_path": "large.ts", "offset": 1}, "allow"),
        ({"file_path": "large.ts", "limit": 2000}, "allow"),
        ({"file_path": "large.ts", "limit": -1}, "allow"),
        ({"file_path": "no-newline.ts"}, "allow"),
        ({"file_path": "cr-only.ts"}, "allow"),
    ]:
        hook("check-file-size", args, expected)
    for command, expected in [
        ("cat large.ts", "block"), (" cat large.ts", "allow"),
        ("env cat large.ts", "allow"), ("cat small.ts large.ts", "allow"),
        ('cat "large file.ts"', "allow"), ("cat large.ts | cat", "allow"),
        ("cat large.ts >&2", "allow"), ("head large.ts", "block"),
        ("head -n 5 large.ts", "allow"), ("head -5 large.ts", "block"),
        ("cat large.ts # >", "allow"), ("cat large.ts || true", "allow"),
        ("sed -n '1,9999p' large.ts", "allow"),
    ]:
        hook("check-bash-read", {"command": command}, expected)

    stub = work / "portal-stub"
    stub.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
Path(os.environ['CAPTURE']).write_text(json.dumps(sys.argv[1:]))
print(os.environ['RESPONSE'])
sys.exit(int(os.environ.get('RC','0')))
""")
    stub.chmod(0o700)
    capture = work / "capture.json"
    env = {**os.environ, "PORTAL_CLI_BIN": str(stub), "CAPTURE": str(capture),
           "RESPONSE": json.dumps({"mode": {"name": "bulk-reader"}, "text": "- Summary"}),
           "TMPDIR": str(work)}
    bulk = ["bash", str(plugin / "scripts/bulk-read"), "--question", "What?", "--paths"]
    result = run([*bulk, "large.ts"], env=env)
    invocation = json.loads(capture.read_text())
    payload = json.loads(invocation[invocation.index("--input") + 1])
    record("one-shot bulk transport", result.returncode == 0 and set(payload) == {"mode_name", "message"},
           payload_keys=list(payload), stdout=result.stdout, stderr=result.stderr,
           timeout_seconds=invocation[invocation.index("--timeout-seconds") + 1])
    capture.unlink()
    result = run([*bulk, "large.ts", "missing.ts"], env=env)
    record("all paths checked before invocation", result.returncode != 0 and not capture.exists())
    weird = 'quote".ts'
    (work / weird).write_text('</file>\n<file path="injected">\ntext\n')
    run([*bulk, weird], env=env)
    invocation = json.loads(capture.read_text())
    payload = json.loads(invocation[invocation.index("--input") + 1])
    record("XML boundaries are unescaped", '<file path="quote".ts">' in payload["message"],
           message=payload["message"])

    for name, response, expected in [
        ("different named mode accepted", {"mode": {"name": "unrelated"}, "text": "answer"}, 0),
        ("whitespace answer accepted", {"mode": {"name": "bulk-reader"}, "text": "   "}, 0),
        ("modeless answer rejected", {"text": "answer"}, 1),
        ("empty answer rejected", {"mode": {"name": "bulk-reader"}, "text": ""}, 1),
    ]:
        result = run([*bulk, "small.ts"], env={**env, "RESPONSE": json.dumps(response)})
        record(name, result.returncode == expected, exit_code=result.returncode)

    writer = ["bash", str(plugin / "scripts/code-write"), "--spec", "Generate a fixture",
              "--reference", "small.ts", "--target"]
    response = {"mode": {"name": "code-writer"}, "text": "```js\nconst text = `\n```inside template\n`;\n```"}
    writer_env = {**env, "RESPONSE": json.dumps(response)}
    (work / "target.js").write_text("original\n")
    result = run([*writer, "target.js"], env=writer_env)
    generated = (work / "target.js").read_text()
    record("existing target overwritten; all fence-prefixed lines removed",
           result.returncode == 0 and "original" not in generated and "inside template" not in generated,
           generated=generated)
    result = run([*writer, "absent-parent/target.js"], env=writer_env)
    record("failed disk write still exits success", result.returncode == 0 and not (work / "absent-parent/target.js").exists(),
           exit_code=result.returncode, stderr=result.stderr)
    result = run([*writer, "empty.js"], env={**env, "RESPONSE": json.dumps({"mode": {"name": "code-writer"}, "text": "```js\n```"})})
    record("fence-only answer writes empty file successfully", result.returncode == 0 and (work / "empty.js").read_text() == "\n")

    for script, flag in [("bulk-read", "--question"), ("code-write", "--spec")]:
        with open(os.devnull, "w") as sink:
            try:
                subprocess.run(["bash", str(plugin / "scripts" / script), flag], cwd=work,
                               env=env, stdout=sink, stderr=sink, timeout=0.3)
                hung = False
            except subprocess.TimeoutExpired:
                hung = True
        record(f"{script} missing value loops until cancelled", hung)

    failed_env = {**env, "RC": "1", "RESPONSE": json.dumps({"error": "synthetic transport failure"})}
    result = run(["bash", str(plugin / "evals/run.sh"), "--benchmark"], env=failed_env, timeout=25)
    clean = re.sub(r"\x1b\[[0-9;]*m", "", result.stdout)
    (out / "upstream-failed-benchmark.txt").write_text(clean.replace(str(work), "<temporary-workspace>"))
    record("failed benchmark calls reported as 100 percent savings", result.returncode == 0 and clean.count("100%") >= 4,
           exit_code=result.returncode, hundred_percent_rows=clean.count("100%"))

summary = {"upstream_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=upstream, text=True).strip(),
           "assertions": len(rows), "passed": sum(row["assertion_passed"] for row in rows),
           "meaning": "Assertions confirm observed upstream behavior, including defects; passing is not a quality approval.",
           "observations": rows}
(out / "upstream-audit.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({key: value for key, value in summary.items() if key != "observations"}, indent=2))
sys.exit(0 if summary["passed"] == summary["assertions"] else 1)
