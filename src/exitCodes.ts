import type { StopReason } from "./domain.ts";

/** Process exit code for a finished run: 0 when it ended as intended. */
export const exitCodeFor = (reason: StopReason): number => {
  switch (reason) {
    case "interrupted":
      return 130;
    case "max_iterations":
    case "operator_stop":
    case "complete":
    case "plan_complete":
    case "plan_converged":
      return 0;
    // Ended on its own, but a human should look: distinguishable for schedulers.
    case "plan_exhausted":
    case "no_progress":
      return 3;
    default:
      return 1;
  }
};
