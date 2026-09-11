/** A worker may run for many context windows. Only stalled work expires. */
export function progressTimeout(timeoutMs: number, waiting: () => boolean, expired: () => void) {
  let lastProgress = Date.now();
  const progress = () => { lastProgress = Date.now(); };
  const timer = setInterval(() => {
    if (waiting()) progress();
    else if (Date.now() - lastProgress >= timeoutMs) { clearInterval(timer); expired(); }
  }, Math.min(1000, timeoutMs));
  timer.unref();
  return { progress, close: () => clearInterval(timer) };
}
