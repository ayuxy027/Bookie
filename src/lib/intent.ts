import type { Show } from "./db";

type Prefer = "front" | "middle" | "back";
type BookingIntent = { showId: string; count: number; prefer: Prefer };

const NUM: Record<string, number> = { one: 1, a: 1, an: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
// Words that mean the user is asking, comparing or changing something. Any of them sends the turn to the LLM.
const DOUBT = /\?|\b(what|which|when|where|how|why|cancel|change|instead|not|don'?t|or|price|cost|available|together|next to|cheap|cheapest)\b/;
// An explicit clock time or part of day needs judgement about which show, so the LLM takes it.
const TIME = /\b\d{1,2}(:\d\d)?\s*(am|pm)\b|\b\d{1,2}:\d\d\b|o'?clock|\b(morning|afternoon|late|early|matinee)\b/;

const movieKey = (title: string) => title.toLowerCase().replace(/^the\s+/, "").split(":")[0].trim();
const theatreKey = (name: string) => name.toLowerCase().split(" ")[0];

// Deterministic fast path for the common request "N tickets for MOVIE DAY [theatre] [front|middle|back]".
// Returns null on any doubt, so a wrong guess is never booked; the LLM handles everything else.
export function parseBooking(raw: string, shows: Show[], localDate: (iso: string) => string, today: string, tomorrow: string): BookingIntent | null {
  const text = raw.toLowerCase().replace(/[.,!]/g, " ");
  if (!/\b(book|tickets?|seats?)\b/.test(text) || DOUBT.test(text) || TIME.test(text)) return null;

  const count = Number(text.match(/\b(\d)\s+(tickets?|seats?)\b/)?.[1] ?? NUM[text.match(/\b(one|a|an|single|two|three|four|five|six|seven|eight)\s+(tickets?|seats?)\b/)?.[1] ?? ""] ?? 0);
  if (!count || count > 8) return null;

  const movies = [...new Set(shows.map((s) => s.movie))].filter((m) => text.includes(movieKey(m)));
  if (movies.length !== 1) return null;
  let options = shows.filter((s) => s.movie === movies[0]);

  const saysToday = /\b(tonight|today)\b/.test(text);
  const saysTomorrow = /\btomorrow\b/.test(text);
  if (saysToday && saysTomorrow) return null;
  if (saysToday || saysTomorrow) options = options.filter((s) => localDate(s.startsAt) === (saysToday ? today : tomorrow));
  else if (new Set(options.map((s) => localDate(s.startsAt))).size !== 1) return null; // no day said and shows on several days

  const theatres = [...new Set(shows.map((s) => theatreKey(s.theatre)))].filter((t) => text.includes(t));
  if (theatres.length > 1) return null;
  if (theatres.length) options = options.filter((s) => theatreKey(s.theatre) === theatres[0]);
  if (!options.length) return null;

  const prefer: Prefer = /\b(back|rear|last row)\b/.test(text) ? "back" : /\bfront\b/.test(text) ? "front" : "middle";
  const soonest = [...options].sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  return { showId: soonest.id, count, prefer };
}
