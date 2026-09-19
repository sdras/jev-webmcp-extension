import { readFileSync } from "node:fs";
import { answersFor as fabricate } from "../src/platform/mock.js";

export const basketful = JSON.parse(readFileSync(new URL("./fixtures/basketful-tools.json", import.meta.url), "utf8"));

/** Answers Jev would give if it meant `intent`; see src/platform/mock.js. */
export function answersFor(questions, intent) {
  const answers = fabricate(questions, intent);
  if (!answers) throw new Error(`The intent names an option these questions do not offer: ${JSON.stringify(intent)}`);
  return answers;
}
