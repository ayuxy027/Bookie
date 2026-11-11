import { session, withCookie } from "@/lib/openrouter";
import { confirmBooking } from "@/lib/db";
import { noteEvent } from "@/lib/history";
import { log } from "@/lib/log";

// The only path that books. Needs the user's own session plus the hold ref shown in their UI.
export async function POST(req: Request) {
  const { userId, setCookie } = session(req);
  let body: unknown;
  try { body = await req.json(); } catch { return withCookie(Response.json({ error: "body must be JSON {ref}" }, { status: 400 }), setCookie); }
  const ref = (body as { ref?: unknown }).ref;
  if (typeof ref !== "string" || !/^[\w-]{36}$/.test(ref)) return withCookie(Response.json({ error: "ref must be the 36-char hold ref" }, { status: 400 }), setCookie);
  const r = confirmBooking(userId, ref);
  log("confirm", `user=${userId.slice(0, 8)} ref=${ref.slice(0, 8)} -> ${"error" in r ? r.error : `booked ${r.booking.seats.join(",")}`}`);
  if ("booking" in r) noteEvent(userId, `User tapped confirm. Booking ${ref.slice(0, 8).toUpperCase()} is final: seats ${r.booking.seats.join(", ")}, total ${r.booking.total} rupees.`);
  else noteEvent(userId, `User tapped confirm but it failed: ${r.error}`);
  return withCookie(Response.json(r, { status: "error" in r ? 409 : 200 }), setCookie);
}
