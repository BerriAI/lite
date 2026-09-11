import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DelegationSummary } from '../shared/types.js';
import type { LitespeedClient } from './client.js';
import { InvocationSync } from './invocation.js';

const clients = new WeakMap<LitespeedClient, Map<string, ReturnType<typeof subscription>>>();
function subscription(client: LitespeedClient, task: DelegationSummary, release: () => void) {
  const sync = new InvocationSync(client, task);
  let readers = 0, status = task.status;
  return {
    getState: sync.getState,
    retry: () => { void sync.start(); },
    subscribe(listener: () => void) {
      readers++;
      const unsubscribe = sync.subscribe(listener);
      void sync.start();
      return () => {
        unsubscribe(); readers--;
        queueMicrotask(() => { if (!readers) { sync.stop(); release(); } });
      };
    },
    refresh(next: DelegationSummary['status']) {
      if (next !== status) { status = next; void sync.refresh(); }
    },
  };
}

/** The pinned task list and inline transcript share one stream per invocation. */
export function useInvocation(client: LitespeedClient, task: DelegationSummary) {
  const entry = useMemo(() => {
    let cache = clients.get(client);
    if (!cache) { cache = new Map(); clients.set(client, cache); }
    const key = JSON.stringify([task.id, task.parentMessageId, task.toolCallId, task.childSessionId]);
    let value = cache.get(key);
    if (!value) { value = subscription(client, task, () => { if (cache!.get(key) === value) cache!.delete(key); }); cache.set(key, value); }
    return value;
  }, [client, task.id, task.parentMessageId, task.toolCallId, task.childSessionId]);
  useEffect(() => entry.refresh(task.status), [entry, task.status]);
  const state = useSyncExternalStore(entry.subscribe, entry.getState);
  return { ...state, retry: entry.retry };
}
