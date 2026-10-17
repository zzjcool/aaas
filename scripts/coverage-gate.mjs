#!/usr/bin/env node
/**
 * Coverage gate: run the unit suite with V8 coverage and fail if quality moved
 * backwards. Used by CI and by `make gate`.
 *
 * Two rules, both deliberate:
 *
 *  1. No regression vs. the recorded baseline (coverage/coverage-baseline.json).
 *     Cheap to satisfy, and it stops the slow bleed — the way coverage actually
 *     dies is one PR at a time.
 *  2. Absolute floors. A project can sit at 40% forever under rule 1 alone.
 *     Floors are what make "95% and falling" impossible to ignore.
 *
 * The baseline is only ever *raised* here; `node scripts/coverage-gate.mjs
 * --update-baseline` re-records it, so ratcheting up is a deliberate commit.
 *
 * Excluded from measurement: tests, E2E fixtures and build scripts. The CLI
 * (src/cli.ts) is deliberately NOT excluded from the run, but it is covered
 * through the HTTP API in E2E rather than imported, so it drags the numbers
 * down until someone adds CLI tests — that is the honest signal.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "coverage");
const lcovPath = join(outDir, "lcov.info");
const baselinePath = join(outDir, "coverage-baseline.json");

/** Absolute floors: below these the build is red regardless of the baseline. */
const FLOORS = {
  lines: num(process.env.AAAS_COVER_FLOOR_LINES, 90),
  branches: num(process.env.AAAS_COVER_FLOOR_BRANCHES, 70),
  functions: num(process.env.AAAS_COVER_FLOOR_FUNCTIONS, 80),
};

/** Allowed drop vs. baseline, in percentage points, before the gate fails. */
const TOLERANCE = num(process.env.AAAS_COVER_TOLERANCE, 0.5);

const update = process.argv.includes("--update-baseline");

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runTests() {
  mkdirSync(outDir, { recursive: true });
  const args = [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "--experimental-test-coverage",
    "--test-coverage-exclude=**/*.test.ts",
    "--test-coverage-exclude=tests/**",
    "--test-coverage-exclude=scripts/**",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcovPath}`,
    "src/**/*.test.ts",
  ];
  const res = spawnSync(process.execPath, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  return res.status ?? 1;
}

/**
 * Parse lcov into per-file and total coverage.
 *
 * Totals are aggregated from raw hit/found counts, never from the mean of
 * per-file percentages — otherwise a 10-line file counts as much as a 600-line
 * one and the number stops meaning anything.
 */
function parseLcov(text) {
  const files = [];
  const totals = { lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
  let cur = null;

  const flush = () => {
    if (cur === null) return;
    files.push({
      file: cur.file,
      lines: pct(cur.lh, cur.lf),
      branches: pct(cur.brh, cur.brf),
      functions: pct(cur.fnh, cur.fnf),
    });
    totals.lf += cur.lf;
    totals.lh += cur.lh;
    totals.brf += cur.brf;
    totals.brh += cur.brh;
    totals.fnf += cur.fnf;
    totals.fnh += cur.fnh;
    cur = null;
  };

  // Prefix lengths differ (LF: is 3 chars, BRF:/FNF: are 4) — slice by the
  // prefix length, never a hardcoded offset. Getting this wrong silently
  // reports 100% and turns the whole gate into a rubber stamp.
  const value = (line, prefix) => Number(line.slice(prefix.length)) || 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      flush();
      cur = { file: line.slice(3), lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
      continue;
    }
    if (cur === null) continue;
    if (line.startsWith("LF:")) cur.lf = value(line, "LF:");
    else if (line.startsWith("LH:")) cur.lh = value(line, "LH:");
    else if (line.startsWith("BRF:")) cur.brf = value(line, "BRF:");
    else if (line.startsWith("BRH:")) cur.brh = value(line, "BRH:");
    else if (line.startsWith("FNF:")) cur.fnf = value(line, "FNF:");
    else if (line.startsWith("FNH:")) cur.fnh = value(line, "FNH:");
    else if (line === "end_of_record") flush();
  }
  flush();

  return {
    files,
    total: {
      lines: pct(totals.lh, totals.lf),
      branches: pct(totals.brh, totals.brf),
      functions: pct(totals.fnh, totals.fnf),
    },
  };
}

const pct = (hit, found) => (found > 0 ? (hit / found) * 100 : 100);
const r2 = (n) => Math.round(n * 100) / 100;
const rel = (p) => p.replace(`${root}/`, "");

/**
 * Read the baseline. Missing or unreadable is a FAILURE, not a warning.
 *
 * A missing baseline makes the "no regression" rule silently inert, and that
 * has already happened once: .gitignore excluded coverage/ and the negation
 * rule failed to re-include the baseline, so CI printed "(no baseline)" and
 * passed while the ratchet did nothing. Warn-and-continue is exactly how a
 * gate rots without anyone noticing.
 */
function readBaseline() {
  if (!existsSync(baselinePath)) {
    throw new Error(
      `no coverage baseline at ${rel(baselinePath)}. It must be committed — ` +
        "check .gitignore (a parent-dir ignore blocks later negations). " +
        "Record one with: node scripts/coverage-gate.mjs --update-baseline",
    );
  }
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not a JSON object");
    return parsed;
  } catch (err) {
    throw new Error(`unreadable coverage baseline at ${rel(baselinePath)}: ${err.message}`);
  }
}

function main() {
  const code = runTests();
  if (code !== 0) {
    console.error(`\n✖ unit tests failed (exit ${code}) — coverage not evaluated`);
    process.exit(code);
  }
  if (!existsSync(lcovPath)) {
    console.error(`✖ no coverage output at ${rel(lcovPath)}`);
    process.exit(1);
  }

  const { files, total } = parseLcov(readFileSync(lcovPath, "utf8"));
  const measured = { lines: r2(total.lines), branches: r2(total.branches), functions: r2(total.functions) };

  // Sanity check: an lcov parse that loses branch/function data reports 100%
  // and would rubber-stamp every PR. Fail loudly instead of passing quietly.
  if (files.length === 0) {
    console.error(`✖ lcov parsed to zero files — refusing to report coverage`);
    process.exit(1);
  }
  if (total.branches === 100 && total.functions === 100 && total.lines < 100) {
    console.error("✖ suspicious coverage (branches/functions 100% while lines < 100%) — lcov parse is probably wrong");
    process.exit(1);
  }

  console.log("\n── coverage ─────────────────────────────────────────");
  for (const key of ["lines", "branches", "functions"]) {
    console.log(`${key.padEnd(10)} ${String(measured[key]).padStart(6)}%   (floor ${FLOORS[key]}%)`);
  }

  const worst = [...files].sort((a, b) => a.lines - b.lines).slice(0, 5);
  if (worst.length > 0) {
    console.log("\nleast covered files:");
    for (const f of worst) console.log(`  ${String(r2(f.lines)).padStart(6)}%  ${rel(f.file)}`);
  }

  if (update) {
    const payload = JSON.stringify({ ...measured, updatedAt: new Date().toISOString() }, null, 2) + "\n";
    writeFileSync(baselinePath, payload, "utf8");
    console.log(`\n✔ baseline updated → ${rel(baselinePath)}`);
    return;
  }

  const failures = [];
  for (const key of ["lines", "branches", "functions"]) {
    if (measured[key] < FLOORS[key]) {
      failures.push(`${key} ${measured[key]}% is below the absolute floor ${FLOORS[key]}%`);
    }
  }

  console.log("\n── vs baseline ──────────────────────────────────────");
  const baseline = readBaseline();
  for (const key of ["lines", "branches", "functions"]) {
    if (typeof baseline[key] !== "number") {
      failures.push(`baseline has no "${key}" entry — re-record it with --update-baseline`);
      continue;
    }
    const delta = r2(measured[key] - baseline[key]);
    const sign = delta >= 0 ? "+" : "";
    console.log(`${key.padEnd(10)} ${measured[key]}%  baseline ${baseline[key]}%  ${sign}${delta}`);
    if (delta < -TOLERANCE) {
      failures.push(`${key} fell ${Math.abs(delta)} points below the baseline ${baseline[key]}% (tolerance ${TOLERANCE})`);
    }
  }

  if (failures.length > 0) {
    console.error("\n✖ coverage gate FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\n✔ coverage gate passed");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
}
