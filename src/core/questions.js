// A WebMCP tool's JSON Schema already is the spec a System One model needs:
//
//   which tool?            -> one Choice over tool name -> description
//   enum / const / oneOf   -> Choice over the allowed values
//   boolean                -> Noul
//   array of enum          -> one Noul per member
//   small integer range    -> Choice over the range
//   free text              -> Choice over spans of the user's own words
//   other numbers          -> Choice over numbers the user stated
//   optional anything      -> an extra "is it stated?" Noul, so defaults stand
//
// Every question rides in one request; Jev answers them in parallel.
import { numbers, spans } from "./spans.js";

export const ROUTE = "__tool__";
export const NONE = "__none__";
export const NOT_STATED = "(not stated)";

const RANGE_LIMIT = 24;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function pathLabel(path) {
  return path.reduce((label, key) => (typeof key === "number" ? `${label}[${key}]` : label ? `${label}.${key}` : key), "");
}

function typeOf(schema) {
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  return type ?? (schema.properties ? "object" : undefined);
}

/** [{ value, description }] when the schema only admits a fixed list of values. */
function closedSet(schema) {
  if (Array.isArray(schema.enum)) return schema.enum.filter((v) => v !== null).map((value) => ({ value, description: null }));
  if (schema.const !== undefined) return [{ value: schema.const, description: schema.description ?? null }];
  const variants = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(variants) && variants.length && variants.every((v) => v && v.const !== undefined))
    return variants.map((v) => ({ value: v.const, description: v.description ?? v.title ?? null }));
  return null;
}

/** Flatten a tool's input schema into the parameters Jev can fill. */
export function paramsOf(inputSchema) {
  const params = [];
  const walk = (schema, path, required, localRequired, container) => {
    if (!schema || typeof schema !== "object") return;
    const param = { path, label: pathLabel(path), required, localRequired, container, schema };
    const options = closedSet(schema);
    if (options) return params.push({ ...param, kind: "choice", options });

    switch (typeOf(schema)) {
      case "object": {
        const needs = new Set(schema.required ?? []);
        // An optional object is all-or-nothing: drop it when its own required parts are missing.
        const inside = required || !path.length ? container : pathLabel(path);
        for (const [key, child] of Object.entries(schema.properties ?? {}))
          walk(child, [...path, key], required && needs.has(key), needs.has(key), inside);
        return;
      }
      case "boolean":
        return params.push({ ...param, kind: "flag" });
      case "array": {
        const items = schema.items ?? {};
        const members = closedSet(items);
        if (members) return params.push({ ...param, kind: "set", options: members });
        // One sentence, one item: fill the first element only.
        const first = { ...items, description: items.description ?? schema.description };
        if (typeOf(first) === "object") {
          const needs = new Set(first.required ?? []);
          const inside = required ? container : pathLabel([...path, 0]);
          for (const [key, child] of Object.entries(first.properties ?? {}))
            walk(child, [...path, 0, key], required && needs.has(key), needs.has(key), inside);
          return;
        }
        return walk(first, [...path, 0], required, localRequired, container);
      }
      case "integer":
      case "number": {
        const { minimum: min, maximum: max } = schema;
        if (typeOf(schema) === "integer" && Number.isFinite(min) && Number.isFinite(max) && max - min <= RANGE_LIMIT) {
          const range = Array.from({ length: max - min + 1 }, (_, i) => ({ value: min + i, description: null }));
          return params.push({ ...param, kind: "choice", options: range });
        }
        return params.push({ ...param, kind: "number" });
      }
      case "string":
        return params.push({ ...param, kind: "span" });
      default:
        return params.push({ ...param, kind: "unfillable" });
    }
  };
  walk(inputSchema ?? {}, [], true, true, null);
  return params;
}

function about(param) {
  const key = [...param.path].reverse().find((k) => typeof k === "string") ?? "value";
  const description = param.schema.description ? ` (${clip(param.schema.description, 300)})` : "";
  return `"${key}"${description}`;
}

const criteriaOf = (options) => Object.fromEntries(options.map((o) => [String(o.value), o.description]));

/**
 * Questions for one utterance against a page's tools, plus the plan that
 * decode() uses to turn the answers back into a tool call.
 */
export function buildQuestions(tools, utterance, { only } = {}) {
  const active = only ? tools.filter((t) => only.includes(t.name)) : tools;
  const said = { spans: spans(utterance), numbers: numbers(utterance) };
  const questions = {
    [ROUTE]: {
      type: "choice",
      instructions: "Which action does the user's request call for?",
      criteria: {
        ...Object.fromEntries(active.map((t) => [t.name, clip(t.description || t.title || t.name, 600)])),
        [NONE]: "None of these: the request is conversation, unclear, unfinished, or needs something these actions do not do.",
      },
    },
  };
  const plan = { tools: {} };

  for (const tool of active) {
    const action = `the "${tool.name}" action`;
    const params = paramsOf(tool.inputSchema).map((param) => {
      const qid = `${tool.name}::${param.label}`;
      const filled = { ...param, qid };
      const askStated = () => {
        if (param.required) return;
        filled.statedQid = `${qid}?`;
        questions[filled.statedQid] = { type: "noul", instructions: `For ${action}: does the user's request state or clearly imply ${about(param)}?` };
      };

      if (param.kind === "choice") {
        questions[qid] = { type: "choice", instructions: `For ${action}: which option does the user's request indicate for ${about(param)}?`, criteria: criteriaOf(param.options) };
        askStated();
      } else if (param.kind === "flag") {
        questions[qid] = { type: "noul", instructions: `For ${action}: does the user's request call for ${about(param)}?` };
      } else if (param.kind === "set") {
        filled.members = param.options.map((o) => {
          const memberQid = `${qid}::${o.value}`;
          questions[memberQid] = { type: "noul", instructions: `For ${action}: does the user's request ask for "${o.value}"? It is one option of ${about(param)}.` };
          return { value: o.value, qid: memberQid };
        });
      } else if (param.kind === "span" && said.spans.length) {
        questions[qid] = {
          type: "choice",
          instructions: `For ${action}: which exact words of the user's request give ${about(param)}?`,
          criteria: { ...Object.fromEntries(said.spans.map((s) => [s, null])), [NOT_STATED]: "The request does not say this." },
        };
        askStated();
      } else if (param.kind === "number" && said.numbers.length) {
        questions[qid] = {
          type: "choice",
          instructions: `For ${action}: which number in the user's request is ${about(param)}?`,
          criteria: { ...Object.fromEntries(said.numbers.map((n) => [String(n.value), `The user wrote "${n.text}".`])), [NOT_STATED]: "None of these numbers is this." },
        };
        askStated();
      } else {
        filled.qid = null; // nothing to ask: the default stands, or the user fills it in
      }
      return filled;
    });
    plan.tools[tool.name] = { tool, params };
  }
  return { questions, plan };
}

export function buildState(utterance, page = {}) {
  return { user_request: utterance, ...(page.host ? { page: { site: page.host, title: page.title } } : {}) };
}
