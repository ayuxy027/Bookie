import { z } from "zod";
import { searchShows, getShow, seatMap, pickSeats, holdSeats, currentHold } from "./db";
import { timed } from "./log";

type Ctx = { userId: string };

export const TZ = "Asia/Kolkata";
// Models read ISO UTC literally ("14:00Z" became "2 PM"), so tools hand back theatre-local time only.
export const local = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const tools = {
  search_shows: {
    description: "Find showtimes. Use first whenever the user names a movie, theatre or day. Returns show ids for hold_seats.",
    args: z.object({
      movie: z.string().optional().describe("partial movie title, any case"),
      date: z.string().optional().describe("YYYY-MM-DD, omit for all upcoming days"),
    }),
    run: (a: { movie?: string; date?: string }, c: Ctx) => ({
      shows: searchShows(a.movie, a.date).map((s) => {
        const m = seatMap(s.id, c.userId);
        return { id: s.id, movie: s.movie, theatre: s.theatre, when: local(s.startsAt), price: s.price, seatsFree: m.free.length, heldByOthers: m.heldByOthers.size };
      }),
    }),
  },
  hold_seats: {
    description:
      "Hold seats for 5 minutes and show the user a confirm card to tap. Pass exact seats if the user named them, otherwise count (and prefer) to auto-pick the best adjacent seats. Replaces the user's previous hold. You cannot book; only the user's tap books.",
    args: z
      .object({
        showId: z.string(),
        seats: z.array(z.string().regex(/^[A-E][1-8]$/)).min(1).max(8).optional().describe("exact seats, rows A (front) to E (back), 1-8, 4 and 5 are center"),
        count: z.number().int().min(1).max(8).optional(),
        prefer: z.enum(["front", "middle", "back"]).optional(),
      })
      .refine((a) => a.seats || a.count, "pass seats or count"),
    run: (a: { showId: string; seats?: string[]; count?: number; prefer?: "front" | "middle" | "back" }, c: Ctx) => {
      const show = getShow(a.showId);
      if (!show) return { error: `unknown showId ${a.showId}, call search_shows first` };
      const want = a.seats ?? pickSeats(seatMap(show.id, c.userId).free, a.count as number, a.prefer);
      if (!a.seats && want.length < (a.count as number)) return { error: `only ${want.length} seats free for this show` };
      const r = holdSeats(c.userId, show.id, want);
      // tell the model exactly what happened so it can say "C4 was just booked, C3 and C6 are free"
      if ("error" in r) return { error: "some seats are not available", sold: r.sold, heldByOthers: r.held, suggest: pickSeats(r.free, want.length, a.prefer) };
      const after = seatMap(show.id, c.userId);
      const confirm = { ref: r.ref, movie: show.movie, theatre: show.theatre, when: local(show.startsAt), seats: r.seats, total: show.price * r.seats.length, expiresAt: r.expiresAt, taken: [...after.sold, ...after.heldByOthers] };
      return { status: "held, confirm card shown, user must tap it to book", expiresInMin: 5, confirm };
    },
  },
} as const;

type Name = keyof typeof tools;

export const toolSpecs = Object.entries(tools).map(([name, t]) => ({
  type: "function" as const,
  function: { name, description: t.description, parameters: z.toJSONSchema(t.args) },
}));

// Validates model args and runs the tool. Bad calls go back to the model as data so it can recover; real bugs throw.
export function runTool(name: string, rawArgs: string, ctx: Ctx): Record<string, unknown> {
  if (!(name in tools)) return { error: `unknown tool ${name}, valid tools: ${Object.keys(tools).join(", ")}` };
  const t = tools[name as Name];
  let json: unknown;
  try { json = JSON.parse(rawArgs || "{}"); } catch { return { error: "arguments were not valid JSON" }; }
  const parsed = t.args.safeParse(json);
  if (!parsed.success) return { error: `bad arguments: ${z.prettifyError(parsed.error)}` };
  return timed("tool", `${name} ${rawArgs}`, () => (t.run as (a: unknown, c: Ctx) => Record<string, unknown>)(parsed.data, ctx));
}

export const localDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD in theatre time

// Upcoming shows as compact rows for the prompt, so the model can hold directly without a search_shows round trip.
export function showsContext(userId: string) {
  return searchShows().map((s) => `${s.id} | ${s.movie} | ${s.theatre} | ${local(s.startsAt)} | ${s.price} rupees | ${seatMap(s.id, userId).free.length} free`).join("\n");
}

type Confirm = { movie: string; theatre: string; when: string; seats: string[]; total: number };
// Fixed spoken reply after a successful hold. Deterministic, so no LLM call is spent just to phrase it.
export function holdReply(c: Confirm) {
  const seats = c.seats.length > 1 ? `${c.seats.slice(0, -1).join(", ")} and ${c.seats.at(-1)}` : c.seats[0];
  return `I've held seat${c.seats.length > 1 ? "s" : ""} ${seats} for ${c.movie} at ${c.theatre}, ${c.when}. That's ${c.total} rupees. Tap confirm to book.`;
}

// One line of live state added to every turn, so the agent knows if the hold is alive without a tool call.
export function holdLine(userId: string) {
  const h = currentHold(userId);
  if (!h) return "User has no active hold.";
  const show = getShow(h.showId);
  if (!show) throw new Error(`hold points at missing show ${h.showId}`);
  const left = Math.round((h.expiresAt - Date.now()) / 1000);
  return left > 0
    ? `User's hold: ${show.movie}, ${local(show.startsAt)}, seats ${h.seats.join(", ")}, expires in ${Math.floor(left / 60)}m${left % 60}s, waiting for their tap.`
    : `User's hold on ${show.movie} seats ${h.seats.join(", ")} EXPIRED ${Math.round(-left / 60)} min ago. Those seats may be taken; offer to hold again.`;
}
