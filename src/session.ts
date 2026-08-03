import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { abortable, hasResponseError, isAbortError, mapWithConcurrency } from "./utils";

export type Message = ReturnType<TuiPluginApi["state"]["session"]["messages"]>[number];
export type AssistantMessage = Extract<Message, { role: "assistant" }>;
export type Session = NonNullable<ReturnType<TuiPluginApi["state"]["session"]["get"]>>;

export const DESCENDANT_CONCURRENCY = 4;

export type SessionTraversalOptions = {
  signal?: AbortSignal;
  index?: SessionIndex;
};

type CachedChildren = {
  sessions: Session[];
};

/** Caches child lists while retrying failed requests on every traversal. */
export class SessionIndex {
  private readonly childrenByParent = new Map<string, CachedChildren>();
  private readonly descendantsByRoot = new Map<string, Session[]>();
  private readonly staleParents = new Set<string>();
  private readonly staleRoots = new Set<string>();
  private disposed = false;

  clear(rootID?: string) {
    if (this.disposed) return;
    if (rootID === undefined) {
      this.childrenByParent.clear();
      this.descendantsByRoot.clear();
      this.staleParents.clear();
      this.staleRoots.clear();
      return;
    }

    const closure = this.closure(rootID);
    for (const sessionID of closure) {
      this.childrenByParent.delete(sessionID);
      this.descendantsByRoot.delete(sessionID);
      this.staleParents.delete(sessionID);
      this.staleRoots.delete(sessionID);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
  }

  async children(api: TuiPluginApi, parentID: string, signal?: AbortSignal): Promise<Session[]> {
    if (this.disposed) return [];
    signal?.throwIfAborted();

    try {
      const response = await abortable(
        Promise.resolve(
          (api.client.session.children as any)(
            { sessionID: parentID },
            signal ? { signal } : undefined,
          ),
        ),
        signal,
      );
      if (hasResponseError(response)) throw new Error("Session children request failed");
      if (this.disposed) return [];
      const rows = Array.isArray(response?.data) ? response.data : [];
      const sessions = rows.filter((session: unknown): session is Session => {
        return !!session && typeof (session as { id?: unknown }).id === "string";
      });
      this.childrenByParent.set(parentID, { sessions });
      this.staleParents.delete(parentID);
      return [...sessions];
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (this.disposed) return [];
      signal?.throwIfAborted();
      this.staleParents.add(parentID);
      return [...(this.childrenByParent.get(parentID)?.sessions ?? [])];
    }
  }

  async descendants(
    api: TuiPluginApi,
    rootSessionID: string,
    options: Omit<SessionTraversalOptions, "index"> = {},
  ) {
    if (this.disposed) return [];
    const signal = options.signal;
    signal?.throwIfAborted();

    const sessions: Session[] = [];
    const previous = this.descendantsByRoot.get(rootSessionID);
    this.staleRoots.delete(rootSessionID);
    const seen = new Set<string>([rootSessionID]);
    const queue: string[] = [rootSessionID];
    let cursor = 0;

    while (cursor < queue.length) {
      if (this.disposed) return [];
      signal?.throwIfAborted();
      const levelEnd = queue.length;
      const parents = queue.slice(cursor, levelEnd);
      cursor = levelEnd;
      const childrenByParent = await mapWithConcurrency(
        parents,
        DESCENDANT_CONCURRENCY,
        (parentID) => this.children(api, parentID, signal),
        signal,
      );
      if (this.disposed) return [];

      if (parents.some((parentID) => this.staleParents.has(parentID))) {
        this.staleRoots.add(rootSessionID);
      }

      // Results are consumed in parent order, not completion order, so BFS
      // output remains deterministic even when requests resolve out of order.
      for (const children of childrenByParent) {
        for (const child of children) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          queue.push(child.id);
          sessions.push(child);
        }
      }
    }

    if (this.disposed) return [];
    if (this.staleRoots.has(rootSessionID)) {
      if (previous) return [...previous];
      return sessions;
    }

    this.descendantsByRoot.set(rootSessionID, [...sessions]);
    return sessions;
  }

  lastKnown(rootSessionID: string) {
    if (this.disposed) return [];
    return [...(this.descendantsByRoot.get(rootSessionID) ?? [])];
  }

  isStale(rootSessionID: string) {
    return !this.disposed && this.staleRoots.has(rootSessionID);
  }

  private closure(rootID: string) {
    const closure = new Set<string>([rootID]);
    const queue = [rootID];
    const cachedDescendants = this.descendantsByRoot.get(rootID) ?? [];
    for (const session of cachedDescendants) {
      if (!closure.has(session.id)) {
        closure.add(session.id);
        queue.push(session.id);
      }
    }

    let cursor = 0;
    while (cursor < queue.length) {
      const parentID = queue[cursor++];
      for (const child of this.childrenByParent.get(parentID)?.sessions ?? []) {
        if (closure.has(child.id)) continue;
        closure.add(child.id);
        queue.push(child.id);
      }
    }

    return closure;
  }
}

export async function getSessionDescendants(
  api: TuiPluginApi,
  rootSessionID: string,
  options: SessionTraversalOptions = {},
) {
  const index = options.index ?? new SessionIndex();
  return index.descendants(api, rootSessionID, { signal: options.signal });
}
