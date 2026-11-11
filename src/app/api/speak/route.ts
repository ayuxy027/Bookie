import { MODELS, or } from "@/lib/openrouter";

// Text to speech proxy so the key stays on the server. Streams audio bytes straight through as they arrive.
async function synth(text: unknown) {
  if (typeof text !== "string" || !text.trim() || text.length > 1000) return Response.json({ error: "text must be 1-1000 chars" }, { status: 400 });
  try {
    const r = await or("/audio/speech", JSON.stringify({ model: MODELS.tts, input: text, voice: MODELS.voice, response_format: "mp3" }), 15_000);
    const type = r.headers.get("content-type");
    if (!type?.startsWith("audio/")) throw new Error(`TTS returned ${type}, expected audio`);
    return new Response(r.body, { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

// GET lets an <audio src> start playing on the first bytes instead of waiting for the whole file.
export async function GET(req: Request) {
  return synth(new URL(req.url).searchParams.get("text"));
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "body must be JSON {text}" }, { status: 400 }); }
  return synth((body as { text?: unknown }).text);
}
