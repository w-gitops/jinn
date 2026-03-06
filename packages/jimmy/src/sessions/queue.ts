export class SessionQueue {
  private queues = new Map<string, Promise<void>>();

  async enqueue(sessionKey: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(sessionKey) || Promise.resolve();
    const next = prev.then(fn, fn); // run even if previous errored
    this.queues.set(sessionKey, next);
    return next;
  }
}
