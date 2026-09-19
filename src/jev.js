// Minimal client for TypeSafe's System One endpoint. The official SDK
// (@typesafe-ai/sdk) does the same with retries; a side panel that fires on
// every keystroke would rather drop a request than retry it.
const API = "https://api.typesafe.ai/v1";

/** Dollars per input token. Output tokens are free. */
export const PRICE_PER_TOKEN = 0.042 / 1e6;

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

const REASONS = {
  401: "TypeSafe did not accept that API key.",
  422: "TypeSafe rejected the questions.",
  429: "Rate limited by TypeSafe. Slow down for a moment.",
  529: "TypeSafe is overloaded. Try again shortly.",
};

async function explain(response) {
  let detail = "";
  try {
    const body = await response.json();
    detail = typeof body.detail === "string" ? body.detail : (body.error?.message ?? body.message ?? "");
  } catch {}
  return [REASONS[response.status] ?? `TypeSafe returned ${response.status}.`, detail].filter(Boolean).join(" ");
}

export async function systemOne({ apiKey, state, questions, model = "jev-latest", signal }) {
  const started = performance.now();
  const response = await fetch(`${API}/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model, questions }),
    signal,
  });
  if (!response.ok) throw new JevError(await explain(response), response.status);
  const body = await response.json();
  return { answers: body.answers, usage: body.usage, model: body.model, ms: performance.now() - started };
}

export async function checkKey(apiKey) {
  const response = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new JevError(await explain(response), response.status);
  return true;
}
