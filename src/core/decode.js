// Answers -> a tool call your code can run, with a probability behind every part.
import { NONE, NOT_STATED, ROUTE } from "./questions.js";

const YES = 0.5;
const certainty = (noul) => Math.max(noul, 1 - noul);

function setPath(target, path, value) {
  let node = target;
  path.forEach((key, i) => {
    if (i === path.length - 1) return void (node[key] = value);
    node[key] ??= typeof path[i + 1] === "number" ? [] : {};
    node = node[key];
  });
}

function topOf(probabilities = {}, n = 3) {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, probability]) => ({ value, probability }));
}

function decodeParam(param, answers) {
  const detail = { label: param.label, path: param.path, kind: param.kind, required: param.required, container: param.container, localRequired: param.localRequired };
  const stated = param.statedQid ? (answers[param.statedQid]?.noul ?? 0) : 1;
  const answer = param.qid ? answers[param.qid] : null;

  if (param.kind === "flag") {
    const noul = answer?.noul ?? 0;
    const on = noul >= YES;
    return { ...detail, probability: certainty(noul), ...(on || param.required ? { value: on } : { omitted: true }) };
  }

  if (param.kind === "set") {
    const members = param.members.map((m) => ({ value: m.value, noul: answers[m.qid]?.noul ?? 0 }));
    const value = members.filter((m) => m.noul >= YES).map((m) => m.value);
    const probability = Math.min(...members.map((m) => certainty(m.noul)));
    const distribution = members.map((m) => ({ value: String(m.value), probability: m.noul })).sort((a, b) => b.probability - a.probability);
    if (!value.length) return { ...detail, probability, distribution, ...(param.required ? { missing: true } : { omitted: true }) };
    return { ...detail, value, probability, distribution };
  }

  if (!answer) return { ...detail, probability: 1, ...(param.required ? { missing: true } : { omitted: true }) };

  const distribution = topOf(answer.probabilities);
  if (stated < YES) return { ...detail, omitted: true, probability: 1 - stated, distribution };
  if (answer.choice === NOT_STATED) {
    const probability = answer.probabilities?.[NOT_STATED] ?? 0;
    return { ...detail, probability, distribution, ...(param.required ? { missing: true } : { omitted: true }) };
  }

  // Criteria keys are strings; hand the tool the value its schema declared.
  const declared = param.options?.find((o) => String(o.value) === answer.choice);
  const value = declared ? declared.value : param.kind === "number" ? Number(answer.choice) : answer.choice;
  const picked = answer.probabilities?.[answer.choice] ?? 0;
  return { ...detail, value, probability: Math.min(stated, picked), distribution };
}

/**
 * @returns {{ tool, name, args, details, missing, confidence, routes } | { name: null, routes, confidence }}
 * `confidence` is the least certain judgement behind the call: one wrong
 * argument spoils the result, so a product would punish long signatures.
 */
export function decode(plan, answers) {
  const route = answers[ROUTE];
  const routes = topOf(route?.probabilities).map((r) => ({ ...r, value: r.value === NONE ? null : r.value }));
  const routeProbability = route?.probabilities?.[route.choice] ?? 0;
  if (!route || route.choice === NONE || !plan.tools[route.choice])
    return { name: null, tool: null, args: {}, details: [], missing: [], routes, confidence: routeProbability };

  const { tool, params } = plan.tools[route.choice];
  let details = params.map((param) => decodeParam(param, answers));

  // An optional object or list item goes in whole or not at all.
  const broken = new Set(details.filter((d) => d.container && d.localRequired && (d.omitted || d.missing)).map((d) => d.container));
  details = details.map((d) => (d.container && broken.has(d.container) && !d.omitted ? { ...d, omitted: true, missing: false, value: undefined } : d));

  const args = {};
  for (const d of details) if (!d.omitted && !d.missing) setPath(args, d.path, d.value);
  const missing = details.filter((d) => d.missing).map((d) => d.label);
  const confidence = Math.min(routeProbability, ...details.map((d) => d.probability));
  return { name: tool.name, tool, args, details, missing, routes, routeProbability, confidence };
}

/** `search_products({ department: "Bakery", dietary: ["gluten-free"] })` */
export function formatCall(call) {
  if (!call?.name) return "";
  const inner = JSON.stringify(call.args, null, 1)
    .replace(/\n\s*/g, " ")
    .replace(/"([A-Za-z_$][\w$]*)":/g, "$1:");
  return `${call.name}(${inner === "{}" ? "" : inner})`;
}
