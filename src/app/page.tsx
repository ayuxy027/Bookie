"use client";
import { useEffect, useRef, useState } from "react";
import { GridPattern } from "@/components/magic/grid-pattern";
import { Ripple } from "@/components/magic/ripple";
import { ShinyText } from "@/components/magic/shiny-text";
import { AnimatedList } from "@/components/magic/animated-list";
import { cn } from "@/lib/cn";
import { startVad, BARGE_IN_MS, MAX_TURN_MS, MIN_SPEECH_MS, STOP_THRESHOLD, type MicVAD } from "@/lib/vad";

type Ev = { type: string; at: number; [k: string]: unknown };
type Line = { who: "you" | "bookie"; text: string };
type Confirm = { ref: string; movie: string; theatre: string; when: string; seats: string[]; total: number; expiresAt: number; taken: string[] };
type Status = "off" | "listening" | "hearing" | "thinking" | "speaking" | "recording";

const CHIPS = ["Book two tickets for Interstellar tonight", "Three seats for Dune tomorrow, back row", "What's playing tomorrow?"];
const PILL: Record<Status, string> = { off: "Mic off", listening: "Listening", hearing: "Hearing you", thinking: "Working", speaking: "Speaking", recording: "Recording" };
const ROWS = ["A", "B", "C", "D", "E"];

// Seat map for the confirm card: you see exactly where your seats are before you tap.
function SeatMap({ mine, taken }: { mine: string[]; taken: string[] }) {
  return (
    <div className="mt-4 rounded-lg border border-zinc-200 p-3">
      <div className="mx-auto mb-3 h-1 w-2/3 rounded-full bg-zinc-300" />
      <p className="-mt-2 mb-2 text-center text-[11px] uppercase tracking-wider text-zinc-400">Screen</p>
      <div className="mx-auto grid w-fit gap-1.5">
        {ROWS.map((r) => (
          <div key={r} className="flex items-center gap-1.5">
            <span className="w-3 font-mono text-[11px] text-zinc-400">{r}</span>
            {Array.from({ length: 8 }, (_, i) => {
              const id = `${r}${i + 1}`;
              return (
                <span
                  key={id}
                  title={id}
                  className={cn("h-5 w-5 rounded-[5px] border sm:h-6 sm:w-6", i === 4 && "ml-2", mine.includes(id) ? "border-indigo-600 bg-indigo-600" : taken.includes(id) ? "border-zinc-200 bg-zinc-200" : "border-zinc-300 bg-white")}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-center gap-4 text-xs text-zinc-500">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] bg-indigo-600" />Yours</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] border border-zinc-300" />Free</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] bg-zinc-200" />Taken</span>
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<Status, string> = {
  off: "Tap the mic to talk",
  listening: "Listening, just speak",
  hearing: "Hearing you",
  thinking: "Working on it",
  speaking: "Speaking · talk to interrupt",
  recording: "Recording · release to send",
};

export default function Home() {
  const [lines, setLines] = useState<Line[]>([]);
  const [trace, setTrace] = useState<Ev[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [booked, setBooked] = useState<{ ref: string; seats: string[]; total: number; movie: string; theatre: string; when: string } | null>(null);
  const [status, setStatusState] = useState<Status>("off");
  const [handsFree, setHandsFree] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const statusRef = useRef<Status>("off");
  const vadRef = useRef<{ mic: MicVAD; wav: (a: Float32Array) => Blob } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const turnRef = useRef<AbortController | null>(null);
  const bargedRef = useRef(false);
  const bargeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSpeechAt = useRef(0);
  const ignoreVadUntil = useRef(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const setStatus = (s: Status) => { statusRef.current = s; setStatusState(s); };
  const restStatus = () => setStatus(vadRef.current ? "listening" : "off");
  const addTrace = (e: Ev) => setTrace((t) => [...t, e]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [lines, confirm, booked]);
  // Bring back this session's conversation after a reload.
  useEffect(() => {
    fetch("/api/history")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`history ${r.status}`))))
      .then((j: { lines: Line[] }) => setLines((l) => (l.length ? l : j.lines)))
      .catch((e: Error) => setErr(`Could not load your earlier chat: ${e.message}`));
  }, []);

  async function clearChat() {
    const r = await fetch("/api/history", { method: "DELETE" });
    if (!r.ok) return setErr(`Could not clear chat (${r.status})`);
    setLines([]);
    setTrace([]);
    setBooked(null);
  }
  useEffect(() => {
    if (!confirm) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [confirm]);

  function stopAudio() {
    audioRef.current?.pause();
    audioRef.current = null;
  }

  // Plays the reply as it streams in (GET lets the browser start on the first bytes).
  function speak(text: string) {
    stopAudio();
    setStatus("speaking");
    const t = performance.now();
    const url = `/api/speak?text=${encodeURIComponent(text)}`;
    const a = new Audio(url);
    audioRef.current = a;
    a.onplaying = () => addTrace({ type: "tts", at: -1, ms: Math.round(performance.now() - t) });
    a.onended = () => { if (audioRef.current === a) { audioRef.current = null; restStatus(); } };
    a.onerror = async () => {
      if (audioRef.current !== a) return;
      const r = await fetch(url);
      setErr(`Voice reply failed (${r.status}): ${(await r.json().catch(() => ({ error: "unreadable error body" }))).error}`);
      restStatus();
    };
    a.play().catch((e: Error) => { setErr(`Browser blocked audio: ${e.message}`); restStatus(); });
  }

  // One turn. Starting a new one cancels the old one, so new speech steers instead of queueing.
  async function turn(body: FormData) {
    turnRef.current?.abort();
    const ac = new AbortController();
    turnRef.current = ac;
    stopAudio();
    setErr(null);
    setTrace([]);
    setStatus("thinking");
    const typed = body.get("text");
    if (typeof typed === "string") setLines((l) => [...l, { who: "you", text: typed }]);
    let reply = "";
    try {
      const r = await fetch("/api/turn", { method: "POST", body, signal: ac.signal });
      if (!r.ok || !r.body) throw new Error(`turn failed ${r.status}: ${await r.text()}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() as string;
        for (const p of parts) {
          const e: Ev = JSON.parse(p.slice(6));
          addTrace(e);
          if (e.type === "stt") setLines((l) => [...l, { who: "you", text: String(e.text) }]);
          if (e.type === "confirm") { setConfirm(e as unknown as Confirm); setBooked(null); }
          if (e.type === "reply") { reply = String(e.text); setLines((l) => [...l, { who: "bookie", text: reply }]); }
          if (e.type === "error") setErr(String(e.message));
        }
      }
    } catch (e) {
      if (ac.signal.aborted) return addTrace({ type: "cancelled", at: -1, reason: "you started talking" });
      setErr(`Turn failed: ${(e as Error).message}`);
    }
    if (turnRef.current !== ac) return;
    turnRef.current = null;
    if (reply) speak(reply);
    else restStatus();
  }

  function sendText(text: string) {
    if (!text.trim()) return;
    const fd = new FormData();
    fd.append("text", text);
    fd.append("mode", "text");
    setDraft("");
    turn(fd);
  }

  // Hands-free: VAD decides when you started and stopped; this layer decides what that means for the turn.
  async function startHandsFree() {
    setNotice(null);
    try {
      vadRef.current = await startVad({
        onFrameProcessed: (p) => { if (p.isSpeech >= STOP_THRESHOLD) lastSpeechAt.current = performance.now(); },
        onSpeechRealStart: () => {
          if (performance.now() < ignoreVadUntil.current) return;
          const s = statusRef.current;
          if (s === "speaking") {
            // barge-in only on sustained speech, so a "yeah" or a cough does not cut the reply
            bargeTimer.current = setTimeout(() => {
              bargedRef.current = true;
              stopAudio();
              setStatus("hearing");
              addTrace({ type: "barge-in", at: -1 });
            }, BARGE_IN_MS - MIN_SPEECH_MS);
          } else {
            if (s === "thinking") turnRef.current?.abort();
            setStatus("hearing");
          }
          maxTimer.current = setTimeout(async () => {
            const v = vadRef.current;
            if (!v) return;
            addTrace({ type: "max-turn", at: -1, ms: MAX_TURN_MS });
            await v.mic.pause(); // submitUserSpeechOnPause sends what we have
            await v.mic.start();
          }, MAX_TURN_MS - MIN_SPEECH_MS);
        },
        onVADMisfire: () => {
          if (bargeTimer.current) clearTimeout(bargeTimer.current);
          if (maxTimer.current) clearTimeout(maxTimer.current);
          if (statusRef.current === "hearing") restStatus();
        },
        onSpeechEnd: (audio) => {
          if (bargeTimer.current) clearTimeout(bargeTimer.current);
          if (maxTimer.current) clearTimeout(maxTimer.current);
          if (performance.now() < ignoreVadUntil.current) return;
          if (statusRef.current === "speaking" && !bargedRef.current) return addTrace({ type: "ignored", at: -1, reason: "short sound during reply" });
          const v = vadRef.current;
          if (!v) return;
          const fd = new FormData();
          fd.append("audio", v.wav(audio), "turn.wav");
          fd.append("mode", "vad");
          fd.append("speechMs", String(Math.round(audio.length / 16)));
          fd.append("endpointMs", String(Math.round(performance.now() - lastSpeechAt.current)));
          fd.append("bargeIn", bargedRef.current ? "1" : "0");
          bargedRef.current = false;
          turn(fd);
        },
      });
      setHandsFree(true);
      setStatus("listening");
    } catch (e) {
      vadRef.current = null;
      setHandsFree(false);
      setStatus("off");
      setNotice(`Hands-free listening is unavailable (${(e as Error).message}). Hold the button to talk instead.`);
    }
  }

  async function stopHandsFree() {
    await vadRef.current?.mic.destroy();
    vadRef.current = null;
    setHandsFree(false);
    turnRef.current?.abort();
    stopAudio();
    setStatus("off");
  }

  // Manual override: push to talk always works, VAD or not. VAD ignores the same speech so it is never sent twice.
  async function startPtt() {
    if (recRef.current) return;
    ignoreVadUntil.current = Number.POSITIVE_INFINITY;
    turnRef.current?.abort();
    stopAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const r = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      const t0 = performance.now();
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recRef.current = null;
        ignoreVadUntil.current = performance.now() + 1500;
        const fd = new FormData();
        fd.append("audio", new Blob(chunks, { type: r.mimeType }));
        fd.append("mode", "ptt");
        fd.append("speechMs", String(Math.round(performance.now() - t0)));
        turn(fd);
      };
      r.start();
      recRef.current = r;
      setStatus("recording");
    } catch (e) {
      ignoreVadUntil.current = 0;
      setErr(`Microphone unavailable (${(e as Error).message}). Allow it in the address bar, or type below.`);
    }
  }
  const stopPtt = () => { if (recRef.current?.state === "recording") recRef.current.stop(); };

  async function book() {
    if (!confirm) return;
    const r = await fetch("/api/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: confirm.ref }) });
    const j = await r.json();
    const held = confirm;
    setConfirm(null);
    if (!r.ok) {
      setErr(j.error);
      return speak(`Sorry, that did not go through. ${j.error}`);
    }
    setBooked({ ref: j.booking.ref.slice(0, 8).toUpperCase(), seats: j.booking.seats, total: j.booking.total, movie: held.movie, theatre: held.theatre, when: held.when });
    speak(`Booked. Seats ${j.booking.seats.join(", ")}. Enjoy the show.`);
  }

  const left = confirm ? Math.max(0, Math.round((confirm.expiresAt - now) / 1000)) : 0;
  const busy = status === "thinking";
  const live = status === "listening" || status === "hearing" || status === "recording";
  const empty = lines.length === 0;

  // Per-turn latency summary from the streamed events, so the slow stage is obvious at a glance.
  const sum = (type: string) => trace.filter((e) => e.type === type).reduce((n, e) => n + Number(e.ms ?? 0), 0);
  const stages = [
    { k: "Speech to text", ms: sum("stt"), c: "bg-sky-500" },
    { k: "Model", ms: sum("llm"), c: "bg-indigo-500" },
    { k: "Tools", ms: sum("tool_end"), c: "bg-emerald-500" },
    { k: "Voice", ms: sum("tts"), c: "bg-amber-500" },
  ].filter((s) => s.ms > 0);
  const totalMs = stages.reduce((n, s) => n + s.ms, 0);
  const route = trace.find((e) => e.type === "route")?.path as string | undefined;

  return (
    <div className="relative min-h-screen">
      <GridPattern className="[mask-image:linear-gradient(to_bottom,black,transparent_70%)]" />

      {/* Navbar, after PrebuiltUI's light navbar */}
      <nav className="relative mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-zinc-900 text-sm font-bold text-white">B</span>
          <span className="text-lg font-semibold tracking-tight">Bookie</span>
          <span className="hidden text-sm text-zinc-500 sm:inline">· movie tickets by voice</span>
        </div>
        <div className="flex items-center gap-2">
        {lines.length > 0 && (
          <button onClick={clearChat} className="whitespace-nowrap rounded-full border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-600 hover:border-zinc-400">
            Clear chat
          </button>
        )}
        <div aria-live="polite" className={cn("flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-sm", live ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-zinc-200 bg-white text-zinc-600")}>
          <span className={cn("h-2 w-2 rounded-full", live ? "animate-pulse bg-indigo-500" : busy ? "bg-amber-500" : status === "speaking" ? "bg-emerald-500" : "bg-zinc-300")} />
          {PILL[status]}
        </div>
        </div>
      </nav>

      <main className="relative mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6 px-4 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="flex min-h-[78vh] min-w-0 flex-col rounded-xl border border-zinc-200 bg-white">
          <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
            {empty && (
              // Hero, after PrebuiltUI's centered light hero with badge
              <div className="mx-auto max-w-xl py-8 text-center sm:py-12">
                <span className="inline-flex items-center rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-sm font-medium text-zinc-700">
                  Voice booking · shows every step it takes
                </span>
                <h1 className="mt-5 text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl">Book movie tickets by talking</h1>
                <p className="mt-4 text-lg text-zinc-600">
                  Say a movie, a day and how many seats. Bookie holds the best seats for five minutes, and one tap books them.
                </p>
                <ol className="mx-auto mt-8 grid max-w-lg grid-cols-3 gap-2 text-left text-sm">
                  {[["Say it", "\"Two for Dune tomorrow\""], ["Seats held", "Best free seats, 5 minutes"], ["Tap to book", "Nothing books without you"]].map(([t, d], i) => (
                    <li key={t} className="rounded-lg border border-zinc-200 p-3">
                      <span className="font-mono text-xs text-indigo-600">0{i + 1}</span>
                      <p className="mt-1 font-medium text-zinc-900">{t}</p>
                      <p className="text-xs text-zinc-500">{d}</p>
                    </li>
                  ))}
                </ol>
                <p className="mt-8 text-xs font-medium uppercase tracking-wider text-zinc-400">Try one</p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  {CHIPS.map((c) => (
                    <button key={c} onClick={() => sendText(c)} disabled={busy} className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:border-zinc-500 disabled:opacity-50">
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {lines.map((l, i) => (
              <div key={i} className={cn("flex animate-enter items-end gap-2", l.who === "you" ? "justify-end" : "justify-start")}>
                {l.who === "bookie" && <span className="mb-1 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-zinc-900 text-xs font-bold text-white">B</span>}
                <p className={cn("max-w-[80%] rounded-2xl px-4 py-2.5 text-[17px] leading-relaxed", l.who === "you" ? "bg-zinc-100 text-zinc-700" : "border border-zinc-200 bg-white text-zinc-900")}>{l.text}</p>
              </div>
            ))}

            {busy && (
              <p className="text-[17px]">
                <ShinyText>{route === "fast" ? "Holding seats" : trace.some((e) => e.type === "tool_start") ? "Checking seats" : "Thinking"}</ShinyText>
              </p>
            )}

            {confirm && (
              // Card, after PrebuiltUI's simple bordered card: the one choice on screen gets the accent
              <div className="animate-enter rounded-xl border-2 border-indigo-600 bg-white p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-xl font-semibold">{confirm.movie}</p>
                    <p className="truncate text-zinc-600">{confirm.when}</p>
                    <p className="truncate text-sm text-zinc-500">{confirm.theatre}</p>
                  </div>
                  <span className={cn("shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-sm", left > 60 ? "bg-zinc-100 text-zinc-700" : "bg-amber-100 text-amber-800")}>
                    held {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
                  </span>
                </div>
                <SeatMap mine={confirm.seats} taken={confirm.taken} />
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-2xl font-semibold">₹{confirm.total}</p>
                    <p className="truncate whitespace-nowrap text-xs text-zinc-500">{confirm.seats.length} seat{confirm.seats.length > 1 ? "s" : ""} · {confirm.seats.join(", ")}</p>
                  </div>
                  <div className="flex w-full gap-2 sm:w-auto">
                    <button onClick={() => setConfirm(null)} className="whitespace-nowrap rounded-lg border border-zinc-300 px-4 py-2.5 font-medium">Not now</button>
                    <button onClick={book} disabled={left === 0} className="flex-1 whitespace-nowrap rounded-lg bg-indigo-600 px-5 py-2.5 font-semibold text-white disabled:opacity-50 sm:flex-none">
                      {left === 0 ? "Hold expired" : "Confirm booking"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {booked && (
              <div className="animate-enter flex overflow-hidden rounded-xl border border-emerald-600 bg-white">
                <div className="min-w-0 flex-1 p-4 sm:p-5">
                  <p className="text-xs font-medium uppercase tracking-wider text-emerald-700">Booked</p>
                  <p className="mt-1 truncate text-xl font-semibold">{booked.movie}</p>
                  <p className="truncate text-zinc-600">{booked.when}</p>
                  <p className="truncate text-sm text-zinc-500">{booked.theatre}</p>
                  <p className="mt-3 truncate whitespace-nowrap font-mono text-sm">{booked.seats.join(", ")} · ₹{booked.total}</p>
                </div>
                <div className="flex shrink-0 flex-col items-center justify-center gap-1 border-l border-dashed border-emerald-600 bg-emerald-50 px-3 text-center sm:px-5">
                  <p className="text-[11px] uppercase tracking-wider text-emerald-700">Ref</p>
                  <p className="whitespace-nowrap font-mono text-sm font-semibold text-emerald-800 sm:text-lg">{booked.ref}</p>
                </div>
              </div>
            )}
            {notice && <p className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-amber-800">{notice}</p>}
            {err && <p className="rounded-lg border border-red-400 bg-red-50 p-3 text-red-700">{err}</p>}
            <div ref={endRef} />
          </div>

          {/* Voice dock: one primary action */}
          <div className="border-t border-zinc-200 p-4 sm:p-5">
            <div className="flex items-center gap-3 sm:gap-5">
              <div className="relative grid h-20 w-20 shrink-0 place-items-center">
                {live && <Ripple size={80} />}
                <button
                  aria-label={handsFree ? "Turn hands-free off" : "Start talking hands-free"}
                  onClick={handsFree ? stopHandsFree : startHandsFree}
                  className={cn("relative z-10 grid h-16 w-16 place-items-center rounded-full text-white", handsFree ? "bg-indigo-600" : "bg-zinc-900")}
                >
                  <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <p aria-live="polite" className="truncate whitespace-nowrap text-lg font-medium">{busy ? <ShinyText>{STATUS_TEXT[status]}</ShinyText> : STATUS_TEXT[status]}</p>
                <form onSubmit={(e) => { e.preventDefault(); sendText(draft); }} className="mt-2 flex gap-2">
                  <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Or type" className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 py-2" />
                  <button
                    type="button"
                    onPointerDown={startPtt}
                    onPointerUp={stopPtt}
                    onPointerLeave={stopPtt}
                    className={cn("shrink-0 select-none rounded-lg border px-3 py-2 text-sm font-medium", status === "recording" ? "border-red-500 bg-red-50 text-red-700" : "border-zinc-300 text-zinc-700")}
                  >
                    Hold to talk
                  </button>
                </form>
                <p className="mt-2 truncate whitespace-nowrap text-xs text-zinc-500">Nothing books until you tap Confirm</p>
              </div>
            </div>
          </div>
        </section>

        <aside className="h-fit rounded-xl border border-zinc-200 bg-white p-5 lg:sticky lg:top-6">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">What Bookie is doing</h2>
            {route && <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", route === "fast" ? "bg-emerald-50 text-emerald-700" : "bg-indigo-50 text-indigo-700")}>{route === "fast" ? "fast path, no model" : "model"}</span>}
          </div>

          {totalMs > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs text-zinc-500">This turn <span className="font-mono text-zinc-800">{totalMs} ms</span></p>
              <div className="flex h-2 overflow-hidden rounded-full bg-zinc-100">
                {stages.map((s) => <div key={s.k} className={s.c} style={{ width: `${(100 * s.ms) / totalMs}%` }} />)}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-zinc-600">
                {stages.map((s) => (
                  <span key={s.k} className="flex items-center gap-1.5"><span className={cn("h-2 w-2 rounded-full", s.c)} />{s.k} <span className="ml-auto font-mono">{s.ms} ms</span></span>
                ))}
              </div>
            </div>
          )}

          {trace.length === 0 ? (
            <div className="mt-4 text-sm text-zinc-600">
              <p className="text-zinc-500">Every step shows up here live, with its timing.</p>
              <ol className="mt-3 space-y-2">
                {[["Speech to text", "your words, transcribed"], ["Fast path or model", "plain requests skip the model"], ["Seat hold", "an atomic lock on each seat"], ["Voice", "the reply, streamed"]].map(([t, d]) => (
                  <li key={t} className="flex gap-2.5 border-l-2 border-zinc-200 pl-2.5">
                    <span><span className="font-medium text-zinc-800">{t}</span> <span className="text-zinc-500">· {d}</span></span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <AnimatedList className="mt-4 font-mono text-[13px]">
              {trace.filter((e) => !["confirm", "route"].includes(e.type)).map((e, i) => (
                <div key={i} className="border-l-2 border-zinc-200 pl-2.5">
                  <div className="flex justify-between gap-2">
                    <span className={cn(e.type === "error" ? "text-red-600" : e.type.startsWith("tool") ? "text-indigo-700" : e.type === "barge-in" || e.type === "cancelled" ? "text-amber-700" : "text-zinc-800")}>
                      {e.type === "tool_start" ? `→ ${e.name}` : e.type === "tool_end" ? `✓ ${e.name}` : e.type === "llm" ? `model step ${e.step}` : e.type === "stt" ? "speech to text" : e.type === "tts" ? "voice started" : e.type}
                    </span>
                    <span className="text-zinc-500">{e.ms != null ? `${e.ms} ms` : e.totalMs != null ? `${e.totalMs} ms` : ""}</span>
                  </div>
                  {e.type === "tool_start" && <div className="truncate text-xs text-zinc-500">{String(e.args)}</div>}
                  {e.type === "llm" && <div className="text-xs text-zinc-500">{String(e.tokensIn)} in · {String(e.tokensOut)} out</div>}
                  {(e.type === "cancelled" || e.type === "ignored") && <div className="text-xs text-zinc-500">{String(e.reason)}</div>}
                  {e.type === "tool_end" && (
                    <details className="text-xs text-zinc-500">
                      <summary className="cursor-pointer">result</summary>
                      <pre className="whitespace-pre-wrap">{JSON.stringify(e.result, null, 1)}</pre>
                    </details>
                  )}
                </div>
              ))}
            </AnimatedList>
          )}
        </aside>
      </main>
    </div>
  );
}
