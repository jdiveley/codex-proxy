import { StoredResponse, ResponsesInputItem, ResponsesTool } from './types';

export class SessionStore {
  private store = new Map<string, StoredResponse>();
  private timer: ReturnType<typeof setInterval> | null = null;

  start(ttlMs: number): void {
    this.timer = setInterval(() => this.prune(ttlMs), 15 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.store.clear();
  }

  set(response: StoredResponse): void {
    this.store.set(response.id, response);
  }

  get(id: string): StoredResponse | undefined {
    return this.store.get(id);
  }

  buildHistory(
    previousResponseId: string | undefined,
    currentInstructions: string | undefined,
    currentTools: ResponsesTool[] | undefined,
  ): {
    history: ResponsesInputItem[];
    instructions: string | undefined;
    tools: ResponsesTool[] | undefined;
  } {
    if (!previousResponseId) {
      return { history: [], instructions: currentInstructions, tools: currentTools };
    }

    const prev = this.store.get(previousResponseId);
    if (!prev) {
      return { history: [], instructions: currentInstructions, tools: currentTools };
    }

    return {
      history: prev.accumulatedHistory,
      instructions: currentInstructions ?? prev.instructions,
      tools: currentTools ?? prev.tools,
    };
  }

  private prune(ttlMs: number): void {
    const cutoff = Date.now() - ttlMs;
    for (const [id, entry] of this.store) {
      if (entry.createdAt < cutoff) this.store.delete(id);
    }
  }
}
