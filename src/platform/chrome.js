// Everything that touches chrome.* lives here, so the panel and the core
// stay plain JavaScript that also runs in the harness and in Node.
import { checkKey, systemOne } from "../jev.js";

// ---- Functions injected into the page's MAIN world. They must be
// self-contained: chrome.scripting serializes them, closures do not survive.

async function pageListTools() {
  const plain = (t) => {
    let schema = t.inputSchema;
    if (typeof schema === "string") {
      try {
        schema = JSON.parse(schema || "{}");
      } catch {
        schema = {};
      }
    }
    const a = t.annotations ?? {};
    return {
      name: String(t.name),
      title: t.title ? String(t.title) : null,
      description: String(t.description ?? ""),
      inputSchema: JSON.parse(JSON.stringify(schema ?? {})),
      annotations: {
        readOnlyHint: !!a.readOnlyHint,
        untrustedContentHint: !!a.untrustedContentHint,
        consequentialHint: !!a.consequentialHint,
        destructiveHint: !!a.destructiveHint,
      },
    };
  };
  try {
    const context = document.modelContext ?? navigator.modelContext;
    if (context?.getTools) return { api: "document.modelContext", tools: (await context.getTools()).map(plain) };
    const testing = navigator.modelContextTesting;
    if (testing?.listTools) return { api: "navigator.modelContextTesting", tools: (await testing.listTools()).map(plain) };
    return { api: null, tools: [] };
  } catch (error) {
    return { api: null, tools: [], error: `${error?.name ?? "Error"}: ${error?.message ?? error}` };
  }
}

async function pageCallTool(name, argsJson) {
  const asText = (result) => (typeof result === "string" ? result : JSON.stringify(result ?? null));
  try {
    const context = document.modelContext ?? navigator.modelContext;
    if (context?.getTools && context.executeTool) {
      // executeTool wants the RegisteredTool object itself, and the arguments as a JSON string.
      const tool = (await context.getTools()).find((t) => t.name === name);
      if (!tool) return { ok: false, error: `The page no longer offers "${name}".` };
      return { ok: true, result: asText(await context.executeTool(tool, argsJson)) };
    }
    const testing = navigator.modelContextTesting;
    if (testing?.executeTool) return { ok: true, result: asText(await testing.executeTool(name, argsJson)) };
    return { ok: false, error: "This page has no WebMCP API." };
  } catch (error) {
    return { ok: false, error: `${error?.name ?? "Error"}: ${error?.message ?? error}` };
  }
}

// ---- Panel-side API

async function inject(tabId, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
  return injection?.result;
}

export const isMock = false;

export async function getPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) return { tabId: tab?.id ?? null, restricted: true, host: "", title: tab?.title ?? "" };
  const url = new URL(tab.url);
  return { tabId: tab.id, restricted: false, origin: url.origin, host: url.host, title: tab.title ?? "", favicon: tab.favIconUrl ?? null };
}

// Host access is granted one site at a time, by the user, from the panel.
export const hasAccess = (origin) => chrome.permissions.contains({ origins: [`${origin}/*`] });
export const requestAccess = (origin) => chrome.permissions.request({ origins: [`${origin}/*`] });

export const listTools = (tabId) => inject(tabId, pageListTools);
export const callTool = (tabId, name, args) => inject(tabId, pageCallTool, [name, JSON.stringify(args)]);

export function onPageChange(callback) {
  chrome.tabs.onActivated.addListener(callback);
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (tab.active && (change.status === "complete" || change.url)) callback();
  });
  chrome.windows?.onFocusChanged.addListener(callback);
}

const SETTINGS = { apiKey: "", live: true, model: "jev-latest" };
export const getSettings = async () => ({ ...SETTINGS, ...(await chrome.storage.local.get(Object.keys(SETTINGS))) });
export const setSettings = (patch) => chrome.storage.local.set(patch);

export async function jev({ state, questions, signal }) {
  const { apiKey, model } = await getSettings();
  return systemOne({ apiKey, model, state, questions, signal });
}

// pageListTools / pageCallTool are exported so they can be exercised directly in a page during development.
export { checkKey, pageCallTool, pageListTools };
