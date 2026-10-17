/**
 * Temporary stand-in for the pi adapter so the HTTP/SSE surface can be tested
 * end-to-end while `src/agents/pi` is still being written.
 *
 * This file is NOT part of the product: `src/server/main.ts` imports the real
 * adapter. It exists so `src/server/app.test.ts` can exercise the API without a
 * model provider.
 */
import type { AgentAdapter } from "../shared/types.ts";

export function createEchoAdapter(): AgentAdapter {
  return {
    type: "echo",
    descriptor: {
      type: "echo",
      displayName: "Echo (test only)",
      description: "Test adapter: echoes the prompt back.",
      fields: [],
    },
    validate: () => ({ ok: true, config: { type: "pi", cwd: "/tmp" } as never }),
    async run(input, ctx) {
      ctx.log("system", `echo adapter started for ${input.jobId}`);
      for (const word of input.prompt.split(" ")) {
        if (input.signal.aborted) break;
        ctx.log("stdout", word);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return {
        ok: true,
        text: `echo: ${input.prompt}`,
        exitCode: 0,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      };
    },
  };
}
