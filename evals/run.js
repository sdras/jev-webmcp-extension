// Real-API check of the whole pipeline against Basketful's tool manifest:
//   TYPESAFE_API_KEY=... npm run eval
// Each case is a sentence, the tool it should reach, and the arguments that
// must be present (extra arguments are reported, not failed).
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { decode, formatCall } from "../src/core/decode.js";
import { decide } from "../src/core/policy.js";
import { buildQuestions, buildState } from "../src/core/questions.js";
import { systemOne } from "../src/jev.js";

const CASES = [
  ["got anything gluten free in the bakery aisle?", "search_products", { department: "Bakery", dietary: ["gluten-free"] }],
  ["vegan snacks", "search_products", { department: "Snacks", dietary: ["vegan"] }],
  ["find oat milk under five bucks", "search_products", { query: "oat milk", max_price: 5 }],
  ["let's shop at the cheap one", "choose_store", { store: "Penny Pantry" }],
  ["switch to the co-op", "choose_store", { store: "Harbor Foods Co-op" }],
  ["throw in two cartons of oat milk", "add_to_cart", { items: [{ product: "oat milk", quantity: 2 }] }],
  ["add an avocado", "add_to_cart", { items: [{ product: "avocado" }] }],
  ["make it three bananas instead", "update_cart_item", { product: "bananas", quantity: 3 }],
  ["the usual please", "add_staples_to_cart", {}],
  ["I want to make tacos tonight", "add_recipe_to_cart", { recipe: "Weeknight Beef Tacos" }],
  ["what would I need to buy for the salmon dinner?", "add_recipe_to_cart", { recipe: "Sheet-Pan Salmon & Broccoli", preview: true }],
  ["what's in my cart?", "get_cart", {}],
  ["where's my order?", "get_order_status", {}],
  ["I'm ready to check out", "start_checkout", {}],
  ["deliver it tomorrow morning", "set_delivery_options", { delivery_window: "Tomorrow 9am–11am" }],
  ["ok buy it", "place_order", {}],
  ["tell me a joke", null, {}],
];

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error("Set TYPESAFE_API_KEY (console.typesafe.ai/keys) to run the evals.");
  process.exit(1);
}

const tools = JSON.parse(readFileSync(new URL("../test/fixtures/basketful-tools.json", import.meta.url), "utf8"));
const only = process.argv[2];
const timings = [];
let passed = 0;
let ran = 0;

for (const [said, expectedTool, expectedArgs] of CASES) {
  if (only && !said.includes(only)) continue;
  ran++;
  const { questions, plan } = buildQuestions(tools, said);
  const { answers, ms, usage } = await systemOne({ apiKey, state: buildState(said), questions });
  const call = decode(plan, answers);
  timings.push(ms);

  const rightTool = call.name === expectedTool;
  const wrongArgs = Object.entries(expectedArgs).filter(([key, value]) => !isDeepStrictEqual(call.args[key], value)).map(([key]) => key);
  const extra = Object.keys(call.args).filter((key) => !(key in expectedArgs));
  const ok = rightTool && !wrongArgs.length;
  if (ok) passed++;

  console.log(`${ok ? "PASS" : "FAIL"}  "${said}"`);
  console.log(`      ${call.name ? formatCall(call) : "(no tool)"}   ${Math.round(call.confidence * 100)}% -> ${decide(call)}   ${Math.round(ms)} ms, ${usage.input_tokens} tok`);
  if (!rightTool) console.log(`      expected tool ${expectedTool}; routes: ${call.routes.map((r) => `${r.value ?? "none"} ${Math.round(r.probability * 100)}%`).join(", ")}`);
  for (const key of wrongArgs) console.log(`      ${key}: expected ${JSON.stringify(expectedArgs[key])}, got ${JSON.stringify(call.args[key])}`);
  if (extra.length) console.log(`      extra: ${extra.join(", ")}`);
}

timings.sort((a, b) => a - b);
console.log(`\n${passed}/${ran} passed · median ${Math.round(timings[timings.length >> 1])} ms · slowest ${Math.round(timings.at(-1))} ms`);
process.exit(passed === ran ? 0 : 1);
