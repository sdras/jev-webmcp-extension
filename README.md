# Jev × WebMCP Chrome Extension

A Chrome side panel that drives **any page's WebMCP tools** with **Jev**, TypeSafe's System One model.

Type, and on every keystroke, Jev picks the page's tool and fills its arguments, and the predicted call renders live with a probability.

```
"got anything gluten free in the bakery aisle?"

search_products({ department: "Bakery", dietary: ["gluten-free"] })     98%   164 ms
```

No per-site setup.

## Why these two fit

WebMCP gives a page a typed surface: named tools, described parameters, enums, annotations. Jev is a model that does not generate text. You send it state plus typed questions (Choice, Score, Noul) and get typed answers with calibrated probabilities back in a couple hundred milliseconds, all questions answered in parallel.

So the panel reads the page's tools and turns each schema into questions:

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

## A demo script

Using [Basketful](https://github.com/sdras/shopping-cart-webmcp) (`npm run dev`):

1. **The schema is the spec.** Open the panel. "11 tools → 40-odd questions from their schemas." Expand a tool to show its description and how many questions it became. Nothing was written for this site.
2. **Speed you can see.** Type slowly: `got anything gluten free in the bakery aisle?` The route bars settle on `search_products` mid-sentence, the arguments fill in, and because the tool is `readOnlyHint` the page filters itself while you are still typing. Point at the latency pill.
3. **Calibrated doubt.** Type something vague (`the cheap one`). Watch a runner-up appear under an argument and the status drop from green to amber.
4. **You can overrule it.** The candidate tools are buttons. Click one and it runs, with the arguments already filled in: every tool's arguments were answered in the same request, so there is nothing to ask again. From the keyboard, ↓ at the end of the sentence walks the candidates and Enter runs the one you land on; your pick holds while you keep typing, and ↑ back to the top makes the route Jev's again.
5. **It knows what it can't do.** `make it three of those instead`: the quantity fills, the product is a blank with a dashed border. Jev can't write, so you do.
6. **Annotations are policy.** `add two oat milks` waits for Enter because it changes state. At checkout, `ok buy it` reaches `place_order`, which is marked consequential: Enter, then Enter again, whatever the confidence.
7. **Nothing fits.** `tell me a joke` → "no tool fits". That is the hand-off point to a System Two model.
8. **Show your work.** "Open in playground" loads the exact state and questions into the TypeSafe playground.

## Safety model

Follows Chrome's [agent security guidance for WebMCP](https://developer.chrome.com/docs/agents/security).

- **Per-site access.** `optional_host_permissions`, requested from the panel when you enable a site. Nothing runs anywhere you have not enabled.
- **Human in the loop.** A tool is assumed to change state unless it says `readOnlyHint`. Only confident, read-only calls run on their own (and that can be switched off). Consequential or destructive hints always take a second Enter. Clicking a candidate settles which tool, and nothing else: shaky arguments, flagged manifests and consequential hints still ask for a second click, and the second half of a double-click does not count as one.
- **Manifests are untrusted.** When tools load, one Jev request asks a Noul per tool: is this description describing the tool, or giving orders to an agent? Flagged tools get a badge and never auto-run.
- **Tool output never reaches the model.** Results are shown to you and that is all, so a poisoned result has nothing to inject into. The model cannot generate text either: the worst a hostile page can do is win a multiple-choice question, and then you still have to press Enter.
- **No HTML from the page.** Tool names, descriptions and results only ever reach the panel as text nodes.

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

The page bridge (`pageListTools` / `pageCallTool` in `src/platform/chrome.js`) runs in the page's main world through `chrome.scripting`. Two things it handles that are easy to miss: Chrome returns `inputSchema` as a JSON **string**, and `executeTool` wants the `RegisteredTool` object plus arguments as a JSON string.

## Known edges

- A sentence fills one item. `items: [...]` and other lists get their first element only.
- Tuning lives in the question wording in `src/core/questions.js`. Jev reads literally so when an eval fails, usually a cleaner sentence will help.

Licensed under [Apache 2.0](LICENSE). The vendored `vendor/lz-string.min.js` is third-party and stays under its own MIT license (`vendor/lz-string.LICENSE`).