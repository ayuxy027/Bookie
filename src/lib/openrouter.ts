import { randomUUID } from "node:crypto";
import { log } from "./log";

const BASE = "https://openrouter.ai/api/v1";
export const MODELS = {
  stt: process.env.STT_MODEL ?? "mistralai/voxtral-mini-transcribe", // bench: 685ms p50 vs scribe-v2 1013ms, same accuracy
  llm: process.env.LLM_MODEL ?? "google/gemini-3.5-flash-lite", // bench: 1213ms p50 vs haiku-5.5 1674ms, 6/6 sane tool calls
  tts: process.env.TTS_MODEL ?? "elevenlabs/eleven-flash-v2.5",
  voice: process.env.TTS_VOICE ?? "21m00Tcm4TlvDq8ikWAM",
};

function key() {
  const k = process.env.OPENROUTER_KEY;
  if (!k) throw new Error("OPENROUTER_KEY missing in .env.local");
  return k;
}

// Every provider call has a deadline, is logged with status and ms, and surfaces the provider's own error text.
// `cancel` aborts the call when the user barges in or the browser disconnects.
// The deadline covers time to response headers only, so a long streamed audio body is never cut off mid-sentence.
export async function or(path: string, body: BodyInit, ms: number, json = true, cancel?: AbortSignal) {
  const t = performance.now();
  // Own controller instead of AbortSignal.any: Node holds composite signals weakly and can GC them before they fire.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`no response in ${ms}ms`)), ms);
  const onCancel = () => ac.abort(new Error("cancelled"));
  cancel?.addEventListener("abort", onCancel, { once: true });
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, ...(json ? { "Content-Type": "application/json" } : {}) },
    body,
    signal: ac.signal,
  }).catch((e: Error) => {
    log("openrouter", `${path} NETWORK ${(performance.now() - t).toFixed(0)}ms ${ac.signal.aborted ? String(ac.signal.reason) : e.message}`);
    throw new Error(`${path} failed: ${ac.signal.aborted ? (ac.signal.reason as Error).message : e.message}`);
  }).finally(() => {
    clearTimeout(timer);
    cancel?.removeEventListener("abort", onCancel);
  });
  log("openrouter", `${path} ${res.status} ${(performance.now() - t).toFixed(0)}ms (headers)`);
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// User id comes from an httpOnly cookie, never from the model or the request body.
// Returns the Set-Cookie header to attach when the session is new.
export function session(req: Request): { userId: string; setCookie: string | null } {
  const found = req.headers.get("cookie")?.match(/(?:^|;\s*)sid=([\w-]+)/)?.[1];
  if (found) return { userId: found, setCookie: null };
  const userId = randomUUID();
  return { userId, setCookie: `sid=${userId}; Path=/; HttpOnly; SameSite=Lax` };
}

// Attaches a new session cookie to a response if one was issued.
export function withCookie(res: Response, setCookie: string | null) {
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}
