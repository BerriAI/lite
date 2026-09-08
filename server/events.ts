import { EventEmitter } from 'node:events';
import type { RunEvent } from '../shared/types.js';
import type { Store } from './store.js';

export class EventBus {
  private emitter = new EventEmitter();
  constructor(private store: Store) { this.emitter.setMaxListeners(100); }
  emit(sessionId: string, type: RunEvent['type'], data: any) {
    const event = this.store.event({ sessionId, type, data });
    this.emitter.emit(sessionId, event);
    return event;
  }
  subscribe(sessionId: string, fn: (event: RunEvent) => void) {
    this.emitter.on(sessionId, fn);
    return () => this.emitter.off(sessionId, fn);
  }
}
