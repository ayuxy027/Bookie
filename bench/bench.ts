// Latency bench. Spoken prompts x runs against the running dev server, p50/p95 per stage, plus STT and LLM model bake-offs.
// Run: npm run bench -- [e2e|stt|llm] [runs]   (server must be up on :3001, needs ffmpeg for clip generation)
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = "http://localhost:3001";
const OR = "https://openrouter.ai/api/v1";
const env = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const KEY = env.OPENROUTER_KEY;
if (!KEY) throw new Error("OPENROUTER_KEY missing in .env.local");
const H = { Authorization: `Bearer ${KEY}` };

const PROMPTS = [
  "Book two tickets for Interstellar tonight, center seats please.",
  "Three seats for Dune tomorrow in the back row.",
  "One ticket for Oppenheimer tomorrow.",
  "What's playing tomorrow evening?",
  "Can I get two seats together for the Batman movie?",
];
const [section = "all", runsArg = "3"] = process.argv.slice(2);
const RUNS = Number(runsArg);

// Real speech clips, made once with the app's own TTS and stored as webm/opus like Chrome records.
async function clips() {
  mkdirSync("data/bench", { recursive: true });
  return Promise.all(PROMPTS.map(async (text, i) => {
    const webm = `data/bench/p${i}.webm`;
    if (!existsSync(webm)) {
      const r = await fetch(`${OR}/audio/speech`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ model: "elevenlabs/eleven-flash-v2.5", input: text, voice: "21m00Tcm4TlvDq8ikWAM", response_format: "mp3" }) });
      if (!r.ok) throw new Error(`clip ${i} tts ${r.status}: ${await r.text()}`);
      writeFileSync(`data/bench/p${i}.mp3`, Buffer.from(await r.arrayBuffer()));
      execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", `data/bench/p${i}.mp3`, "-c:a", "libopus", webm]);
    }
    return { text, audio: readFileSync(webm) };
  }));
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
function table(title: string, rows: [string, number[]][]) {
  console.log(`\n${title}`);
  console.log("stage".padEnd(34) + "p50".padStart(8) + "p95".padStart(8) + "n".padStart(5));
  for (const [k, xs] of rows) if (xs.length) console.log(k.padEnd(34) + String(Math.round(pct(xs, 50))).padStart(8) + String(Math.round(pct(xs, 95))).padStart(8) + String(xs.length).padStart(5));
}
const spend = async () => (await (await fetch(`${OR}/key`, { headers: H })).json()).data.usage as number;

async function e2e(cs: { text: string; audio: Buffer }[]) {
  const m: Record<string, number[]> = {};
  const add = (k: string, v: number) => (m[k] ??= []).push(v);
  const routes: Record<string, number> = {};
  for (let run = 0; run < RUNS; run++) {
    for (const [i, c] of cs.entries()) {
      const fd = new FormData();
      fd.append("audio", new Blob([new Uint8Array(c.audio)], { type: "audio/webm" }), "a.webm");
      const t0 = performance.now();
      const res = await fetch(`${BASE}/api/turn`, { method: "POST", body: fd, headers: { cookie: `sid=bench-${Date.now()}-${run}-${i}` } });
      if (!res.ok || !res.body) throw new Error(`turn ${res.status}: ${await res.text()}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", reply = "", replyAt = 0, llm = 0, llmMs = 0, toolMs = 0, route = "llm";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() as string;
        for (const p of parts) {
          const e = JSON.parse(p.slice(6));
          if (e.type === "stt") add("1 stt", e.ms);
          if (e.type === "route") route = e.path;
          if (e.type === "llm") { llm++; llmMs += e.ms; }
          if (e.type === "tool_end") toolMs += e.ms;
          if (e.type === "error") throw new Error(`prompt ${i}: ${e.message}`);
          if (e.type === "reply") { reply = e.text; replyAt = performance.now() - t0; }
        }
      }
      routes[route] = (routes[route] ?? 0) + 1;
      add("2 llm calls (count)", llm);
      add("2 llm total", llmMs);
      add("3 tools total", toolMs);
      add("4 turn (release -> reply text)", replyAt);
      const ts = performance.now();
      const sp = await fetch(`${BASE}/api/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: reply }) });
      if (!sp.ok || !sp.body) throw new Error(`speak ${sp.status}`);
      const r2 = sp.body.getReader();
      await r2.read();
      const first = performance.now() - ts;
      while (!(await r2.read()).done);
      const full = performance.now() - ts;
      add("5 tts first byte", first);
      add("5 tts full download", full);
      add("6 VOICE START (streamed audio)", replyAt + first);
      add("6 VOICE START (wait full mp3)", replyAt + full);
      process.stdout.write(`${route[0]}`);
    }
  }
  table(`END TO END, ${RUNS} runs x ${cs.length} prompts, ms (routes: ${JSON.stringify(routes)})`, Object.entries(m).sort());
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
async function sttBakeoff(cs: { text: string; audio: Buffer }[]) {
  const models = ["elevenlabs/scribe-v2", "openai/whisper-large-v3-turbo", "deepgram/nova-3", "mistralai/voxtral-mini-transcribe", "openai/gpt-4o-mini-transcribe"];
  const rows: [string, number[]][] = [];
  for (const model of models) {
    const ms: number[] = [];
    let hit = 0, total = 0, err = "";
    for (let run = 0; run < RUNS; run++) for (const c of cs) {
      const fd = new FormData();
      fd.append("file", new Blob([new Uint8Array(c.audio)], { type: "audio/webm" }), "a.webm");
      fd.append("model", model);
      const t = performance.now();
      const r = await fetch(`${OR}/audio/transcriptions`, { method: "POST", headers: H, body: fd });
      if (!r.ok) { err = `${r.status} ${(await r.text()).slice(0, 80)}`; break; }
      const out = words((await r.json()).text ?? "");
      ms.push(performance.now() - t);
      const want = words(c.text);
      hit += want.filter((w) => out.includes(w)).length;
      total += want.length;
    }
    rows.push([`${model.slice(0, 26)} acc ${total ? Math.round((100 * hit) / total) : 0}%${err ? " ERR " + err : ""}`, ms]);
  }
  table(`STT BAKE-OFF, same clips, ms, acc = expected words found`, rows);
}

async function llmBakeoff() {
  const { toolSpecs } = await import("../src/lib/tools");
  const { SYSTEM } = await import("../src/lib/prompt");
  const models = ["anthropic/claude-haiku-5.5", "google/gemini-3.5-flash-lite", "openai/gpt-5.6-luna", "google/gemini-3.8-flash"];
  const asks = ["Two tickets for Interstellar tonight, center seats please.", "What's playing tomorrow evening?"];
  const rows: [string, number[]][] = [];
  for (const model of models) {
    const ms: number[] = [];
    let right = 0, n = 0, err = "";
    for (let run = 0; run < RUNS; run++) for (const [j, ask] of asks.entries()) {
      const t = performance.now();
      const r = await fetch(`${OR}/chat/completions`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ model, temperature: 0, max_tokens: 1024, tools: toolSpecs, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: ask }, { role: "system", content: "Today is 2026-11-11. User has no active hold." }] }) });
      if (!r.ok) { err = `${r.status} ${(await r.text()).slice(0, 80)}`; break; }
      const msg = (await r.json()).choices[0].message;
      ms.push(performance.now() - t);
      const tool = msg.tool_calls?.[0]?.function.name;
      n++;
      if ((j === 0 && (tool === "hold_seats" || tool === "search_shows")) || (j === 1 && (tool === "search_shows" || msg.content))) right++;
    }
    rows.push([`${model.slice(0, 26)} sane ${right}/${n}${err ? " ERR " + err : ""}`, ms]);
  }
  table("LLM BAKE-OFF, first call of a turn, ms, sane = called a sensible tool", rows);
}

const before = await spend();
const cs = await clips();
if (section === "all" || section === "e2e") await e2e(cs);
if (section === "all" || section === "stt") await sttBakeoff(cs);
if (section === "all" || section === "llm") await llmBakeoff();
console.log(`\nbench spend: $${((await spend()) - before).toFixed(4)} (OpenRouter usage can lag a few seconds)`);
