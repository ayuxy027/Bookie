// Whole-app suite, 5 tests: tool contract + fast-path parser, booking lifecycle, expiry, a real multi-process race, and the HTTP routes end to end.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTool, holdLine, localDate } from "../src/lib/tools";
import { parseBooking } from "../src/lib/intent";
import { db, openDb, searchShows, confirmBooking } from "../src/lib/db";
import { histories, trim, type Msg } from "../src/lib/history";

process.env.DB_PATH = ":memory:"; // read lazily on first query, so setting it here is in time
process.env.OPENROUTER_KEY = "test-key";
const logs: string[] = [];
console.log = (m: string) => void logs.push(m); // keep the audit log out of test output, but inspectable

type R = Record<string, unknown>;
const me = { userId: "u1" };
const them = { userId: "u2" };
const call = (name: string, args: unknown, ctx = me) => runTool(name, JSON.stringify(args), ctx);
const showId = () => searchShows()[0].id;
const confirmOf = (r: R) => {
  if (!r.confirm) throw new Error(`expected a hold, got ${JSON.stringify(r)}`);
  return r.confirm as { ref: string; seats: string[]; total: number };
};

test("1. tool contract + parser: bad calls return errors, local time only, trim keeps tool pairs, fast path parses only clear requests", () => {
  const S = (id: string, movie: string, theatre: string, startsAt: string) => ({ id, movie, theatre, startsAt, price: 300 });
  const fixture = [S("i1", "Interstellar", "PVR Phoenix", "2026-11-11T14:00:00Z"), S("i2", "Interstellar", "INOX Nariman", "2026-11-11T16:30:00Z"), S("d1", "Dune: Part Two", "PVR Phoenix", "2026-11-12T15:30:00Z"), S("k1", "The Dark Knight", "Cinepolis Andheri", "2026-11-12T14:45:00Z")];
  const parse = (t: string) => parseBooking(t, fixture, localDate, "2026-11-11", "2026-11-12");
  assert.deepEqual(parse("Book two tickets for Interstellar tonight, center seats please."), { showId: "i1", count: 2, prefer: "middle" });
  assert.deepEqual(parse("book 2 tickets for interstellar tonight at inox"), { showId: "i2", count: 2, prefer: "middle" });
  assert.deepEqual(parse("Three seats for Dune tomorrow in the back row."), { showId: "d1", count: 3, prefer: "back" });
  assert.deepEqual(parse("one ticket for the dark knight"), { showId: "k1", count: 1, prefer: "middle" }); // only one day exists
  assert.deepEqual(parse("two tickets for interstellar"), { showId: "i1", count: 2, prefer: "middle" }); // one day, soonest show wins
  for (const doubt of ["What's playing tomorrow evening?", "Can I get two seats together for the Batman movie?", "two tickets for interstellar at 10 pm", "tickets for dune tomorrow", "two tickets for interstellar or dune tonight", "two tickets for dune tonight"])
    assert.equal(parse(doubt), null, doubt); // any doubt goes to the LLM, never a guessed booking

  assert.match(String(call("drop_tables", {}).error), /valid tools: search_shows, hold_seats/);
  assert.match(String(runTool("hold_seats", "{not json", me).error), /not valid JSON/);
  assert.match(String(call("hold_seats", { showId: showId() }).error), /pass seats or count/);
  assert.match(String(call("hold_seats", { showId: showId(), seats: ["Z9"] }).error), /bad arguments/);
  assert.match(String(call("hold_seats", { showId: "nope", count: 1 }).error), /unknown showId/);

  const shows = call("search_shows", { movie: "inter" }).shows as R[];
  assert.ok(shows.length > 0 && shows.every((s) => s.movie === "Interstellar"));
  for (const s of shows) {
    assert.ok(!("startsAt" in s) && /\d:\d\d/.test(String(s.when))); // model only ever sees local time
    assert.equal(s.seatsFree, 37); // 40 seats minus 3 seeded sales
  }

  const turn = (i: number): Msg[] => [
    { role: "user", content: `q${i}` },
    { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "search_shows", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `c${i}`, content: "{}" },
    { role: "assistant", content: "a" },
  ];
  const t = trim(Array.from({ length: 11 }, (_, i) => turn(i)).flat().slice(1));
  assert.equal(t[0].role, "user");
  assert.ok(t.length <= 40);
});

test("2. lifecycle: auto-pick, conflicts, re-hold releases, only the owner confirms, double submit books once", () => {
  const id = showId();
  const first = confirmOf(call("hold_seats", { showId: id, count: 2 }));
  const [a, b] = first.seats;
  assert.ok(a[0] === b[0] && Math.abs(Number(a.slice(1)) - Number(b.slice(1))) === 1, `adjacent pair, got ${first.seats}`);

  const clash = call("hold_seats", { showId: id, seats: [a] }, them);
  assert.deepEqual(clash.heldByOthers, [a]);
  assert.ok((clash.suggest as string[]).length === 1 && !(clash.suggest as string[]).includes(a));

  const second = confirmOf(call("hold_seats", { showId: id, seats: ["E1", "E2"] })); // replaces my first hold
  confirmOf(call("hold_seats", { showId: id, seats: [a] }, them)); // old seat released, so this succeeds
  assert.match(holdLine("u1"), /seats E1, E2, expires in [45]m/);

  assert.ok("error" in confirmBooking("u2", second.ref)); // someone else's ref
  assert.ok("error" in confirmBooking("u1", first.ref)); // released hold
  const x = confirmBooking("u1", second.ref);
  const y = confirmBooking("u1", second.ref);
  assert.ok("booking" in x && "booking" in y);
  assert.deepEqual(x.booking, y.booking);
  assert.equal(x.booking.total, second.total);
  assert.deepEqual(call("hold_seats", { showId: id, seats: ["E1"] }, them).sold, ["E1"]);
});

test("3. expiry: an expired hold frees its seats, the agent is told, and a late confirm fails cleanly", () => {
  const id = searchShows()[1].id;
  const age = (ref: string) => db().prepare("update seats set expires_at = ? where ref = ?").run(Date.now() - 60_000, ref);

  const mine = confirmOf(call("hold_seats", { showId: id, seats: ["B1"] }, { userId: "u3" }));
  age(mine.ref);
  assert.match(holdLine("u3"), /EXPIRED/);
  const expired = confirmBooking("u3", mine.ref);
  assert.ok("error" in expired && /expired/.test(expired.error));

  confirmOf(call("hold_seats", { showId: id, seats: ["B1"] }, { userId: "u4" })); // expired row is overwritten
  const late = confirmBooking("u3", mine.ref);
  assert.ok("error" in late && /no longer exists/.test(late.error));
});

test("4. race: 8 processes grab the same seat on one database file, exactly one wins", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "bookie-")), "race.db");
  const d = openDb(file);
  const id = (d.prepare("select id from shows where starts_at > ? order by starts_at limit 1").get(new Date().toISOString()) as { id: string }).id;
  d.close();
  const start = Date.now() + 1500; // all processes spin until the same instant, then claim
  const script = `const m = await import(${JSON.stringify(resolve("src/lib/db.ts"))});
    while (Date.now() < ${start}) {}
    const r = (m.holdSeats ? m : m.default).holdSeats("racer" + process.env.N, ${JSON.stringify(id)}, ["C3"]);
    process.stdout.write("RESULT:" + ("ref" in r) + "\\n");`;
  const runs = await Promise.all(Array.from({ length: 8 }, (_, n) => new Promise<string>((ok, fail) => {
    const p = spawn(process.execPath, ["--no-warnings", "--import", "jiti/register", "--input-type=module", "-e", script], { env: { ...process.env, DB_PATH: file, N: String(n) } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(`racer ${n} exited ${code}: ${out}`))));
  })));
  const wins = runs.map((o) => o.match(/RESULT:(true|false)/)?.[1]);
  assert.ok(wins.every((w) => w !== undefined), runs.join("\n"));
  assert.equal(wins.filter((w) => w === "true").length, 1);
  const check = openDb(file);
  assert.equal((check.prepare("select count(*) n from seats where show_id = ? and seat = 'C3'").get(id) as { n: number }).n, 1);
  check.close();
});

test("5. HTTP end to end with scripted models: fast path, voice turn, confirm route, chat history, cancel, step cap, failures, speak", async () => {
  const { POST: turn } = await import("../src/app/api/turn/route");
  const { POST: confirm } = await import("../src/app/api/confirm/route");
  const { POST: speak } = await import("../src/app/api/speak/route");
  const id = searchShows("Oppenheimer")[0].id;

  let llm: (body: R, signal: AbortSignal) => R | Response | Promise<Response> = () => { throw new Error("llm not scripted"); };
  const sent: R[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/audio/transcriptions")) return Response.json({ text: "two for oppenheimer" });
    if (url.endsWith("/audio/speech")) return new Response("ID3", { headers: { "content-type": "audio/mpeg" } });
    const body = JSON.parse(String(init.body));
    sent.push(body);
    const r = await llm(body, init.signal as AbortSignal);
    return r instanceof Response ? r : Response.json(r);
  }) as typeof fetch;
  const usage = { prompt_tokens: 10, completion_tokens: 5 };
  const toolMsg = (name: string, args: R) => ({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: `t${sent.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage });
  const events = async (res: Response) => (await res.text()).split("\n\n").filter(Boolean).map((l) => JSON.parse(l.slice(6)) as R);
  const text = (t: string) => { const f = new FormData(); f.append("text", t); return f; };
  const post = (route: (r: Request) => Promise<Response>, sid: string, body: BodyInit, json = false) =>
    route(new Request("http://x/api", { method: "POST", body, headers: { cookie: `sid=${sid}`, ...(json ? { "content-type": "application/json" } : {}) } }));

  // fast path: a plain booking is held with zero LLM calls and a fixed reply
  const fast = await events(await post(turn, "F", text("Book one ticket for Oppenheimer tomorrow")));
  assert.deepEqual(fast.map((e) => e.type), ["route", "tool_start", "tool_end", "confirm", "reply"]);
  assert.equal(sent.length, 0);
  assert.match(String(fast.at(-1)?.text), /held seat .* for Oppenheimer .* Tap confirm/);

  // LLM path: stt -> search -> hold, then the fixed reply replaces a third LLM call; shows ride along in context
  const script = [toolMsg("search_shows", { movie: "Oppenheimer" }), toolMsg("hold_seats", { showId: id, count: 2 })];
  llm = () => { const next = script.shift(); if (!next) throw new Error("script exhausted"); return next; };
  const fd = new FormData();
  fd.append("audio", new Blob([new Uint8Array(100)], { type: "audio/webm" }));
  const ev = await events(await post(turn, "A", fd));
  assert.deepEqual(ev.map((e) => e.type), ["stt", "route", "llm", "tool_start", "tool_end", "llm", "tool_start", "tool_end", "confirm", "reply"]);
  assert.match(JSON.stringify(sent.at(-1)?.messages), /Upcoming shows .*Oppenheimer/);
  assert.match(String(ev.at(-1)?.text), /Tap confirm to book/);
  const ref = String(ev.find((e) => e.type === "confirm")?.ref);

  // confirm route: malformed, bad ref, wrong user, owner, replay; the agent hears about the tap
  assert.equal((await post(confirm, "A", "garbage", true)).status, 400);
  assert.equal((await post(confirm, "A", JSON.stringify({ ref: "short" }), true)).status, 400);
  assert.equal((await post(confirm, "B", JSON.stringify({ ref }), true)).status, 409);
  const ok1 = await post(confirm, "A", JSON.stringify({ ref }), true);
  const ok2 = await post(confirm, "A", JSON.stringify({ ref }), true);
  assert.equal(ok1.status, 200);
  assert.deepEqual(await ok1.json(), await ok2.json());
  assert.match(String(histories.get("A").at(-1)?.content), /tapped confirm. Booking .* is final/);

  // chat history survives a reload: the transcript shows words and replies, not tool plumbing; DELETE clears it
  const { GET: history, DELETE: clearHistory } = await import("../src/app/api/history/route");
  const get = (sid: string) => history(new Request("http://x/api/history", { headers: { cookie: `sid=${sid}` } })).then((r) => r.json());
  const { lines } = await get("A");
  assert.deepEqual(lines.map((l: R) => l.who), ["you", "bookie"]);
  assert.equal(lines[0].text, "two for oppenheimer");
  assert.deepEqual((await get("B")).lines, []); // another session sees nothing
  await clearHistory(new Request("http://x/api/history", { method: "DELETE", headers: { cookie: "sid=A" } }));
  assert.deepEqual((await get("A")).lines, []);

  // step cap: a model that never stops calling tools gets cut off with a spoken message
  llm = () => toolMsg("search_shows", {});
  const capped = await events(await post(turn, "C", text("loop")));
  assert.equal(capped.filter((e) => e.type === "llm").length, 8);
  assert.equal(capped.at(-1)?.capped, true);

  // provider failure surfaces the status; an empty request is a 400
  llm = () => new Response("upstream down", { status: 500 });
  const failed = await events(await post(turn, "D", text("hi")));
  assert.match(String(failed.at(-1)?.message), /chat\/completions 500: upstream down/);
  assert.equal((await post(turn, "D", new FormData())).status, 400);

  // barge-in: the browser aborts mid-turn and the server stops the in-flight LLM call
  llm = (_, signal) => new Promise<Response>((_, fail) => signal.addEventListener("abort", () => fail(new Error("aborted"))));
  const ac = new AbortController();
  const pending = turn(new Request("http://x/api", { method: "POST", body: text("hmm let me think"), headers: { cookie: "sid=E" }, signal: ac.signal }));
  setTimeout(() => ac.abort(), 30);
  await pending;
  for (let i = 0; i < 50 && !logs.some((l) => /user=E.*CANCELLED/.test(l)); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(logs.some((l) => /user=E.*CANCELLED/.test(l)), `turn should log CANCELLED, got:\n${logs.filter((l) => l.includes("user=E") || l.includes("openrouter")).slice(-4).join("\n")}`);

  // speak: validates input, streams audio (POST and GET)
  assert.equal((await post(speak, "A", JSON.stringify({ text: "" }), true)).status, 400);
  const audio = await post(speak, "A", JSON.stringify({ text: "hello" }), true);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-type"), "audio/mpeg");
  const { GET: speakGet } = await import("../src/app/api/speak/route");
  assert.equal((await speakGet(new Request("http://x/api/speak?text=hi"))).status, 200);
  assert.equal((await speakGet(new Request("http://x/api/speak"))).status, 400);
});
