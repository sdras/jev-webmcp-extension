// The real extension talks to chrome.*; opened as a plain page (npm run harness) it runs on fixtures.
const inExtension = typeof chrome !== "undefined" && !!chrome.scripting;
export const platform = await (inExtension ? import("./chrome.js") : import("./mock.js"));
