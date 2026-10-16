import type { BlackboardSnapshot } from '../blackboard.ts';
import type { ActionRequest, AdapterFactory } from '../execution/types.ts';
import { ACTION_POLICY, THRESHOLDS } from '../policy.ts';

export function createChat(send: (message: string) => void) {
  let queue: Array<{ id: number; message: string }> = [];
  let sequence = 0;
  let nextSendAt = 0;
  const adapter: AdapterFactory = request => ({
    start(ctx) {
      if (!ctx.isActive()) return;
      const head = queue[0];
      if (!head || head.id !== request.params.messageId)
        return { status: 'FAILURE', reason: 'Message withdrawn' };
      const now = ctx.getSnapshot().observedAt;
      if (now < nextSendAt) return { status: 'FAILURE', reason: 'Rate limited' };
      queue.shift();
      nextSendAt = now + THRESHOLDS.chatIntervalMs;
      send(head.message);
      return { status: 'SUCCESS' };
    },
    cancel() {}, // Sending is synchronous and owns no timers/listeners.
  });
  return {
    adapter,
    enqueue(message: string): boolean {
      if (queue.length >= THRESHOLDS.chatQueueLimit) return false;
      queue.push({ id: ++sequence, message });
      return true;
    },
    requests(snapshot: BlackboardSnapshot): ActionRequest[] {
      const head = queue[0];
      if (!head || snapshot.observedAt < nextSendAt) return [];
      return [
        {
          nodeId: 'voice',
          runId: `${snapshot.generation}:voice:${head.id}`,
          actionType: 'Chat',
          targetId: null,
          ...ACTION_POLICY.Chat,
          params: { messageId: head.id },
        },
      ];
    },
    reset() {
      queue = [];
      nextSendAt = 0;
    },
  };
}
