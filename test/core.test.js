import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, formatCall } from "../src/core/decode.js";
import { decide } from "../src/core/policy.js";
import { buildQuestions, NONE, NOT_STATED, paramsOf, ROUTE } from "../src/core/questions.js";
import { buildScreening, decodeScreening } from "../src/core/screen.js";
import { numbers, spans } from "../src/core/spans.js";
import { answersFor, basketful } from "./helpers.js";

const tool = (name) => basketful.find((t) => t.name === name);
const kinds = (name) => Object.fromEntries(paramsOf(tool(name).inputSchema).map((p) => [p.label, p.kind]));

test("spans: the user's own words, never starting or ending on a function word", () => {
  const found = spans("find me some oat milk under $5?");
  assert.ok(found.includes("oat milk"));
  assert.ok(found.includes("$5"));
  assert.ok(!found.includes("me"));
  assert.ok(!found.includes("some oat milk"));
  assert.ok(!found.some((s) => s.endsWith("?")));
});

test("numbers: digits, words, compounds and phrases, parsed in code", () => {
  assert.deepEqual(numbers("two cartons and 3.5 lbs, under twenty five bucks"), [
    { value: 2, text: "two" },
    { value: 3.5, text: "3.5" },
    { value: 25, text: "twenty five" },
  ]);
  assert.deepEqual(numbers("half a dozen eggs").map((n) => n.value), [6]);
  assert.deepEqual(numbers("a couple of limes and a dozen eggs").map((n) => n.value), [2, 12]);
  assert.deepEqual(numbers("no numbers here"), []);
});

test("paramsOf: each schema shape maps to the primitive that can fill it", () => {
  assert.deepEqual(kinds("search_products"), { query: "span", department: "choice", dietary: "set", max_price: "number" });
  assert.deepEqual(kinds("add_to_cart"), { "items[0].product": "span", "items[0].quantity": "choice" });
  assert.deepEqual(kinds("get_cart"), {});
  assert.equal(kinds("add_recipe_to_cart").preview, "flag");
  assert.equal(kinds("add_staples_to_cart")["skip[0]"], "span");
});

test("paramsOf: required-ness follows the schema down through lists", () => {
  const byLabel = (name) => Object.fromEntries(paramsOf(tool(name).inputSchema).map((p) => [p.label, p]));
  const cart = byLabel("add_to_cart");
  assert.equal(cart["items[0].product"].required, true);
  assert.equal(cart["items[0].quantity"].required, false);
  const recipe = byLabel("add_recipe_to_cart");
  assert.equal(recipe["ingredients[0].name"].required, false);
  assert.equal(recipe["ingredients[0].name"].localRequired, true);
  assert.equal(recipe["ingredients[0].name"].container, "ingredients[0]");
});

test("paramsOf: oneOf consts carry their descriptions into the criteria", () => {
  const [param] = paramsOf({ type: "object", properties: { size: { oneOf: [{ const: "s", description: "small" }, { const: "l", title: "large" }] } } });
  assert.deepEqual(param.options, [{ value: "s", description: "small" }, { value: "l", description: "large" }]);
});

test("buildQuestions: one routing Choice, optional params get a stated? Noul", () => {
  const { questions } = buildQuestions(basketful, "got anything gluten free in the bakery aisle?");
  assert.deepEqual(Object.keys(questions[ROUTE].criteria), [...basketful.map((t) => t.name), NONE]);
  assert.equal(questions["search_products::department"].type, "choice");
  assert.equal(questions["search_products::department?"].type, "noul");
  assert.equal(questions["search_products::dietary::gluten-free"].type, "noul");
  assert.equal(questions["choose_store::store?"], undefined, "required params are always filled");
  assert.equal(questions["search_products::max_price"], undefined, "no numbers said, nothing to choose from");
  assert.ok(NOT_STATED in questions["search_products::query"].criteria);
});

test("buildQuestions: numbers the user said become the candidates", () => {
  const { questions } = buildQuestions(basketful, "oat milk under five bucks");
  assert.deepEqual(Object.keys(questions["search_products::max_price"].criteria), ["5", NOT_STATED]);
});

test("decode: the playground run becomes a runnable call", () => {
  const { questions, plan } = buildQuestions(basketful, "got anything gluten free in the bakery aisle?");
  const call = decode(plan, answersFor(questions, {
    tool: "search_products",
    answers: {
      "search_products::department": ["Bakery", 0.98],
      "search_products::department?": 0.99,
      "search_products::dietary::gluten-free": 0.97,
    },
  }));
  assert.equal(call.name, "search_products");
  assert.deepEqual(call.args, { department: "Bakery", dietary: ["gluten-free"] });
  assert.deepEqual(call.missing, []);
  assert.equal(formatCall(call), 'search_products({ department: "Bakery", dietary: [ "gluten-free" ] })');
  assert.ok(Math.abs(call.confidence - 0.97) < 1e-9, "confidence is the weakest judgement");
});

test("decode: values come back as the schema declared them, defaults stand when unstated", () => {
  const { questions, plan } = buildQuestions(basketful, "throw in two cartons of oat milk");
  const stated = decode(plan, answersFor(questions, {
    tool: "add_to_cart",
    answers: { "add_to_cart::items[0].product": ["oat milk", 0.9], "add_to_cart::items[0].quantity": ["2", 0.95], "add_to_cart::items[0].quantity?": 0.9 },
  }));
  assert.deepEqual(stated.args, { items: [{ product: "oat milk", quantity: 2 }] });

  const unstated = decode(plan, answersFor(questions, { tool: "add_to_cart", answers: { "add_to_cart::items[0].product": ["oat milk", 0.9] } }));
  assert.deepEqual(unstated.args, { items: [{ product: "oat milk" }] });
});

test("decode: a required argument nobody stated is missing, not guessed", () => {
  const { questions, plan } = buildQuestions(basketful, "change the amount please");
  const call = decode(plan, answersFor(questions, { tool: "update_cart_item", answers: { "update_cart_item::product": [NOT_STATED, 0.8] } }));
  assert.ok(call.missing.includes("product"));
  assert.equal(decide(call), "incomplete");
});

test("decode: an optional list item goes in whole or not at all", () => {
  const { questions, plan } = buildQuestions(basketful, "add three of them for the recipe");
  const call = decode(plan, answersFor(questions, {
    tool: "add_recipe_to_cart",
    answers: { "add_recipe_to_cart::ingredients[0].quantity": ["3", 0.9], "add_recipe_to_cart::ingredients[0].quantity?": 0.9 },
  }));
  assert.equal(call.args.ingredients, undefined);
});

test("decode: no tool fits", () => {
  const { questions, plan } = buildQuestions(basketful, "what's the weather like?");
  const call = decode(plan, answersFor(questions, { tool: null, p: 0.93 }));
  assert.equal(call.name, null);
  assert.equal(decide(call), "none");
});

test("policy: read-only runs live, everything else waits for a human", () => {
  const make = (name, confidence, extra = {}) => ({ name, tool: tool(name), missing: [], confidence, routeProbability: 0.99, ...extra });
  assert.equal(decide(make("search_products", 0.9)), "auto");
  assert.equal(decide(make("search_products", 0.9), { live: false }), "ready");
  assert.equal(decide(make("search_products", 0.7)), "ready");
  assert.equal(decide(make("add_to_cart", 0.99)), "ready", "state-changing tools never auto-run");
  assert.equal(decide(make("add_to_cart", 0.4)), "confirm");
  assert.equal(decide(make("place_order", 0.99)), "confirm", "consequentialHint always confirms");
  assert.equal(decide(make("search_products", 0.99), { flagged: true }), "confirm", "a flagged manifest never auto-runs");
  assert.equal(decide(make("search_products", 0.99, { routeProbability: 0.3 })), "none");
});

test("screening: one Noul per tool manifest", () => {
  const { state, questions } = buildScreening(basketful);
  assert.equal(Object.keys(questions).length, basketful.length);
  assert.equal(state.tools[1].name, "search_products");
  const answers = Object.fromEntries(Object.keys(questions).map((id, i) => [id, { type: "noul", noul: i === 2 ? 0.91 : 0.03 }]));
  assert.deepEqual(decodeScreening(basketful, answers).flagged, [basketful[2].name]);
});
