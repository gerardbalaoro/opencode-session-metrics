import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

export type Message = ReturnType<TuiPluginApi["state"]["session"]["messages"]>[number];
export type AssistantMessage = Extract<Message, { role: "assistant" }>;
export type Session = NonNullable<ReturnType<TuiPluginApi["state"]["session"]["get"]>>;

export async function getSessionDescendants(
  api: TuiPluginApi,
  rootSessionId: string,
): Promise<Session[]> {
  const sessions: Session[] = [];
  const seen = new Set<string>([rootSessionId]);
  const queue: string[] = [rootSessionId];

  while (queue.length) {
    const parentId = queue.shift()!;
    const children = await api.client.session
      .children({ sessionID: parentId })
      .then((res) => res.data ?? [])
      .catch(() => [] as Session[]);

    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      sessions.push(child);
    }
  }

  return sessions;
}
