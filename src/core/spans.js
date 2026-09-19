// Jev picks; it never writes. So free-text and numeric arguments are turned
// into a Choice over candidates lifted from the user's own words, and code
// does the parsing. See docs.typesafe.ai "Pre-parsed value extraction".

const TOKEN = /[\p{L}\p{N}$][\p{L}\p{N}'’\-./%]*/gu;
const TRAILING = /[.\-/'’]+$/u;

// Function words that never start or end a useful span.
const EDGE_STOPWORDS = new Set(
  "a an the of to for and or with in at on from by me my i you we us it is are do does can could would please some any".split(" "),
);

export function tokenize(text) {
  const tokens = [];
  for (const m of text.matchAll(TOKEN)) {
    const word = m[0].replace(TRAILING, "");
    if (word) tokens.push({ text: word, start: m.index, end: m.index + word.length });
  }
  return tokens;
}

/** Contiguous word runs from `text`, shortest first, as the user typed them. */
export function spans(text, { maxWords = 5, limit = 120 } = {}) {
  const tokens = tokenize(text);
  const seen = new Set();
  const out = [];
  for (let n = 1; n <= maxWords; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const first = tokens[i];
      const last = tokens[i + n - 1];
      if (EDGE_STOPWORDS.has(first.text.toLowerCase()) || EDGE_STOPWORDS.has(last.text.toLowerCase())) continue;
      const span = text.slice(first.start, last.end);
      const key = span.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(span);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const PHRASES = [
  [/\bhalf(?: a)? dozen\b/giu, 6],
  [/\b(?:a )?couple(?: of)?\b/giu, 2],
  [/\b(?:a )?dozen\b/giu, 12],
];

/** Numbers the user stated, as digits or words: [{ value, text }]. Arithmetic stays in code. */
export function numbers(text) {
  const found = [];
  const claimed = [];
  const free = (start, end) => claimed.every(([s, e]) => end <= s || start >= e);
  const add = (value, start, end) => {
    if (!free(start, end)) return;
    claimed.push([start, end]);
    found.push({ value, text: text.slice(start, end), start });
  };

  for (const [pattern, value] of PHRASES)
    for (const m of text.matchAll(pattern)) add(value, m.index, m.index + m[0].length);

  for (const m of text.matchAll(/\d+(?:\.\d+)?/gu)) add(Number(m[0]), m.index, m.index + m[0].length);

  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i].text.toLowerCase();
    const [tensWord, unitWord] = word.split("-");
    if (tensWord in TENS) {
      const next = tokens[i + 1]?.text.toLowerCase();
      if (unitWord in UNITS && UNITS[unitWord] < 10) add(TENS[tensWord] + UNITS[unitWord], tokens[i].start, tokens[i].end);
      else if (!unitWord && next in UNITS && UNITS[next] > 0 && UNITS[next] < 10) add(TENS[word] + UNITS[next], tokens[i].start, tokens[++i].end);
      else if (!unitWord) add(TENS[word], tokens[i].start, tokens[i].end);
    } else if (word in UNITS) add(UNITS[word], tokens[i].start, tokens[i].end);
  }

  const seen = new Set();
  return found
    .sort((a, b) => a.start - b.start)
    .filter(({ value }) => !seen.has(value) && seen.add(value))
    .map(({ value, text }) => ({ value, text }));
}
