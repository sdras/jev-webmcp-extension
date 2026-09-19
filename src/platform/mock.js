// Harness platform: the panel as an ordinary web page, with Basketful's tool
// manifest from the test fixtures and a stand-in for Jev (a few scripted
// intents, keyword matching for everything else).
// It exists for UI work and offline rehearsal. It is NOT Jev, and the panel
// says so whenever it is active.
import { NONE, NOT_STATED, ROUTE } from "../core/questions.js";
import { tokenize } from "../core/spans.js";

export const isMock = true;

const words = (text) => tokenize(String(text).toLowerCase().replaceAll("-", " ")).map((t) => t.text.replace(/s$/, ""));
const FILLER = new Set("find show get got add put throw need want have anything something please like lets let open make cook under over than less more buck dollar each".split(" "));

function overlap(saidWords, text) {
  const target = new Set(words(text));
  return saidWords.filter((w) => w.length > 2 && !FILLER.has(w) && target.has(w)).length;
}

function softmax(scores, sharpness = 4) {
  const exps = scores.map((s) => Math.exp(s * sharpness));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}

function mockChoice(question, saidWords) {
  const keys = Object.keys(question.criteria);
  const isSpanQuestion = NOT_STATED in question.criteria;
  const scores = keys.map((key) => {
    if (key === NONE || key === NOT_STATED) return 0.6;
    if (!isSpanQuestion) return overlap(saidWords, `${key} ${question.criteria[key] ?? ""}`);
    const content = words(key).filter((w) => !FILLER.has(w) && Number.isNaN(Number(w)));
    return content.length === words(key).length ? Math.min(content.length, 3) * 0.9 : 0;
  });
  const probabilities = softmax(scores);
  const best = probabilities.indexOf(Math.max(...probabilities));
  return { type: "choice", choice: keys[best], probabilities: Object.fromEntries(keys.map((k, i) => [k, probabilities[i]])), confidence: probabilities[best] };
}

function mockNoul(question, saidWords) {
  const quoted = [...question.instructions.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const subject = quoted.length > 1 ? quoted[1] : (quoted[0] ?? "");
  const needed = words(subject);
  const hits = needed.filter((w) => saidWords.includes(w)).length;
  return { type: "noul", noul: needed.length && hits === needed.length ? 0.94 : hits ? 0.4 : 0.03 };
}

const spread = (criteria, pick, p) => {
  const others = Object.keys(criteria).filter((k) => k !== pick);
  return Object.fromEntries([[pick, p], ...others.map((k) => [k, (1 - p) / others.length])]);
};

/**
 * The answers Jev would give if it meant `intent`. Questions the intent does
 * not mention get a calm "no" (Noul 0.02) or a shrug (uniform Choice).
 *   { tool: "choose_store", p: 0.98, answers: { "choose_store::store": ["Penny Pantry", 0.97] } }
 * Returns null when the intent names an option the questions do not offer yet.
 */
export function answersFor(questions, intent) {
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const given = id === ROUTE ? [intent.tool ?? NONE, intent.p ?? 0.99] : intent.answers?.[id];
    if (q.type === "noul") out[id] = { type: "noul", noul: given ?? 0.02 };
    else {
      const keys = Object.keys(q.criteria);
      const [pick, p] = given ?? [keys[0], 1 / keys.length];
      if (!(pick in q.criteria)) return null;
      out[id] = { type: "choice", choice: pick, probabilities: spread(q.criteria, pick, p), confidence: p };
    }
  }
  return out;
}

// A few scripted intents so every panel state can be rehearsed offline.
const SCRIPT = [
  [/gluten/i, { tool: "search_products", answers: { "search_products::department": ["Bakery", 0.98], "search_products::department?": 0.99, "search_products::dietary::gluten-free": 0.99 } }],
  [/penny/i, { tool: "choose_store", p: 0.98, answers: { "choose_store::store": ["Penny Pantry", 0.97] } }],
  [/co-?op/i, { tool: "choose_store", p: 0.95, answers: { "choose_store::store": ["Harbor Foods Co-op", 0.58] } }],
  [/oat milk/i, { tool: "add_to_cart", p: 0.97, answers: { "add_to_cart::items[0].product": ["oat milk", 0.93], "add_to_cart::items[0].quantity": ["2", 0.96], "add_to_cart::items[0].quantity?": 0.95 } }],
  [/change|update/i, { tool: "update_cart_item", p: 0.9, answers: { "update_cart_item::product": [NOT_STATED, 0.8], "update_cart_item::quantity": ["3", 0.7] } }],
  [/place.*order|buy it/i, { tool: "place_order", p: 0.97 }],
  [/weather|joke/i, { tool: null, p: 0.96 }],
];

export async function jev({ state, questions, signal }) {
  const started = performance.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 90 + Math.random() * 120);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new DOMException("Aborted", "AbortError"))));
  });
  const said = state.user_request ?? "";
  const saidWords = words(said);
  const scripted = ROUTE in questions && SCRIPT.find(([pattern]) => pattern.test(said));
  const answers =
    (scripted && answersFor(questions, scripted[1])) ||
    Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === "noul" ? mockNoul(q, saidWords) : mockChoice(q, saidWords)]));
  const input_tokens = Math.round(JSON.stringify({ state, questions }).length / 4);
  return { answers, usage: { input_tokens, output_tokens: 0 }, model: "mock (not Jev)", ms: performance.now() - started };
}

let tools = null;
export async function listTools() {
  tools ??= await (await fetch(new URL("../../test/fixtures/basketful-tools.json", import.meta.url))).json();
  return { api: "fixture: Basketful", tools };
}

export async function callTool(_tabId, name, args) {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { ok: true, result: JSON.stringify({ content: [{ type: "text", text: `(harness) ${name} ran with ${JSON.stringify(args)}` }] }) };
}

export const getPage = async () => ({ tabId: 1, restricted: false, origin: "https://basketful.example", host: "basketful.example", title: "Basketful" });
export const hasAccess = async () => true;
export const requestAccess = async () => true;
export const onPageChange = () => {};
export const checkKey = async () => true;

const SETTINGS = { apiKey: "mock", live: true, model: "jev-latest" };
export const getSettings = async () => ({ ...SETTINGS, ...JSON.parse(localStorage.getItem("jev-webmcp") ?? "{}") });
export const setSettings = async (patch) => localStorage.setItem("jev-webmcp", JSON.stringify({ ...(await getSettings()), ...patch }));
