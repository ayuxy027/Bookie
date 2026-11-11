import { loadMessages, saveMessages } from "./db";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };

const EVENT = "(app event, not spoken) ";

// Chat history per session, stored in SQLite so a reload or restart keeps the conversation.
export const histories = {
  get: (userId: string) => loadMessages(userId) as Msg[],
  set: (userId: string, msgs: Msg[]) => saveMessages(userId, msgs),
  clear: (userId: string) => saveMessages(userId, []),
};

// Keeps the last ~40 messages but always starts at a user message, so a tool result is never cut from its call.
export function trim(h: Msg[]) {
  let i = Math.max(0, h.length - 40);
  while (i < h.length && h[i].role !== "user") i++;
  return h.slice(i);
}

// Things the user did outside the voice loop (like tapping confirm) go into history so the agent knows.
export function noteEvent(userId: string, text: string) {
  histories.set(userId, trim([...histories.get(userId), { role: "user", content: EVENT + text }]));
}

// What the user should see when they come back: their words and Bookie's replies, no tool plumbing or app events.
export function transcript(userId: string) {
  const lines: { who: "you" | "bookie"; text: string }[] = [];
  for (const m of histories.get(userId)) {
    if (m.role === "user" && m.content && !m.content.startsWith(EVENT)) lines.push({ who: "you", text: m.content });
    if (m.role === "assistant" && m.content) lines.push({ who: "bookie", text: m.content });
  }
  return lines;
}
