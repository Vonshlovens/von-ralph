import { claudeBg } from "./claudeBg.ts";
import type { HarnessId } from "./domain.ts";
import { type Harness, claudePrint, codex, copilot, opencode } from "./harness.ts";

export const harnesses: Record<HarnessId, Harness> = {
  claude: claudeBg,
  "claude-print": claudePrint,
  codex,
  opencode,
  gh: copilot,
};
