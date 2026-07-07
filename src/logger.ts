import pino from "pino";
import { randomUUID } from "node:crypto";

const isVercel = Boolean(process.env.VERCEL);

const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Pretty-print locally for readability; emit plain JSON on Vercel so log
  // drains / the dashboard can parse structured fields.
  transport: isVercel
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
      },
});

/**
 * Creates a logger scoped to a single job run, tagging every line with a
 * shared runId so a full run's log lines can be grepped/correlated in the
 * Vercel log viewer.
 */
export function createRunLogger(runId: string = randomUUID()) {
  return baseLogger.child({ runId });
}

export type RunLogger = ReturnType<typeof createRunLogger>;

export { baseLogger as logger };
