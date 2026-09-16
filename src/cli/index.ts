#!/usr/bin/env node
/**
 * CLI entry point (SPEC.md §4, §17): discover | replay | show | catalog | stability.
 *
 * `catalog` is an optional tier (SPEC.md §15 T1) and is not implemented —
 * it prints a clear message and exits non-zero rather than silently
 * doing nothing or crashing on a missing module. `stability` (T2) *is*
 * implemented, as the "confidence & approval" + "multi-run stability"
 * stretch goals: it replays an artifact N times, tallies the result, and
 * writes `provenance.stability` to the artifact file — but never itself
 * changes `capability.status`. That stays a `show --promote`/`--approve`
 * action: a score is evidence for a human decision, not the decision
 * (REPORT.md §2's whole reason the draft gate exists).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replay } from "../replay/engine.js";
import { isEligibleForVerification, summarizeStability, type StabilitySample } from "../replay/stability.js";
import { runDiscovery } from "../discovery/loop.js";
import { parseGoalSpec } from "../discovery/prompt.js";
import { parseArtifact, type Artifact } from "../schema/artifact.js";
import { loadPolicy, type PolicyT } from "../policy/gate.js";
import { PlaywrightWebAdapter } from "../surface/web.playwright.js";
import { EvidenceLogger, redactedFieldsFromArtifact } from "../evidence/logger.js";

const DEFAULT_BASE_URL = "http://localhost:3000";
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ARTIFACTS_DIR = fileURLToPath(new URL("../../artifacts/", import.meta.url));
const POLICY_DEFAULT_PATH = fileURLToPath(new URL("../policy/policy.default.json", import.meta.url));

interface ParsedArgs {
  values: Record<string, string>;
  flags: Set<string>;
  inputs: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const inputs: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--")) continue;
    const name = arg.slice(2);
    if (name === "input") {
      const kv = args[++i];
      const eq = kv?.indexOf("=") ?? -1;
      if (!kv || eq < 0) throw new Error(`--input requires key=value, got: ${kv ?? "(nothing)"}`);
      inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values[name] = next;
      i++;
    } else {
      flags.add(name);
    }
  }
  return { values, flags, inputs };
}

function loadPolicyForBaseUrl(baseUrl: string): PolicyT {
  const raw = JSON.parse(readFileSync(POLICY_DEFAULT_PATH, "utf-8")) as { allowed_origins: string[] };
  const origin = new URL(baseUrl).origin;
  const allowed_origins = raw.allowed_origins.includes(origin) ? raw.allowed_origins : [...raw.allowed_origins, origin];
  return loadPolicy({ ...raw, allowed_origins });
}

async function cmdDiscover(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const goalSpecPath = parsed.values["goal-spec"];
  if (!goalSpecPath) {
    console.error("discover requires --goal-spec <path> (see goal-specs/member.savings_balance.lookup.json)");
    return 1;
  }
  const rawGoalSpec = JSON.parse(readFileSync(goalSpecPath, "utf-8"));
  const goalSpecResult = parseGoalSpec(rawGoalSpec);
  if (!goalSpecResult.ok) {
    console.error("invalid goal spec:\n" + goalSpecResult.errors.join("\n"));
    return 1;
  }
  let goalSpec = goalSpecResult.goalSpec;
  if (parsed.values["goal"]) goalSpec = { ...goalSpec, goal: parsed.values["goal"] };

  let baseUrl = parsed.values["base-url"] ?? DEFAULT_BASE_URL;
  if (parsed.values["target"]) {
    const target = new URL(parsed.values["target"]);
    baseUrl = target.origin;
    goalSpec = { ...goalSpec, entryPoint: target.pathname + target.search };
  }

  const inputValues = { ...parsed.inputs };
  for (const input of goalSpec.inputs) {
    if (!(input.name in inputValues)) inputValues[input.name] = input.example;
  }

  const policy = loadPolicyForBaseUrl(baseUrl);
  const model = parsed.values["model"] ?? "claude-sonnet-5";
  const headless = !parsed.flags.has("headed");

  console.log(`discovering '${goalSpec.capabilityId}' against ${new URL(goalSpec.entryPoint, baseUrl).toString()} ...`);
  const outcome = await runDiscovery({
    goalSpec,
    inputValues,
    baseUrl,
    policy,
    createAdapter: (url) => PlaywrightWebAdapter.create(url, { headless }),
    model,
    maxDurationMs: 10 * 60 * 1000,
    onStep: (step) => console.log(`  [step ${step.index}] ${step.toolName}${step.reasoning ? ` — ${step.reasoning}` : ""}`),
    onRejected: (info) => console.log(`  [rejected] ${info.toolName}: ${info.error}`),
  });

  if (outcome.status === "persisted") {
    console.log(`\npersisted: ${outcome.artifactPath}`);
    console.log(`verified_replays: ${outcome.artifact.provenance.verified_replays}`);
    return 0;
  }
  console.error(`\nnot persisted: ${outcome.reason}`);
  return 1;
}

async function cmdReplay(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const capabilityId = parsed.values["capability"];
  if (!capabilityId) {
    console.error("replay requires --capability <id>");
    return 1;
  }
  const raw = JSON.parse(readFileSync(`${ARTIFACTS_DIR}${capabilityId}.json`, "utf-8"));
  const parsedArtifact = parseArtifact(raw);
  if (!parsedArtifact.ok) {
    console.error("invalid artifact:\n" + parsedArtifact.errors.join("\n"));
    return 1;
  }

  const baseUrl = parsed.values["base-url"] ?? DEFAULT_BASE_URL;
  const policy = loadPolicyForBaseUrl(baseUrl);
  const tenant = parsed.values["tenant"];
  const evidenceDir = parsed.values["evidence-dir"];

  const runId = `run_${randomUUID()}`;
  const logger = new EvidenceLogger(policy, redactedFieldsFromArtifact(parsedArtifact.artifact));

  const result = await replay({
    artifact: parsedArtifact.artifact,
    inputs: parsed.inputs,
    baseUrl,
    policy,
    allowDraft: parsed.flags.has("allow-draft"),
    runId,
    logger,
    ...(tenant ? { tenant } : {}),
    ...(evidenceDir ? { evidenceDir } : {}),
    createAdapter: (url) => PlaywrightWebAdapter.create(url, { headless: true }),
  });

  // result.evidence.log is the repo-relative convention string (e.g.
  // "evidence/run_x/log.jsonl"); resolve it against the repo root, not
  // process.cwd(), so `npm run replay` from any directory writes to the
  // same place the JSON output claims. Best-effort, matching
  // attachFailureEvidence's own rule: a write problem here must never
  // mask or replace the real replay result already computed above.
  try {
    logger.writeToFile(join(REPO_ROOT, result.evidence.log));
  } catch (err) {
    console.error(`warning: failed to write evidence log: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(JSON.stringify(result, null, 2));
  return result.status === "success" || result.status === "business_outcome" ? 0 : 1;
}

/**
 * Reads, validates, and prints an artifact — and, with `--promote` /
 * `--approve`, mutates its `capability.status` in place. Both are
 * explicit, one-at-a-time human actions guarding real preconditions:
 * `--promote` (draft -> verified) refuses without a clean
 * `provenance.stability` report on file; `--approve` (verified ->
 * approved) refuses unless already verified. Neither can be triggered
 * by a computed score alone — see cmdStability.
 */
function cmdShow(args: string[]): number {
  const parsed = parseArgs(args);
  const capabilityId = parsed.values["capability"];
  if (!capabilityId) {
    console.error("show requires --capability <id>");
    return 1;
  }
  const artifactPath = `${ARTIFACTS_DIR}${capabilityId}.json`;
  const raw = JSON.parse(readFileSync(artifactPath, "utf-8"));
  const parsedResult = parseArtifact(raw);
  if (!parsedResult.ok) {
    console.error("invalid artifact:\n" + parsedResult.errors.join("\n"));
    return 1;
  }
  let artifact: Artifact = parsedResult.artifact;
  let mutated = false;

  if (parsed.flags.has("promote")) {
    if (artifact.capability.status !== "draft") {
      console.error(`cannot promote: status is '${artifact.capability.status}', not 'draft'`);
      return 1;
    }
    const report = artifact.provenance.stability;
    if (!report || !isEligibleForVerification(report)) {
      console.error(
        `cannot promote: no clean provenance.stability report on file. Run: npm run stability -- --capability ${capabilityId} --input <k=v> [--runs N]`,
      );
      return 1;
    }
    artifact = { ...artifact, capability: { ...artifact.capability, status: "verified" } };
    console.log(`promoted '${capabilityId}': draft -> verified (evidence: ${report.successes}/${report.runs} clean runs, 0 drift, checked ${report.checked_at})`);
    mutated = true;
  }

  if (parsed.flags.has("approve")) {
    if (artifact.capability.status !== "verified") {
      console.error(`cannot approve: status is '${artifact.capability.status}', not 'verified' — promote it first`);
      return 1;
    }
    artifact = {
      ...artifact,
      capability: { ...artifact.capability, status: "approved" },
      provenance: { ...artifact.provenance, approved_at: new Date().toISOString() },
    };
    console.log(`approved '${capabilityId}': verified -> approved`);
    mutated = true;
  }

  if (mutated) writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf-8");

  console.log(JSON.stringify(artifact, null, 2));
  return 0;
}

async function cmdStability(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const capabilityId = parsed.values["capability"];
  if (!capabilityId) {
    console.error("stability requires --capability <id> --input k=v [--runs N]");
    return 1;
  }
  const artifactPath = `${ARTIFACTS_DIR}${capabilityId}.json`;
  const raw = JSON.parse(readFileSync(artifactPath, "utf-8"));
  const parsedArtifact = parseArtifact(raw);
  if (!parsedArtifact.ok) {
    console.error("invalid artifact:\n" + parsedArtifact.errors.join("\n"));
    return 1;
  }

  const runs = Number(parsed.values["runs"] ?? 5);
  const baseUrl = parsed.values["base-url"] ?? DEFAULT_BASE_URL;
  const policy = loadPolicyForBaseUrl(baseUrl);
  const tenant = parsed.values["tenant"];

  console.log(`running '${capabilityId}' ${runs} times against ${baseUrl} ...`);
  const samples: StabilitySample[] = [];
  for (let i = 0; i < runs; i++) {
    // Sequential, not Promise.all: each run launches its own Chromium
    // instance, and this is a stability *measurement*, not a throughput
    // test — parallel runs would also make timing meaningless.
    const result = await replay({
      artifact: parsedArtifact.artifact,
      inputs: parsed.inputs,
      baseUrl,
      policy,
      // Deliberate: this is a controlled, explicit, human-invoked
      // measurement run against a possibly-draft artifact, not the
      // unattended production replay --allow-draft's gate exists to
      // stop (REPORT.md §2). It never writes capability.status itself.
      allowDraft: true,
      ...(tenant ? { tenant } : {}),
      createAdapter: (url) => PlaywrightWebAdapter.create(url, { headless: true }),
    });
    const detail = result.status === "failed" || result.status === "failed_dirty" ? ` (${result.failure?.error_class})` : "";
    console.log(`  [run ${i + 1}/${runs}] ${result.status}${detail}`);
    samples.push(result);
  }

  const report = summarizeStability(samples);
  const eligible = isEligibleForVerification(report);
  console.log(`\n${JSON.stringify(report, null, 2)}`);
  console.log(`note: drift_events is measured over successful runs only — business_outcome/failed results carry no locator warnings.`);

  const artifact = parsedArtifact.artifact;
  const updated: Artifact = {
    ...artifact,
    provenance: {
      ...artifact.provenance,
      stability: report,
      // One counter, not two disagreeing ones: a stability batch's
      // successes feed the same verified_replays field discovery's
      // own EDGE-27 check seeded, rather than living beside it unread.
      ...(report.successes > 0 ? { verified_replays: artifact.provenance.verified_replays + report.successes, last_verified_at: report.checked_at } : {}),
    },
  };
  writeFileSync(artifactPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  console.log(`wrote provenance.stability to ${artifactPath}`);

  if (artifact.capability.status === "draft") {
    console.log(
      eligible
        ? `eligible for promotion — run: npm run show -- --capability ${capabilityId} --promote`
        : `not eligible for promotion: needs >=1 success, 0 failures, 0 locator drift across all ${runs} runs`,
    );
  }

  return 0;
}

function cmdNotImplemented(name: string, tier: string): number {
  console.error(`'${name}' is not implemented — optional tier (SPEC.md Section 15, ${tier}). See README.md Cuts.`);
  return 1;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env present — fine for replay/show, which need no API key.
  }

  const [, , command, ...rest] = process.argv;
  let code: number;
  switch (command) {
    case "discover":
      code = await cmdDiscover(rest);
      break;
    case "replay":
      code = await cmdReplay(rest);
      break;
    case "show":
      code = cmdShow(rest);
      break;
    case "catalog":
      code = cmdNotImplemented("catalog", "T1");
      break;
    case "stability":
      code = await cmdStability(rest);
      break;
    default:
      console.error(`unknown command '${command ?? ""}'. Usage: discover | replay | show | catalog | stability`);
      code = 1;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
