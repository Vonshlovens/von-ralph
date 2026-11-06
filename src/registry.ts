import type { HarnessId } from "./domain.ts";
import { type Harness, claude, codex, copilot, opencode } from "./harness.ts";

export const harnesses: Record<HarnessId, Harness> = {
  claude,
  codex,
  opencode,
  gh: copilot,
};
