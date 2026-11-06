import { claudeBg } from "./claudeBg.ts";
import type { HarnessId } from "./domain.ts";
import { type Harness, codex, copilot, opencode } from "./harness.ts";

export const harnesses: Record<HarnessId, Harness> = {
  claude: claudeBg,
  codex,
  opencode,
  gh: copilot,
};
