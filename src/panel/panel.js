import { decode } from "../core/decode.js";
import { decide } from "../core/policy.js";
import { buildQuestions, buildState } from "../core/questions.js";
import { buildScreening, decodeScreening } from "../core/screen.js";
import { PRICE_PER_TOKEN } from "../jev.js";
import { platform } from "../platform/index.js";

const DEBOUNCE_MS = 90;
const MIN_CHARS = 4;
const POLL_MS = 1500;
const RESULT_CAP = 1200;

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(
  ["site", "settings", "settings-toggle", "api-key", "save-key", "key-status", "live", "notice", "app", "tools", "tools-summary", "tool-list", "command", "say", "latency", "cost", "playground", "prediction", "log", "mock-banner"].map((id) => [id, $(id)]),
);

const model = {
  page: null,
  tools: [],
  toolsKey: "",
  flagged: {}, // tool name -> probability its manifest is steering the agent
  settings: {},
  request: null, // { state, questions, plan, answers } behind the current prediction
  call: null,
  pick: null, // a candidate tool the user chose over Jev's route; holds until the sentence is cleared
  overrides: {}, // values the user typed for arguments Jev could not fill
  armed: false,
  lastAuto: "",
  running: false,
  log: [],
};

// Everything the page tells us (tool names, descriptions, results) is
// untrusted, so it only ever reaches the DOM as text nodes.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "style") Object.assign(el.style, value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const percent = (p) => `${Math.round(p * 100)}%`;
const level = (p) => (p >= 0.8 ? "high" : p >= 0.6 ? "mid" : "low");
const bar = (p) => h("span", { class: `bar-track ${level(p)}`, role: "img", "aria-label": percent(p) }, h("span", { class: "bar-fill", style: { width: percent(p) } }));

// ---------------------------------------------------------------- page + tools

function notice(title, body, action) {
  ui.app.hidden = true;
  ui.notice.hidden = false;
  model.toolsKey = "";
  // The poll lands here every tick; leave the DOM (and focus) alone when nothing changed.
  if (ui.notice.dataset.key === title + body) return;
  ui.notice.dataset.key = title + body;
  ui.notice.replaceChildren(h("h2", {}, title), h("p", {}, body), action ?? "");
}

async function refreshPage() {
  const page = await platform.getPage();
  model.page = page;
  ui.site.textContent = page.host || "";
  if (page.restricted) return notice("Open a website", "WebMCP tools live on web pages. Switch to a tab with a site in it.");

  if (!(await platform.hasAccess(page.origin))) {
    const grant = async () => (await platform.requestAccess(page.origin)) && refreshPage();
    return notice(`Use the tools on ${page.host}?`, "This lets the panel read the WebMCP tools this site registers and run the ones you approve. Access is per site, and you can remove it any time from the extension's settings.", h("button", { type: "button", class: "primary", onclick: grant }, `Enable on ${page.host}`));
  }

  let listing;
  try {
    listing = await platform.listTools(page.tabId);
  } catch (error) {
    return notice("Can't reach this page", String(error?.message ?? error));
  }
  if (!listing?.tools?.length) {
    const why = listing?.api ? "This page has the WebMCP API but has not registered any tools yet." : "This page does not expose WebMCP tools. The site needs to call document.modelContext.registerTool(), and Chrome needs WebMCP enabled (origin trial, or chrome://flags/#enable-webmcp-testing).";
    return notice("No tools here", listing?.error ?? why);
  }

  ui.notice.hidden = true;
  ui.app.hidden = false;
  const key = JSON.stringify(listing.tools);
  if (key === model.toolsKey) return;
  model.toolsKey = key;
  model.tools = listing.tools;
  renderTools();
  screenTools();
  dispatch();
}

function renderTools(questions) {
  questions ??= buildQuestions(model.tools, ui.say.value.trim()).questions;
  const total = Object.keys(questions).length;
  ui["tools-summary"].replaceChildren(h("strong", {}, `${model.tools.length} tools`), " → ", h("strong", {}, `${total} questions`), h("span", { class: "muted" }, " from their schemas"));
  const open = new Set([...ui["tool-list"].querySelectorAll("details[open]")].map((d) => d.dataset.tool));
  ui["tool-list"].replaceChildren(
    ...model.tools.map((tool) => {
      const count = Object.keys(questions).filter((id) => id.startsWith(`${tool.name}::`)).length;
      const risk = model.flagged[tool.name];
      return h(
        "li",
        {},
        h(
          "details",
          { "data-tool": tool.name, open: open.has(tool.name) },
          h(
            "summary",
            {},
            h("code", {}, tool.name),
            tool.annotations?.readOnlyHint && h("span", { class: "badge read" }, "read-only"),
            tool.annotations?.consequentialHint && h("span", { class: "badge careful" }, "consequential"),
            risk >= 0.5 && h("span", { class: "badge flagged", title: "Jev thinks this description is talking to the agent, not describing the tool." }, `flagged ${percent(risk)}`),
            h("span", { class: "muted count" }, count ? `${count} q` : "no args"),
          ),
          h("p", { class: "description" }, tool.description),
        ),
      );
    }),
  );
}

// One request, one Noul per manifest: is this description steering the agent?
async function screenTools() {
  if (!model.settings.apiKey || platform.isMock) return;
  const tools = model.tools;
  try {
    const { answers } = await platform.jev(buildScreening(tools));
    if (tools !== model.tools) return;
    model.flagged = decodeScreening(tools, answers).scores;
    renderTools();
    if (model.call) renderPrediction();
  } catch (error) {
    console.warn("Screening failed", error);
  }
}

// ---------------------------------------------------------------- dispatch

let timer = null;
let inflight = null;

function dispatch() {
  clearTimeout(timer);
  timer = setTimeout(predict, DEBOUNCE_MS);
}

async function predict() {
  inflight?.abort();
  const said = ui.say.value.trim();
  model.armed = false;
  if (said.length < MIN_CHARS || !model.tools.length) {
    model.call = model.request = model.pick = null;
    model.overrides = {};
    ui.latency.hidden = ui.playground.hidden = true;
    ui.cost.textContent = "";
    return renderPrediction();
  }
  if (!model.settings.apiKey) return openSettings("Add your TypeSafe API key to start.");

  const controller = (inflight = new AbortController());
  const { questions, plan } = buildQuestions(model.tools, said);
  const state = buildState(said, model.page);
  ui.prediction.classList.add("pending");
  try {
    const { answers, usage, ms } = await platform.jev({ state, questions, signal: controller.signal });
    if (controller.signal.aborted) return;
    model.request = { state, questions, plan, answers };
    ui.latency.hidden = ui.playground.hidden = false;
    ui.latency.textContent = `${Math.round(ms)} ms`;
    ui.cost.textContent = `${usage.input_tokens.toLocaleString()} tokens · $${(usage.input_tokens * PRICE_PER_TOKEN).toFixed(5)}`;
    renderTools(questions);
    settle();
  } catch (error) {
    if (error.name === "AbortError") return;
    if (error.status === 401) openSettings(error.message);
    ui.prediction.replaceChildren(h("p", { class: "status low" }, error.message));
  } finally {
    if (inflight === controller) ui.prediction.classList.remove("pending");
  }
}

// Answers -> the call on screen. Jev answered for every tool at once, so
// switching to another candidate is a re-decode, not another request.
function settle({ live = true } = {}) {
  const { plan, answers } = model.request;
  model.call = decode(plan, answers, { pick: model.pick });
  if (!model.call.picked) model.pick = null; // the picked tool left the page
  model.overrides = {};
  renderPrediction();
  if (live && decision() === "auto") run({ auto: true });
}

function choose(name, options) {
  model.pick = name;
  model.armed = false;
  settle(options);
}

// A click on a candidate is "this one, go": choose it, then what Enter would do.
// So a consequential tool still takes a second click, and a blank still gets filled in.
function runCandidate(name) {
  if (model.pick !== name) choose(name, { live: false });
  ui.say.focus();
  submit();
}

// ArrowDown from the end of the sentence walks the candidates; ArrowUp walks
// back, and at the top the route is Jev's again.
function stepPick(step) {
  if (!model.call) return false;
  const names = model.call.routes.map((route) => route.value).filter(Boolean);
  const at = names.indexOf(model.call.name) + step;
  if (at >= names.length || (at < 0 && !model.pick)) return false;
  const name = names[at] ?? null;
  choose(name === model.call.routes[0]?.value ? null : name);
  return true;
}

// Arguments Jev could not fill are typed in by the user; then the call is whole.
function finalCall() {
  const call = model.call;
  if (!call?.name) return call;
  const args = structuredClone(call.args);
  const stillMissing = [];
  for (const detail of call.details.filter((d) => d.missing)) {
    const typed = model.overrides[detail.label]?.trim();
    if (!typed) {
      stillMissing.push(detail.label);
      continue;
    }
    let node = args;
    detail.path.forEach((key, i) => {
      if (i === detail.path.length - 1) node[key] = detail.kind === "number" ? Number(typed) : typed;
      else node = node[key] ??= typeof detail.path[i + 1] === "number" ? [] : {};
    });
  }
  return { ...call, args, missing: stillMissing };
}

const decision = () => decide(finalCall(), { live: model.settings.live, flagged: model.flagged[model.call?.name] >= 0.5 });

// ---------------------------------------------------------------- prediction view

function renderValue(value) {
  if (Array.isArray(value)) return h("span", {}, "[", ...value.flatMap((v, i) => [i ? ", " : "", renderValue(v)]), "]");
  if (typeof value === "string") return h("span", { class: "tok-string" }, JSON.stringify(value));
  return h("span", { class: "tok-number" }, String(value));
}

function renderArgument(detail) {
  const name = h("span", { class: "tok-key" }, detail.label);
  if (detail.missing) {
    const input = h("input", {
      class: "fill",
      placeholder: "Jev can't write this one. You can.",
      "aria-label": detail.label,
      value: model.overrides[detail.label] ?? "",
      oninput: (event) => {
        model.overrides[detail.label] = event.target.value;
        renderStatus();
      },
      onkeydown: (event) => event.key === "Enter" && (event.preventDefault(), submit()),
    });
    return h("div", { class: "arg missing" }, name, ": ", input);
  }
  // The road not taken: the next-best option, or for a set, a member that nearly made it.
  const taken = new Set([detail.value].flat().map(String));
  const runnerUp = detail.distribution?.find((d) => !taken.has(d.value) && d.probability >= 0.1);
  const aside = runnerUp && `${detail.kind === "set" ? "maybe also" : "or"} ${runnerUp.value} ${percent(runnerUp.probability)}`;
  return h("div", { class: "arg" }, h("span", { class: "arg-code" }, name, ": ", renderValue(detail.value)), bar(detail.probability), h("span", { class: "pct" }, percent(detail.probability)), aside && h("span", { class: "runner-up" }, aside));
}

function renderPrediction() {
  const call = model.call;
  if (!call) return ui.prediction.replaceChildren(h("p", { class: "empty" }, "Start typing. Jev reads this page's tools and answers before you finish the sentence."));

  // Each candidate tool is a button that runs it: the user can overrule the route.
  // A double-click's second half (detail 2) is not a confirmation.
  const routes = h(
    "ol",
    { class: "routes" },
    call.routes.map((route) => {
      const current = route.value === call.name;
      const pinned = current && call.picked;
      const cells = [h("span", { class: "route-name" }, h("code", {}, route.value ?? "no tool fits"), pinned && h("span", { class: "badge" }, "your pick")), bar(route.probability), h("span", { class: "pct" }, percent(route.probability))];
      const row = route.value ? h("button", { type: "button", class: "route", title: `Run ${route.value}`, onclick: (event) => event.detail < 2 && runCandidate(route.value) }, cells) : h("span", { class: "route" }, cells);
      return h("li", { class: `${current ? "picked" : ""} ${pinned ? "pinned" : ""}`, "aria-current": current && "true" }, row);
    }),
  );
  if (!call.name) return ui.prediction.replaceChildren(routes, h("p", { class: "status none", id: "status" }, "Nothing on this page does that. That's a job for a slower, smarter model, or for you."));

  const shown = call.details.filter((d) => !d.omitted);
  const defaults = call.details.filter((d) => d.omitted).map((d) => d.label);
  const code = h("div", { class: "call" }, h("div", {}, h("span", { class: "tok-fn" }, call.name), shown.length ? "({" : "()"), ...shown.map(renderArgument), shown.length ? h("div", {}, "})") : "");
  ui.prediction.replaceChildren(routes, code, defaults.length ? h("p", { class: "defaults muted" }, `Not mentioned, left to the tool's defaults: ${defaults.join(", ")}`) : "", h("p", { id: "status" }));
  renderStatus();
}

function renderStatus() {
  const status = $("status");
  if (!status || !model.call?.name) return;
  const call = finalCall();
  const verdict = decision();
  const sure = percent(call.confidence);
  const lead = call.picked ? "Your pick" : `${sure} sure`;
  const hints = call.tool.annotations ?? {};
  const text = {
    auto: `${lead} and read-only, so it runs as you type.`,
    ready: `${lead}. Press Enter to run.`,
    confirm: model.armed ? `Press Enter or click ${call.name} again to run it.` : hints.consequentialHint || hints.destructiveHint ? "This tool is marked consequential. Press Enter, then confirm." : model.flagged[call.name] >= 0.5 ? "This tool's description looks like it is steering the agent. Press Enter, then confirm." : `Only ${sure} sure${call.picked ? " of the arguments" : ""}. Press Enter, then confirm.`,
    incomplete: `Fill in ${call.missing.join(", ")}, then press Enter.`,
    none: "No tool is a confident match yet. Keep typing, or click the one you mean.",
  }[verdict];
  status.className = `status ${verdict}${model.armed ? " armed" : ""}`;
  status.replaceChildren(h("span", { class: "dot" }), text);
}

// ---------------------------------------------------------------- run

function readable(result) {
  try {
    const parsed = JSON.parse(result);
    const text = parsed?.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? null;
    if (text == null) return JSON.stringify(parsed, null, 2);
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  } catch {
    return String(result);
  }
}

async function run({ auto = false } = {}) {
  const call = finalCall();
  const signature = `${call.name}${JSON.stringify(call.args)}`;
  if (model.running || (auto && signature === model.lastAuto)) return;
  model.running = true;
  if (auto) model.lastAuto = signature;
  const started = performance.now();
  let outcome;
  try {
    outcome = await platform.callTool(model.page.tabId, call.name, call.args);
  } catch (error) {
    outcome = { ok: false, error: String(error?.message ?? error) };
  }
  model.running = false;
  const entry = { name: call.name, args: call.args, auto, ok: outcome?.ok, text: outcome?.ok ? readable(outcome.result) : (outcome?.error ?? "The tool did not answer."), ms: performance.now() - started };
  // Live runs overwrite each other so typing does not flood the log.
  if (auto && model.log[0]?.auto) model.log[0] = entry;
  else model.log.unshift(entry);
  model.log.length = Math.min(model.log.length, 6);
  renderLog();
  if (!auto) {
    ui.say.value = "";
    model.lastAuto = "";
    predict();
  }
  refreshPage(); // running a tool can change which tools exist
}

function renderLog() {
  ui.log.replaceChildren(
    ...model.log.map((entry) => {
      const long = entry.text.length > RESULT_CAP;
      const pre = h("pre", {}, long ? `${entry.text.slice(0, RESULT_CAP)}…` : entry.text);
      return h(
        "article",
        { class: `result ${entry.ok ? "ok" : "failed"}` },
        h("header", {}, h("code", {}, entry.name), h("span", { class: "muted" }, `${entry.auto ? "ran live" : "ran"} · ${Math.round(entry.ms)} ms`)),
        pre,
        long && h("button", { type: "button", class: "link", onclick: (event) => ((pre.textContent = entry.text), event.target.remove()) }, "Show all"),
      );
    }),
  );
}

function submit() {
  if (!model.call?.name || model.running) return;
  const verdict = decision();
  if (verdict === "ready" || verdict === "auto") return run();
  if (verdict === "confirm") {
    if (model.armed) return run();
    model.armed = true;
    return renderStatus();
  }
  if (verdict === "incomplete") ui.prediction.querySelector(".fill")?.focus();
}

// ---------------------------------------------------------------- settings + wiring

function openSettings(message) {
  ui.settings.hidden = false;
  ui["settings-toggle"].setAttribute("aria-expanded", "true");
  if (message) ui["key-status"].textContent = message;
  ui["api-key"].focus();
}

async function saveKey() {
  const apiKey = ui["api-key"].value.trim();
  if (!apiKey) return;
  ui["key-status"].textContent = "Checking…";
  try {
    await platform.checkKey(apiKey);
    await platform.setSettings({ apiKey });
    model.settings.apiKey = apiKey;
    ui["api-key"].value = "";
    ui["api-key"].placeholder = "Key saved. Paste a new one to replace it.";
    ui["key-status"].textContent = "Key works. Stored in this browser only.";
    screenTools();
    dispatch();
  } catch (error) {
    ui["key-status"].textContent = error.message;
  }
}

function openPlayground() {
  if (!model.request || !globalThis.LZString) return;
  const share = { documentText: JSON.stringify(model.request.state, null, 2), promptsText: JSON.stringify(model.request.questions, null, 2), apiVersion: "v1", selectedModels: [model.settings.model] };
  window.open(`https://console.typesafe.ai/playground#share/${LZString.compressToEncodedURIComponent(JSON.stringify(share))}`, "_blank", "noopener");
}

ui.say.addEventListener("input", dispatch);
ui.say.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) (event.preventDefault(), submit());
  if (event.key === "Escape") ((ui.say.value = ""), predict());
  // At the end of the sentence ArrowDown has nowhere to go, so it moves through the candidates.
  if (event.key === "ArrowDown" && ui.say.selectionStart === ui.say.value.length && stepPick(1)) event.preventDefault();
  if (event.key === "ArrowUp" && stepPick(-1)) event.preventDefault();
});
ui.command.addEventListener("submit", (event) => (event.preventDefault(), submit()));
ui["settings-toggle"].addEventListener("click", () => {
  ui.settings.hidden = !ui.settings.hidden;
  ui["settings-toggle"].setAttribute("aria-expanded", String(!ui.settings.hidden));
});
ui["save-key"].addEventListener("click", saveKey);
ui["api-key"].addEventListener("keydown", (event) => event.key === "Enter" && saveKey());
ui.live.addEventListener("change", () => {
  model.settings.live = ui.live.checked;
  platform.setSettings({ live: ui.live.checked });
  renderStatus();
});
ui.playground.addEventListener("click", openPlayground);

model.settings = await platform.getSettings();
ui.live.checked = model.settings.live;
ui["mock-banner"].hidden = !platform.isMock;
if (model.settings.apiKey) ui["api-key"].placeholder = "Key saved. Paste a new one to replace it.";
else openSettings();

renderPrediction();
platform.onPageChange(refreshPage);
await refreshPage();
setInterval(() => document.visibilityState === "visible" && !model.running && refreshPage(), POLL_MS);
ui.say.focus();
