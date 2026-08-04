export interface QueueMessage { id: string; body: unknown; attempts: number; }
export interface QueueBatch { queue: string; messages: QueueMessage[]; ack(message: QueueMessage): void; retry(message: QueueMessage): void; }

export async function handleQueue(batch: QueueBatch): Promise<{ acknowledged: number; retried: number }> {
  let acknowledged = 0;
  let retried = 0;
  for (const message of batch.messages) {
    if (message.body === null || message.body === undefined) { batch.retry(message); retried += 1; continue; }
    batch.ack(message);
    acknowledged += 1;
  }
  return { acknowledged, retried };
}
