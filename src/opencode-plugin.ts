// Loaded only in the Ralph-created OpenCode process. No global/project edits.
import { appendFileSync } from "node:fs";
/**
 * @cc [owner:ghuntley,label:product] opencode-root-events
 * Forward events only for the session whose initial user message contains this
 * iteration's marker. Child sessions and startup idle MUST NOT finish that task.
 */
export const RalphEvents = async () => {
  let root: string | undefined;
  const emit = (event: unknown) =>
    appendFileSync(process.env.RALPH_EVENT_FILE!, JSON.stringify(event) + "\n", { mode: 0o600 });
  return {
    "chat.message": async (
      input: { sessionID: string },
      output: { parts: Array<{ type: string; text?: string }>; message: { variant?: string } },
    ) => {
      if (
        !root &&
        output.parts.some(
          (p) => p.type === "text" && p.text?.includes(process.env.RALPH_ITERATION_MARKER!),
        )
      ) {
        root = input.sessionID;
        if (process.env.RALPH_EFFORT) output.message.variant = process.env.RALPH_EFFORT;
        emit({ type: "ralph.session", properties: { sessionID: root } });
      }
    },
    event: async ({
      event,
    }: {
      event: {
        type: string;
        properties?: {
          sessionID?: string;
          part?: { sessionID?: string };
          info?: { sessionID?: string };
        };
      };
    }) => {
      const p = event.properties ?? {};
      const session = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID;
      if (root && session === root) emit(event);
    },
  };
};
