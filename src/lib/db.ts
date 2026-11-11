import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { timed } from "./log";

export type Show = { id: string; movie: string; theatre: string; startsAt: string; price: number };
export type Booking = { ref: string; showId: string; seats: string[]; total: number };

const ROWS = ["A", "B", "C", "D", "E"];
const allSeats = ROWS.flatMap((r) => Array.from({ length: 8 }, (_, i) => `${r}${i + 1}`));
const HOLD_MS = 5 * 60_000;

// seats: one row per claimed seat, and the row is the lock. PK (show_id, seat) means one owner per seat.
// no row = free | expires_at in future = held | expires_at past = expired, counts as free | null = sold
// ref = hold id while held, booking reference once sold, and the confirm token (only valid with the owner's session).
const SCHEMA = `
create table if not exists shows (id text primary key, movie text not null, theatre text not null, starts_at text not null, price integer not null);
create table if not exists seats (show_id text not null references shows(id), seat text not null, user_id text not null, ref text not null, expires_at integer, primary key (show_id, seat));
create index if not exists seats_ref on seats(ref);
create index if not exists seats_user on seats(user_id);
-- chat history per session, one row per message, so a reload or restart keeps the conversation
create table if not exists messages (user_id text not null, seq integer not null, msg text not null, primary key (user_id, seq));
`;

const SEED: [string, string, number, string, number][] = [
  ["Interstellar", "PVR Phoenix", 0, "19:30", 350],
  ["Interstellar", "INOX Nariman", 0, "22:00", 300],
  ["Dune: Part Two", "PVR Phoenix", 0, "18:00", 320],
  ["Dune: Part Two", "PVR Phoenix", 1, "21:00", 320],
  ["Oppenheimer", "INOX Nariman", 1, "17:45", 280],
  ["The Dark Knight", "Cinepolis Andheri", 1, "20:15", 250],
];

// Seeds today's and tomorrow's shows on every start. Ids carry the date so reruns are no-ops.
function seed(d: DatabaseSync) {
  const show = d.prepare("insert or ignore into shows values (?, ?, ?, ?, ?)");
  const sold = d.prepare("insert or ignore into seats values (?, ?, 'seed', 'seed', null)");
  SEED.forEach(([movie, theatre, off, hhmm, price], i) => {
    const t = new Date();
    t.setDate(t.getDate() + off);
    const [h, m] = hhmm.split(":").map(Number);
    t.setHours(h, m, 0, 0);
    const id = `s${i + 1}-${t.toISOString().slice(0, 10)}`;
    show.run(id, movie, theatre, t.toISOString(), price);
    for (const s of i % 2 ? ["C4", "C5", "D4"] : ["A1", "A2", "E8"]) sold.run(id, s);
  });
}

export function openDb(path = process.env.DB_PATH ?? "data/bookie.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  // busy_timeout: a second process waits up to 5s for the write lock instead of failing with "database is locked"
  d.exec("pragma busy_timeout = 5000; pragma journal_mode = wal; pragma foreign_keys = on;"); // busy_timeout first: switching to wal itself needs the lock
  d.exec(SCHEMA);
  seed(d);
  return d;
}

// globalThis keeps one connection across Next.js dev hot reloads. The schema is re-applied when it changes,
// otherwise a table added during development never exists on the cached connection.
const g = globalThis as unknown as { __sqlite?: DatabaseSync; __schema?: string };
export const db = () => {
  g.__sqlite ??= openDb();
  if (g.__schema !== SCHEMA) {
    g.__sqlite.exec(SCHEMA);
    g.__schema = SCHEMA;
  }
  return g.__sqlite;
};

type Param = string | number | null;
const brief = (sql: string, p: Param[]) => `${sql.replace(/\s+/g, " ").slice(0, 90)} ${JSON.stringify(p)}`;
// Every query goes through these three so each one is logged with its timing.
const q = {
  all: <T>(sql: string, ...p: Param[]) => timed("sql", brief(sql, p), () => db().prepare(sql).all(...p) as T[]),
  get: <T>(sql: string, ...p: Param[]) => timed("sql", brief(sql, p), () => db().prepare(sql).get(...p) as T | undefined),
  run: (sql: string, ...p: Param[]) => timed("sql", brief(sql, p), () => Number(db().prepare(sql).run(...p).changes)),
};

// begin immediate takes the write lock up front, so two writers queue instead of deadlocking mid-transaction
function tx<T>(fn: () => T): T {
  timed("sql", "begin immediate", () => db().exec("begin immediate"));
  try {
    const r = fn();
    timed("sql", "commit", () => db().exec("commit"));
    return r;
  } catch (e) {
    timed("sql", "rollback", () => db().exec("rollback"));
    throw e;
  }
}

const toShow = (r: Record<string, unknown>): Show => ({ id: String(r.id), movie: String(r.movie), theatre: String(r.theatre), startsAt: String(r.starts_at), price: Number(r.price) });

export function searchShows(movie?: string, date?: string): Show[] {
  return q.all<Record<string, unknown>>(
    "select * from shows where starts_at > ? and (? is null or lower(movie) like '%' || lower(?) || '%') and (? is null or starts_at like ? || '%') order by starts_at",
    new Date().toISOString(), movie ?? null, movie ?? null, date ?? null, date ?? null,
  ).map(toShow);
}

export function getShow(id: string): Show | null {
  const r = q.get<Record<string, unknown>>("select * from shows where id = ?", id);
  return r ? toShow(r) : null;
}

// Who blocks which seat right now, from one user's point of view. Expired holds count as free.
export function seatMap(showId: string, userId = "") {
  const now = Date.now();
  const rows = q.all<{ seat: string; user_id: string; expires_at: number | null }>("select seat, user_id, expires_at from seats where show_id = ?", showId);
  const sold = new Set(rows.filter((r) => r.expires_at === null).map((r) => r.seat));
  const heldByOthers = new Set(rows.filter((r) => r.expires_at !== null && r.expires_at > now && r.user_id !== userId).map((r) => r.seat));
  return { sold, heldByOthers, free: allSeats.filter((s) => !sold.has(s) && !heldByOthers.has(s)) };
}

// Best seats: adjacent in one row, closest to center, rows ordered by preference. Falls back to best singles.
export function pickSeats(free: string[], count: number, prefer: "front" | "middle" | "back" = "middle") {
  const rowOrder = { front: ["A", "B", "C", "D", "E"], middle: ["C", "D", "B", "E", "A"], back: ["E", "D", "C", "B", "A"] }[prefer];
  const off = (s: string) => Math.abs(Number(s.slice(1)) - 4.5);
  const set = new Set(free);
  for (const r of rowOrder) {
    const runs: string[][] = [];
    for (let start = 1; start + count - 1 <= 8; start++) {
      const run = Array.from({ length: count }, (_, i) => `${r}${start + i}`);
      if (run.every((s) => set.has(s))) runs.push(run);
    }
    if (runs.length) return runs.sort((a, b) => a.reduce((t, s) => t + off(s), 0) - b.reduce((t, s) => t + off(s), 0))[0];
  }
  return free.sort((a, b) => rowOrder.indexOf(a[0]) - rowOrder.indexOf(b[0]) || off(a) - off(b)).slice(0, count);
}

class Taken extends Error {}

// The lock. Releases the user's previous hold, then claims each seat with one conditional upsert:
// the row is taken only if no row exists or the existing hold has expired. Fewer rows changed than asked = roll back all.
type HoldResult = { ref: string; seats: string[]; expiresAt: number } | { error: "taken"; sold: string[]; held: string[]; free: string[] };
export function holdSeats(userId: string, showId: string, seats: string[]): HoldResult {
  const now = Date.now();
  const ref = randomUUID();
  try {
    tx(() => {
      q.run("delete from seats where user_id = ? and expires_at is not null", userId);
      const claim = `insert into seats values (?, ?, ?, ?, ?) on conflict (show_id, seat) do update
         set user_id = excluded.user_id, ref = excluded.ref, expires_at = excluded.expires_at
         where seats.expires_at is not null and seats.expires_at < ?`;
      const changed = seats.reduce((n, s) => n + q.run(claim, showId, s, userId, ref, now + HOLD_MS, now), 0);
      if (changed < seats.length) throw new Taken();
    });
  } catch (e) {
    if (!(e instanceof Taken)) throw e;
    const m = seatMap(showId, userId);
    return { error: "taken", sold: seats.filter((s) => m.sold.has(s)), held: seats.filter((s) => m.heldByOthers.has(s)), free: m.free };
  }
  return { ref, seats, expiresAt: now + HOLD_MS };
}

function bookingFor(userId: string, ref: string): Booking | null {
  const rows = q.all<{ show_id: string; seat: string }>("select show_id, seat from seats where ref = ? and user_id = ? and expires_at is null", ref, userId);
  if (!rows.length) return null;
  // total is computed from the current show price; store the paid amount once real payments exist
  return { ref, showId: rows[0].show_id, seats: rows.map((r) => r.seat), total: getShow(rows[0].show_id)!.price * rows.length };
}

// Irreversible. Only the owner's unexpired rows flip to sold. A replay returns the same booking (idempotent).
export function confirmBooking(userId: string, ref: string): { booking: Booking } | { error: string } {
  try {
    return tx(() => {
    const done = bookingFor(userId, ref);
    if (done) return { booking: done };
    const held = q.get<{ n: number }>("select count(*) n from seats where ref = ? and user_id = ?", ref, userId)!.n;
    if (!held) return { error: "this hold no longer exists, ask Bookie to hold the seats again" };
    const changed = q.run("update seats set expires_at = null where ref = ? and user_id = ? and expires_at > ?", ref, userId, Date.now());
    if (changed !== held) throw new Taken(); // rolls back any partial flip
    return { booking: bookingFor(userId, ref)! };
    });
  } catch (e) {
    if (e instanceof Taken) return { error: "hold expired, ask Bookie to hold the seats again" };
    throw e;
  }
}

// The user's latest hold, live or expired in the last 10 minutes. Feeds the per-turn state line.
export function currentHold(userId: string) {
  const rows = q.all<{ show_id: string; seat: string; expires_at: number }>("select show_id, seat, expires_at from seats where user_id = ? and expires_at > ? order by seat", userId, Date.now() - 10 * 60_000);
  return rows.length ? { showId: rows[0].show_id, seats: rows.map((r) => r.seat), expiresAt: rows[0].expires_at } : null;
}

// Chat history for one session, oldest first.
export function loadMessages(userId: string): unknown[] {
  return q.all<{ msg: string }>("select msg from messages where user_id = ? order by seq", userId).map((r) => JSON.parse(r.msg));
}

// Replaces the session's history in one transaction, so a half-written history is never read back.
export function saveMessages(userId: string, msgs: unknown[]) {
  tx(() => {
    q.run("delete from messages where user_id = ?", userId);
    msgs.forEach((m, i) => q.run("insert into messages values (?, ?, ?)", userId, i, JSON.stringify(m)));
  });
}
