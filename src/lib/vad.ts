// Voice activity detection: Silero VAD in the browser via vad-web, self-hosted from /vad (copied on npm install)
// and loaded only when the user taps Start, so the first page load stays light.
const ORT = "/vad/";
const VAD_WEB = "/vad/";

// The only tuning knobs. Tuned with `npm run bench:vad` (Silero v5 on clips with known pauses), not by feel.
export const START_THRESHOLD = 0.5; // frame speech probability that counts as speech. bench: 0 false starts on -34dB noise
export const STOP_THRESHOLD = 0.35; // below this is silence; the gap between the two stops flicker
export const MIN_SPEECH_MS = 250; // shorter blips (cough, click) never start a turn
export const SILENCE_MS = 700; // silence that ends a turn. bench: smallest value with 0/3 splits at a 500ms pause (500 split 2/3), ends ~840ms after speech
export const PRE_ROLL_MS = 300; // audio kept from before speech start, so "book" is not "ook"
export const MAX_TURN_MS = 15_000; // force-end a turn in a noisy room
export const BARGE_IN_MS = 400; // sustained speech needed to interrupt the agent; longer than MIN_SPEECH_MS so "yeah" does not

export type MicVAD = { start: () => Promise<void>; pause: () => Promise<void>; destroy: () => Promise<void> };
type VadModule = {
  MicVAD: { new: (o: Record<string, unknown>) => Promise<MicVAD> };
  utils: { encodeWAV: (samples: Float32Array) => ArrayBuffer };
};
export type VadCallbacks = {
  onSpeechRealStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onVADMisfire: () => void;
  onFrameProcessed: (p: { isSpeech: number }) => void;
};

function script(src: string) {
  return new Promise<void>((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => ok();
    s.onerror = () => fail(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

// Loads the model and opens the mic with echo cancellation, noise suppression and auto gain. Throws with a specific reason.
export async function startVad(cb: VadCallbacks) {
  await script(`${ORT}ort.wasm.min.js`);
  await script(`${VAD_WEB}bundle.min.js`);
  const v = (window as unknown as { vad?: VadModule }).vad;
  if (!v?.MicVAD) throw new Error("vad-web loaded but did not register window.vad");
  const mic = await v.MicVAD.new({
    model: "v5",
    baseAssetPath: VAD_WEB,
    onnxWASMBasePath: ORT,
    positiveSpeechThreshold: START_THRESHOLD,
    negativeSpeechThreshold: STOP_THRESHOLD,
    minSpeechMs: MIN_SPEECH_MS,
    redemptionMs: SILENCE_MS,
    preSpeechPadMs: PRE_ROLL_MS,
    submitUserSpeechOnPause: true, // MAX_TURN_MS forces an end by pausing, which must still send the audio
    startOnLoad: true,
    getStream: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
    ...cb,
  });
  return { mic, wav: (a: Float32Array) => new Blob([v.utils.encodeWAV(a)], { type: "audio/wav" }) };
}
