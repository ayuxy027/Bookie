// VAD tuning bench: runs the same Silero v5 model and frame processor the browser uses, on clips with known pauses.
// Answers: at each SILENCE_MS, does a mid-sentence pause split the turn, how long after speech ends does the turn end,
// and does background noise alone start a turn. Run: npm run bench:vad  (needs OPENROUTER_KEY once for clips, and ffmpeg)
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { START_THRESHOLD, STOP_THRESHOLD, MIN_SPEECH_MS, PRE_ROLL_MS, SILENCE_MS } from "../src/lib/vad";

const require = createRequire(import.meta.url);
const vad = require("@ricky0123/vad-web/dist/frame-processor");
const { Silero } = require("@ricky0123/vad-web/dist/models");
const { Message } = require("@ricky0123/vad-web/dist/messages");
const ort = require("onnxruntime-web/wasm");
ort.env.wasm.wasmPaths = `${process.cwd()}/node_modules/onnxruntime-web/dist/`;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";

const RATE = 16000;
const FRAME = 512; // v5 frame size, 32 ms
const PAUSES = [250, 500, 800, 1200]; // gaps inside one sentence, ms
const WINDOWS = [300, 500, 700, 900, 1100]; // SILENCE_MS candidates
const PAIRS = [
  ["Book two tickets for Interstellar", "tonight, center seats please"],
  ["Three seats for Dune", "tomorrow in the back row"],
  ["Can I get one ticket", "for Oppenheimer tomorrow"],
];

const env = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

// Each half is spoken once by the app's own TTS, trimmed of edge silence, cached as raw 16 kHz float samples.
async function half(text: string, i: number): Promise<Float32Array> {
  mkdirSync("data/bench/vad", { recursive: true });
  const raw = `data/bench/vad/h${i}.f32`;
  if (!existsSync(raw)) {
    const r = await fetch("https://openrouter.ai/api/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${env.OPENROUTER_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "elevenlabs/eleven-flash-v2.5", input: text, voice: "21m00Tcm4TlvDq8ikWAM", response_format: "mp3" }) });
    if (!r.ok) throw new Error(`tts ${r.status}: ${await r.text()}`);
    writeFileSync(`data/bench/vad/h${i}.mp3`, Buffer.from(await r.arrayBuffer()));
    const trim = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse";
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", `data/bench/vad/h${i}.mp3`, "-af", trim, "-ac", "1", "-ar", String(RATE), "-f", "f32le", raw]);
  }
  const b = readFileSync(raw);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

// Low room noise (about -50 dB) instead of digital silence, so the model sees what a real mic sends.
const noise = (ms: number, amp = 0.003) => Float32Array.from({ length: (ms * RATE) / 1000 }, () => (Math.random() * 2 - 1) * amp);
const concat = (...parts: Float32Array[]) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// Runs one clip through Silero v5 + the frame processor with a given silence window. Returns turn ends in ms and misfires.
async function run(model: { process: (f: Float32Array) => Promise<{ isSpeech: number }>; reset_state: () => void }, audio: Float32Array, silenceMs: number) {
  model.reset_state();
  const fp = new vad.FrameProcessor((f: Float32Array) => model.process(f), () => model.reset_state(), { positiveSpeechThreshold: START_THRESHOLD, negativeSpeechThreshold: STOP_THRESHOLD, redemptionMs: silenceMs, preSpeechPadMs: PRE_ROLL_MS, minSpeechMs: MIN_SPEECH_MS, submitUserSpeechOnPause: false }, FRAME / 16);
  fp.resume();
  const ends: number[] = [];
  let starts = 0;
  for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
    await fp.process(audio.subarray(i, i + FRAME), (ev: { msg: string }) => {
      if (ev.msg === Message.SpeechRealStart) starts++;
      if (ev.msg === Message.SpeechEnd) ends.push(((i + FRAME) / RATE) * 1000);
    });
  }
  return { ends, starts };
}

const model = await Silero.new(ort, async () => { const b = readFileSync("node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
const halves = await Promise.all(PAIRS.flat().map((t, i) => half(t, i)));

console.log(`thresholds start ${START_THRESHOLD} / stop ${STOP_THRESHOLD}, min speech ${MIN_SPEECH_MS} ms, current SILENCE_MS ${SILENCE_MS}\n`);
console.log("SILENCE_MS".padEnd(12) + PAUSES.map((p) => `split@${p}`.padStart(11)).join("") + "end delay p50".padStart(15) + "noise starts".padStart(14));
for (const w of WINDOWS) {
  const splits = PAUSES.map(() => 0);
  const delays: number[] = [];
  for (let k = 0; k < PAIRS.length; k++) {
    const [a, b] = [halves[2 * k], halves[2 * k + 1]];
    for (const [j, p] of PAUSES.entries()) {
      const clip = concat(noise(400), a, noise(p), b, noise(2500));
      const { ends } = await run(model, clip, w);
      if (ends.length > 1) splits[j]++;
      const speechEnd = ((400 * RATE) / 1000 + a.length + (p * RATE) / 1000 + b.length) / RATE * 1000;
      if (ends.length) delays.push(ends[ends.length - 1] - speechEnd);
    }
  }
  const { starts } = await run(model, noise(5000, 0.02), w); // louder noise only, about -34 dB, no speech at all
  delays.sort((x, y) => x - y);
  console.log(String(w).padEnd(12) + splits.map((s) => `${s}/${PAIRS.length}`.padStart(11)).join("") + `${Math.round(delays[Math.floor(delays.length / 2)])} ms`.padStart(15) + String(starts).padStart(14));
}
console.log("\nsplit@N = sentences cut in two by an N ms pause. Pick the smallest SILENCE_MS with 0 splits at 500 ms.");
