import { MODELS, or, session, withCookie } from "@/lib/openrouter";
import { runTool, toolSpecs, holdLine, holdReply, showsContext, localDate, TZ } from "@/lib/tools";
import { histories, trim, type ToolCall } from "@/lib/history";
import { parseBooking } from "@/lib/intent";
import { searchShows } from "@/lib/db";
import { SYSTEM } from "@/lib/prompt";
import { log } from "@/lib/log";

const STEP_CAP = 8;
type Confirm = { ref: string; movie: string; theatre: string; when: string; seats: string[]; total: number };

// One user turn: speech to text, a deterministic fast path for plain bookings, else the LLM tool loop.
// Streamed to the browser as server-sent events. A barge-in or disconnect cancels it between steps.
export async function POST(req: Request) {
  const { userId, setCookie } = session(req);
  const form = await req.formData();
  const audio = form.get("audio");
  const typed = form.get("text");
  if (!(audio instanceof Blob) && typeof typed !== "string") return withCookie(Response.json({ error: "send audio or text" }, { status: 400 }), setCookie);
  // client-side voice trace (VAD timings), logged with the turn so cut-offs and slow endpoints are visible
  const vad = ["mode", "speechMs", "endpointMs", "bargeIn"].map((k) => `${k}=${String(form.get(k) ?? "-").slice(0, 12)}`).join(" ");

  const cancel = new AbortController();
  // undici links the client's abort to req.signal through a WeakRef to the Request, so the Request must stay
  // referenced for the whole turn (it is read again in `finally`) or a GC drops the barge-in silently.
  req.signal.addEventListener("abort", () => cancel.abort());
  const enc = new TextEncoder();
  const t0 = Date.now();
  const stages: string[] = [];
  const stream = new ReadableStream({
    cancel: () => cancel.abort(),
    async start(ctl) {
      const send = (e: Record<string, unknown>) => {
        if (!cancel.signal.aborted) ctl.enqueue(enc.encode(`data: ${JSON.stringify({ ...e, at: Date.now() - t0 })}\n\n`));
      };
      const hist = histories.get(userId);
      const finish = (text: string, extra: Record<string, unknown> = {}) => {
        histories.set(userId, trim(hist));
        send({ type: "reply", text, totalMs: Date.now() - t0, ...extra });
      };
      const tool = (name: string, args: string) => {
        const ts = Date.now();
        const id = `call_${ts}_${name}`;
        send({ type: "tool_start", id, name, args });
        const result = runTool(name, args, { userId });
        stages.push(`tool ${name} ${Date.now() - ts}ms${result.error ? " ERR" : ""}`);
        send({ type: "tool_end", id, name, result, ms: Date.now() - ts });
        if (result.confirm) send({ type: "confirm", ...(result.confirm as object) });
        return result;
      };
      try {
        let text = typeof typed === "string" ? typed.trim() : "";
        if (audio instanceof Blob) {
          const t = Date.now();
          const fd = new FormData();
          fd.append("file", audio, audio.type.includes("wav") ? "turn.wav" : "turn.webm");
          fd.append("model", MODELS.stt);
          const r = await (await or("/audio/transcriptions", fd, 15_000, false, cancel.signal)).json();
          if (typeof r.text !== "string") throw new Error(`STT returned no text: ${JSON.stringify(r).slice(0, 200)}`);
          text = r.text.trim();
          stages.push(`stt ${Date.now() - t}ms (${audio.size}B ${audio.type})`);
          send({ type: "stt", text, ms: Date.now() - t, model: MODELS.stt });
        }
        if (!text) return send({ type: "error", message: "I did not catch that. Say it again, or type below." });
        hist.push({ role: "user", content: text });

        const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
        const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });

        // Fast path: a plain "N tickets for MOVIE DAY" is parsed and held without any LLM call.
        const intent = parseBooking(text, searchShows(), localDate, today, tomorrow);
        if (intent) {
          send({ type: "route", path: "fast" });
          const r = tool("hold_seats", JSON.stringify(intent));
          if (r.confirm) {
            const reply = holdReply(r.confirm as Confirm);
            hist.push({ role: "assistant", content: reply });
            stages.unshift("route fast");
            return finish(reply);
          }
          stages.push("fast path hold failed, falling back to LLM");
        }
        send({ type: "route", path: "llm" });
        stages.unshift("route llm");

        for (let step = 1; step <= STEP_CAP; step++) {
          if (cancel.signal.aborted) throw new Error("cancelled by the user");
          const t = Date.now();
          // static prompt first so it caches, changing state last
          const live = `Today is ${today}, tomorrow is ${tomorrow}.\nUpcoming shows (id | movie | theatre | when | price | free seats):\n${showsContext(userId)}\n${holdLine(userId)}`;
          const body = JSON.stringify({
            model: MODELS.llm,
            temperature: 0,
            max_tokens: 1024,
            tools: toolSpecs,
            messages: [{ role: "system", content: SYSTEM }, ...hist, { role: "system", content: live }],
          });
          const r = await (await or("/chat/completions", body, 20_000, true, cancel.signal)).json();
          const choice = r.choices?.[0];
          if (!choice?.message) throw new Error(`LLM returned no message: ${JSON.stringify(r).slice(0, 200)}`);
          if (choice.finish_reason === "length") throw new Error("LLM hit max_tokens mid-answer, output would be truncated");
          if (!r.usage) throw new Error("LLM response has no usage block, cannot account tokens");
          const msg = choice.message;
          stages.push(`llm#${step} ${Date.now() - t}ms in=${r.usage.prompt_tokens} out=${r.usage.completion_tokens} $${Number(r.usage.cost ?? 0).toFixed(5)}`);
          send({ type: "llm", step, ms: Date.now() - t, tokensIn: r.usage.prompt_tokens, tokensOut: r.usage.completion_tokens });
          hist.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });

          if (!msg.tool_calls?.length) {
            if (typeof msg.content !== "string" || !msg.content.trim()) throw new Error("LLM ended the turn with no tools and no text");
            return finish(msg.content);
          }
          let held: Confirm | null = null;
          for (const call of msg.tool_calls as ToolCall[]) {
            const result = tool(call.function.name, call.function.arguments);
            hist.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
            if (result.confirm) held = result.confirm as Confirm;
          }
          // A successful hold ends the turn with a fixed reply instead of one more LLM call to phrase it.
          if (held) {
            const reply = holdReply(held);
            hist.push({ role: "assistant", content: reply });
            return finish(reply);
          }
        }
        finish("That took more steps than I allow for one turn. Tell me the movie and time and I will pick it up from there.", { capped: true });
      } catch (e) {
        stages.push(cancel.signal.aborted ? "CANCELLED" : `ERROR ${(e as Error).message}`);
        send({ type: "error", message: (e as Error).message });
      } finally {
        log("turn", `user=${userId.slice(0, 8)} total=${Date.now() - t0}ms ${vad}${req.signal.aborted ? " client-gone" : ""} | ${stages.join(" | ")}`);
        if (!cancel.signal.aborted) ctl.close();
      }
    },
  });
  return withCookie(new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }), setCookie);
}
