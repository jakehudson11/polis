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

export async function enqueueAiCall<T>(
  provider: string,
  fn: () => Promise<T>,
  priority: number = AI_PRIORITY.BACKGROUND
): Promise<T> {
  const queue = getOrCreateQueue(provider);
  return queue.add(fn, { priority }) as Promise<T>;
}

export function getQueueStats(): Record<string, { size: number; pending: number }> {
  const stats: Record<string, { size: number; pending: number }> = {};
  for (const [provider, queue] of queues) {
    stats[provider] = { size: queue.size, pending: queue.pending };
  }
  return stats;
}
