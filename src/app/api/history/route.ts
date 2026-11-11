import { session, withCookie } from "@/lib/openrouter";
import { histories, transcript } from "@/lib/history";

// The session's past conversation, so a reload picks up where the user left off.
export async function GET(req: Request) {
  const { userId, setCookie } = session(req);
  return withCookie(Response.json({ lines: transcript(userId) }), setCookie);
}

// Stored memory is visible and deletable by the user.
export async function DELETE(req: Request) {
  const { userId, setCookie } = session(req);
  histories.clear(userId);
  return withCookie(Response.json({ cleared: true }), setCookie);
}
