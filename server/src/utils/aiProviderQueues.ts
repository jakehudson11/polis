let PQueue: any;
const queues = new Map<string, any>();

const PROVIDER_CONCURRENCY: Record<string, number> = {
  openai: 15,
  anthropic: 8,
  google: 10,
  perplexity: 3,
  deepseek: 5,
  qwen: 5,
};

export const AI_PRIORITY = {
  INTERACTIVE: 10,
  MEDIUM: 5,
  BACKGROUND: 1,
} as const;

let initialized = false;

export async function initProviderQueues(): Promise<void> {
  if (initialized) return;
  const mod = await import('p-queue');
  PQueue = mod.default;
  initialized = true;
  console.log('[ai-queues] Provider queues initialized');
}

function getOrCreateQueue(provider: string): any {
  const key = provider.toLowerCase();
  let queue = queues.get(key);
  if (!queue) {
    if (!PQueue) throw new Error('[ai-queues] Not initialized. Call initProviderQueues()');
    const concurrency = PROVIDER_CONCURRENCY[key] ?? 5;
    queue = new PQueue({ concurrency });
    queues.set(key, queue);
    console.log(`[ai-queues] Created queue for ${key} (concurrency: ${concurrency})`);
  }
  return queue;
}

/**
 * Default maximum time (in ms) a call may wait in the queue for a concurrency
 * slot before rejecting.  Set generously because LLM calls can be long-running,
 * but a caller should never block indefinitely.
 */
const DEFAULT_QUEUE_TIMEOUT_MS = 120_000;

export async function enqueueAiCall<T>(
  provider: string,
  fn: () => Promise<T>,
  priority: number = AI_PRIORITY.BACKGROUND,
  queueTimeoutMs: number = DEFAULT_QUEUE_TIMEOUT_MS
): Promise<T> {
  const queue = getOrCreateQueue(provider);

  const queueTask = queue.add(fn, { priority }) as Promise<T>;

  const timeoutTask = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(
        `AI queue timeout: waited ${queueTimeoutMs / 1000}s for a ${provider} provider slot`
      );
      (err as any).code = 'QUEUE_TIMEOUT';
      reject(err);
    }, queueTimeoutMs);
    // Allow Node to exit even if this timer is still pending
    if (timer.unref) timer.unref();
  });

  return Promise.race([queueTask, timeoutTask]);
}

export function getQueueStats(): Record<string, { size: number; pending: number }> {
  const stats: Record<string, { size: number; pending: number }> = {};
  for (const [provider, queue] of queues) {
    stats[provider] = { size: queue.size, pending: queue.pending };
  }
  return stats;
}
