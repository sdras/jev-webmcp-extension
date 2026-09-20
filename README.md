# Jev × WebMCP Chrome Extension

A Chrome extension that uses **Jev**, TypeSafe's System One model, to select and populate **WebMCP tool calls** from user input. The side panel discovers tools exposed by the current page and displays predicted calls, confidence scores, and latency as the user types. Tool selection is derived from the page's schemas, without site-specific configuration.

```
"got anything gluten free in the bakery aisle?"

search_products({ department: "Bakery", dietary: ["gluten-free"] })     98%   164 ms
```

## How schema conversion works

WebMCP exposes named tools with descriptions, parameter schemas, enums, and annotations. Jev accepts state and typed questions (Choice, Score, Noul) and returns typed answers with probabilities. It answers the questions in parallel and does not generate text.

The panel converts tool schemas into questions as follows:

| In the tool's schema | Becomes |
| --- | --- |
| the list of tools | one Choice over `name -> description`, plus "none of these" |
| `enum`, `const`, `oneOf` of consts | Choice over the allowed values |
| `boolean` | Noul |
| array of enum | one Noul per member |
| integer with a small `minimum`..`maximum` | Choice over the range |
| free-text `string` | Choice over spans of the user's own words |
| other numbers | Choice over the numbers the user stated (parsed in code) |
| anything optional | an extra "is it stated?" Noul, so the tool's default stands when it isn't |

## Set it up

1. Chrome 149 or newer with WebMCP available (a site in the origin trial, or `chrome://flags/#enable-webmcp-testing`).
2. `chrome://extensions` → turn on Developer mode → **Load unpacked** → choose this folder.
3. Click the extension's toolbar button to open the side panel.
4. Open settings (the sliders icon), paste a key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys), Save. The key is checked against the API and kept in `chrome.storage.local`.
5. Go to a site with WebMCP tools and press **Enable on (site)**. Host access is granted one site at a time.

There is no build step. Edit a file, press the reload arrow on `chrome://extensions`, reopen the panel.

## Demo walkthrough

Using [Basketful](https://github.com/sdras/shopping-cart-webmcp) (`npm run dev`):

1. **Tool discovery.** Open the panel to view the discovered tools and the questions generated from their schemas. Expand a tool to inspect its description and question count.
2. **Predictions while typing.** Enter `got anything gluten free in the bakery aisle?` to see the predicted tool, arguments, and latency update. Confident calls to `search_products` can run automatically because the tool has a `readOnlyHint` annotation.
3. **Ambiguous input.** Enter `the cheap one` to inspect alternative argument predictions and changes in confidence.
4. **Manual tool selection.** Click a candidate tool to select it for execution. Arguments for all candidate tools are predicted in the same request. From the keyboard, press ↓ at the end of the input to move through candidates and Enter to run the selected tool, subject to confirmation requirements. The selection persists while typing; press ↑ back to the top to return to automatic tool selection.
5. **Missing arguments.** Enter `make it three of those instead`. The quantity can be resolved, but the product field remains blank for manual entry when the model cannot identify it.
6. **Execution and confirmation.** Enter `add two oat milks`. Calls that change state require Enter. At checkout, `ok buy it` selects `place_order`, whose consequential annotation requires a second Enter regardless of confidence.
7. **Unmatched requests.** Enter `tell me a joke` to see the “no tool fits” result. Such requests could be handled by a separate System Two model.
8. **Inspecting requests in the playground.** Select “Open in playground” to load the request's state and questions into the TypeSafe playground.

## Safety model

Follows Chrome's [agent security guidance for WebMCP](https://developer.chrome.com/docs/agents/security).

- **Per-site access.** The panel requests `optional_host_permissions` when you enable a site. The extension accesses only enabled sites.
- **Execution controls.** Tools are treated as state-changing unless they declare `readOnlyHint`. Only confident, read-only calls can run automatically, and automatic execution can be disabled. Consequential or destructive annotations always require a second Enter. Clicking a candidate selects the tool; low-confidence arguments, flagged manifests, and consequential annotations still require confirmation with a second click. The second click of a double-click does not count as confirmation.
- **Manifest screening.** When tools load, Jev evaluates each tool description for instructions directed at an agent. Flagged tools receive a badge and cannot run automatically.
- **Model input boundary.** Tool results are displayed in the panel and are not included in model requests. Page-provided tool descriptions and schemas remain untrusted inputs and may influence tool selection or arguments. Manifest screening and execution confirmation provide additional checks.
- **Text rendering.** Tool names, descriptions, and results are rendered as text nodes, rather than HTML.

## Working on it

```
npm test          # core: schema -> questions, answers -> call, policy (no network)
npm run harness   # the panel as a plain web page on fixtures, with a labeled mock model
npm run eval      # real API, Basketful's manifest: accuracy + latency (needs TYPESAFE_API_KEY)
```

```
src/core/        pure JavaScript, no chrome.*, no DOM
  questions.js   tools + utterance -> Jev questions and a decode plan
  spans.js       candidate spans and numbers from the user's words
  decode.js      answers -> { name, args, confidence, per-argument detail }
  policy.js      auto / ready / confirm / incomplete / none
  screen.js      manifest screening
src/jev.js       fetch client for api.typesafe.ai/v1/systemone
src/platform/    chrome.js (real: scripting, permissions, storage) and mock.js (harness)
src/panel/       the side panel
evals/run.js     sentences -> expected calls, against the real model
```

The page bridge (`pageListTools` / `pageCallTool` in `src/platform/chrome.js`) runs in the page's main world through `chrome.scripting`. The bridge handles two API requirements: Chrome returns `inputSchema` as a JSON **string**, and `executeTool` wants the `RegisteredTool` object plus arguments as a JSON string.

## Limitations

- Array arguments, including `items: [...]`, currently populate only the first element.
- Prediction quality depends on the question wording in `src/core/questions.js`. Evaluation failures may require changes to these questions.

Licensed under [Apache 2.0](LICENSE). The vendored `vendor/lz-string.min.js` is third-party and stays under its own MIT license (`vendor/lz-string.LICENSE`).
