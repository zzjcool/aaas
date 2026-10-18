#!/usr/bin/env node
// Dev launcher: server (tsx watch) + web (vite) in one terminal, interleaved output.
import { spawn } from "node:child_process";

const children = [];

function run(name, cmd, args, { env = {}, cwd } = {}) {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    // `cwd: undefined` simply inherits the parent's, which is what we want
    // for the server (it resolves web/dist relative to the repo root).
    cwd,
    shell: false,
  });
  const prefix = `\x1b[36m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write(prefix + `exited with code ${code}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

let closing = false;
function shutdown(code) {
  if (closing) return;
  closing = true;
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 200).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Paths were `packages/server/src/index.ts` / `packages/web/vite.config.ts`,
// left over from a monorepo template: neither ever existed in this repo, so
// `npm run dev` died instantly with ERR_MODULE_NOT_FOUND on the very first
// command a newcomer runs. Use the real entrypoints and run vite from web/.
run("server", "npx", ["tsx", "watch", "src/server/main.ts"], { env: { TRIGGER_DEV: "1", TRIGGER_PORT: "7788" } });
// vite must run from web/: its config, index.html and deps live there.
run("web", "npx", ["vite"], { cwd: "web" });
