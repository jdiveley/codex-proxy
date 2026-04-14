import { StoredResponse, ResponsesInputItem, ResponsesTool } from './types.js';
import { getConfig } from './config.js';

class SessionStore {
  private store = new Map<string, StoredResponse>();
  private timer: ReturnType<typeof setInterval>;

  constructor() {
    // Prune expired sessions every 15 minutes
    this.timer = setInterval(() => this.prune(), 15 * 60 * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  set(response: StoredResponse): void {
    this.store.set(response.id, response);
  }

  get(id: string): StoredResponse | undefined {
    return this.store.get(id);
  }

  /**
   * Build the full message history that should precede the current request's
   * new inputs, following the previous_response_id chain.
   *
   * Returns the accumulated history array (input items + output items from all
   * prior turns in order), plus the inherited instructions/tools from the last
   * stored response if not overridden in the current request.
   */
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
      console.warn(`[session] previous_response_id "${previousResponseId}" not found — starting fresh`);
      return { history: [], instructions: currentInstructions, tools: currentTools };
    }

    return {
      history: prev.accumulatedHistory,
      instructions: currentInstructions ?? prev.instructions,
      tools: currentTools ?? prev.tools,
    };
  }

  private prune(): void {
    const ttl = getConfig().sessionTtlMs;
    const cutoff = Date.now() - ttl;
    for (const [id, entry] of this.store) {
      if (entry.createdAt < cutoff) this.store.delete(id);
    }
  }
}

export const sessions = new SessionStore();
