import type { Scheduler } from '../core/ports/scheduler.js';

export function makeBrowserScheduler(): Scheduler {
  return {
    every(intervalMs, task) {
      const id = window.setInterval(task, intervalMs);
      return () => window.clearInterval(id);
    },
    after(delayMs, task) {
      const id = window.setTimeout(task, delayMs);
      return () => window.clearTimeout(id);
    },
    now: () => Date.now(),
  };
}
