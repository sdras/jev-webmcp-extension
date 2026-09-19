// What may happen to a predicted call. Confidence tells you whether to act;
// the tool's own annotations tell you how careful to be. Follows Chrome's
// agent guidance: assume a tool changes state unless it says readOnlyHint,
// and keep a human in the loop for everything else.

export const DEFAULTS = { route: 0.5, auto: 0.8, confirm: 0.6 };

/**
 * @returns {"none" | "incomplete" | "auto" | "ready" | "confirm"}
 *   none        no tool fits: hand off to a System Two model or the user
 *   incomplete  a required argument has no value yet: the user fills it in
 *   auto        read-only and confident: safe to run while the user types
 *   ready       Enter runs it
 *   confirm     Enter asks first (shaky, flagged, or consequential)
 */
export function decide(call, { live = true, flagged = false, thresholds = DEFAULTS } = {}) {
  if (!call?.name || call.routeProbability < thresholds.route) return "none";
  if (call.missing.length) return "incomplete";
  const hints = call.tool.annotations ?? {};
  if (flagged || hints.consequentialHint || hints.destructiveHint) return "confirm";
  if (hints.readOnlyHint && live && call.confidence >= thresholds.auto) return "auto";
  return call.confidence >= thresholds.confirm ? "ready" : "confirm";
}
