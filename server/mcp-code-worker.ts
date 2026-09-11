import { parentPort, workerData } from 'node:worker_threads';
import ts from 'typescript';
import { getQuickJS, type QuickJSDeferredPromise } from 'quickjs-emscripten';
import type { MCP_CODE_LIMITS } from './mcp-code.js';

const port = parentPort!;
const { code, names, limits } = workerData as { code: string; names: string[]; limits: { [K in keyof typeof MCP_CODE_LIMITS]: number } };
const engine = await getQuickJS();
const runtime = engine.newRuntime();
runtime.setMemoryLimit(limits.memoryBytes);
runtime.setMaxStackSize(512 * 1024);
let spent = 0, sliceStart = performance.now(), done = false, nextId = 0, output = '';
runtime.setInterruptHandler(() => spent + performance.now() - sliceStart > limits.cpuMs);
const vm = runtime.newContext();
const pending = new Map<number, QuickJSDeferredPromise>();
const append = (text: string) => {
  if (Buffer.byteLength(output) >= limits.outputBytes) return;
  output += text + '\n';
};
function finish(error?: string) {
  if (done) return; done = true;
  const bytes = Buffer.from(output), truncated = bytes.length > limits.outputBytes;
  let end = limits.outputBytes;
  if (truncated) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  port.postMessage({ type: 'done', ...(error ? { error: error.slice(0, 2000) } : { output: truncated ? bytes.subarray(0, end).toString('utf8') + '\n[Output truncated; return a smaller summary.]' : output || 'Script completed without output.' }) });
}
function evaluate(source: string) {
  sliceStart = performance.now();
  const result = vm.evalCode(source, 'mcp-workflow.js');
  spent += performance.now() - sliceStart;
  if (result.error) { const error = vm.dump(result.error); result.error.dispose(); throw new Error(error?.message ?? 'TypeScript execution failed.'); }
  result.value.dispose();
}
function pump() {
  sliceStart = performance.now();
  const result = runtime.executePendingJobs();
  spent += performance.now() - sliceStart;
  if (result.error) { const error = vm.dump(result.error); result.error.dispose(); finish(error?.message ?? 'TypeScript execution failed.'); }
  else if (!done && !pending.size) finish('Script is waiting on a promise that cannot resolve.');
}

try {
  vm.newFunction('__call', (name, args) => {
    const id = ++nextId;
    const deferred = vm.newPromise(); pending.set(id, deferred);
    port.postMessage({ type: 'call', id, name: vm.getString(name), args: vm.getString(args) });
    return deferred.handle;
  }).consume(handle => vm.setProp(vm.global, '__call', handle));
  vm.newFunction('__log', value => { append(vm.getString(value)); }).consume(handle => vm.setProp(vm.global, '__log', handle));
  vm.newFunction('__done', (ok, value) => {
    if (pending.size) { finish('Await every tool call before returning from the script.'); return; }
    if (vm.getNumber(ok)) { const text = vm.getString(value); if (text !== 'undefined') append(text); finish(); }
    else finish(vm.getString(value));
  }).consume(handle => vm.setProp(vm.global, '__done', handle));
  // Capture the private bridge in closures, then remove its global handles.
  // No loader, filesystem, environment, fetch, process, or Node objects exist
  // inside this VM. Names and all responses enter as serialized data.
  evaluate(`(() => {
    const call = globalThis.__call, log = globalThis.__log;
    delete globalThis.__call; delete globalThis.__log;
    const tools = Object.create(null);
    for (const name of ${JSON.stringify(names)}) tools[name] = async (args) => JSON.parse(await call(name, JSON.stringify(args ?? {})));
    globalThis.tools = Object.freeze(tools);
    const show = value => typeof value === 'string' ? value : JSON.stringify(value);
    globalThis.console = Object.freeze({ log: (...values) => log(values.map(show).join(' ')), error: (...values) => log(values.map(show).join(' ')) });
  })();`);
  const compiled = ts.transpileModule(`(async () => {\n${code}\n})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
  const diagnostic = compiled.diagnostics?.find(item => item.category === ts.DiagnosticCategory.Error);
  if (diagnostic) throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  const source = compiled.outputText.trim().replace(/;$/, '');
  evaluate(`(() => { const done = globalThis.__done; delete globalThis.__done; ${source}.then(value => done(1, value === undefined ? 'undefined' : JSON.stringify(value)), error => done(0, String(error))); })()`);
  pump();
  port.on('message', (message: { id: number; json: string }) => {
    if (done) return;
    const deferred = pending.get(message.id); if (!deferred) return;
    pending.delete(message.id);
    try {
      vm.newString(message.json).consume(value => deferred.resolve(value));
      deferred.dispose(); pump();
    } catch { finish('Code execution exceeded a runtime limit.'); }
  });
} catch (error) { finish(error instanceof Error ? error.message : 'Unable to run TypeScript.'); }
// The parent terminates this worker after completion/cancellation, including
// any unresolvable guest promises. No guest state survives an invocation.
