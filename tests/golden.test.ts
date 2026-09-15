/**
 * Golden invariant tests (SPEC.md Section 12). Not broad coverage —
 * "tested where it counts": eight tests, one per load-bearing
 * invariant, each self-contained enough to read start to finish
 * without hunting across the broader suites. Those broader suites
 * (surface-adapter, policy-gate, replay-engine, recorder,
 * evidence-logger, escalation, discovery-loop) cover far more ground;
 * this file is the curated highlight reel SPEC.md Section 12 asks for,
 * not a replacement for them.
 */
import type { Server } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTargetApp } from "../target-app/app.js";
import { PlaywrightWebAdapter } from "../src/surface/web.playwright.js";
import { ArtifactSchema, findRedactedLiteralLeaks } from "../src/schema/artifact.js";
import { enforce, checkOriginAndRoute, loadPolicy, type PolicyT } from "../src/policy/gate.js";
import { EvidenceLogger, redactedFieldsFromArtifact } from "../src/evidence/logger.js";
import { replay, mergeOverlay } from "../src/replay/engine.js";
import type { Artifact } from "../src/schema/artifact.js";

const rawArtifact = JSON.parse(readFileSync(new URL("./fixtures/hand-written-member-lookup.json", import.meta.url), "utf-8"));
const validArtifact = ArtifactSchema.parse(rawArtifact);

const rawPolicy = JSON.parse(readFileSync(new URL("../src/policy/policy.default.json", import.meta.url), "utf-8"));

let server: Server;
let baseUrl: string;
let policy: PolicyT;

beforeAll(async () => {
  server = createTargetApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  baseUrl = `http://localhost:${address.port}`;
  policy = loadPolicy({ ...rawPolicy, allowed_origins: [baseUrl] });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const createAdapter = (url: string) => PlaywrightWebAdapter.create(url, { headless: true });

describe("golden invariants (SPEC.md §12)", () => {
  it("1. schema validation rejects a malformed artifact with a readable error path", () => {
    const malformed = { ...rawArtifact, capability: { ...rawArtifact.capability, version: "not-a-semver" } };
    const result = ArtifactSchema.safeParse(malformed);
    expect(result.success).toBe(false);
    if (!result.success) {
      const path = result.error.issues[0]?.path.join(".");
      expect(path).toBe("capability.version");
    }
  });

  it("2. policy gate blocks navigation to a disallowed origin, including the normalised-traversal case", () => {
    const testPolicy = loadPolicy({ ...rawPolicy, allowed_origins: ["http://localhost:3000"], allowed_routes: ["/members/**"] });

    const disallowedOrigin = enforce(
      { type: "navigate", url: "http://evil.example.com" },
      { url: "http://localhost:3000/members/search", mode: "replay" },
      testPolicy,
    );
    expect(disallowedOrigin.decision).toBe("block");

    // '/members/../admin' resolves (WHATWG URL dot-segment removal) to
    // '/admin' — outside the allowlist — BEFORE the check runs, not after.
    const traversal = checkOriginAndRoute("http://localhost:3000/members/../admin", testPolicy);
    expect(traversal.decision).toBe("block");
    if (traversal.decision === "block") {
      expect(traversal.reason).toContain("/admin");
      expect(traversal.reason).not.toContain("..");
    }
  });

  it("3. redactor strips a marked field from a log line; the artifact writer refuses a literal secret", () => {
    const logger = new EvidenceLogger(loadPolicy(rawPolicy), redactedFieldsFromArtifact(validArtifact));
    logger.info("captured_output", "run_1", { savings_balance: "$4,231.10" });
    expect(logger.getEvents()[0]?.data["savings_balance"]).toBe("[REDACTED:money]");

    // A recorder bug: a literal value slipped into a step instead of a $param reference.
    const leaky = structuredClone(validArtifact);
    leaky.steps[0]!.action = { type: "type", value: "10001" };
    expect(findRedactedLiteralLeaks(leaky, { member_id: "10001" })).toEqual(["10001"]);
  });

  it("4. ambiguous locator raises rather than selecting the first match", async () => {
    const adapter = await createAdapter(new URL("/members/10001", baseUrl).toString());
    try {
      // The account detail page has two headings ("Account summary",
      // "Sub-accounts") — a name-less role_name locator is ambiguous by
      // construction here, not by accident.
      const resolution = await adapter.resolve({ primary: { by: "role_name", role: "heading" }, fallbacks: [] });
      expect(resolution).toMatchObject({ status: "ambiguous", matchCount: 2 });
    } finally {
      await adapter.close();
    }
  });

  it("5. a declared business outcome returns status:\"business_outcome\", specifically not \"failed\"", async () => {
    const result = await replay({ artifact: validArtifact, inputs: { member_id: "99999" }, baseUrl, policy, allowDraft: true, createAdapter });
    expect(result.status).toBe("business_outcome");
    expect(result.status).not.toBe("failed");
    expect(result.outcome?.code).toBe("member_not_found");
  });

  it("6. outcome detector precedence beats a simultaneously-true success checkpoint (EDGE-14)", async () => {
    // A checkpoint that would ALSO be satisfied by the not-found page's
    // own text — if outcomes weren't checked first, this could wrongly
    // report success instead of the declared business outcome.
    const artifactWithOverlappingCheckpoint: Artifact = {
      ...validArtifact,
      success: { ...validArtifact.success, checkpoint: { kind: "text_present", pattern: "No member matching" } },
    };
    const result = await replay({
      artifact: artifactWithOverlappingCheckpoint,
      inputs: { member_id: "99999" },
      baseUrl,
      policy,
      allowDraft: true,
      createAdapter,
    });
    expect(result.status).toBe("business_outcome");
    expect(result.outcome?.code).toBe("member_not_found");
  });

  it("7. overlay merge produces a schema-valid artifact; an overlay referencing an unknown step id fails loudly", () => {
    const validOverlay: Artifact = {
      ...validArtifact,
      overlays: {
        tenant_b: {
          steps: { enter_member_id: { target: { primary: { by: "role_name", role: "textbox", name: "Member Number" }, fallbacks: [] } } },
          outcomes: {},
        },
      },
    };
    const merged = mergeOverlay(validOverlay, "tenant_b");
    expect(() => ArtifactSchema.parse(merged)).not.toThrow();
    expect(merged.steps.find((s) => s.id === "enter_member_id")?.target.primary).toMatchObject({ name: "Member Number" });

    const badOverlay: Artifact = {
      ...validArtifact,
      overlays: { tenant_b: { steps: { no_such_step: { timeout_ms: 1 } }, outcomes: {} } },
    };
    expect(() => mergeOverlay(badOverlay, "tenant_b")).toThrow(/unknown step id/);
  });

  it("8. Playwright stays confined to src/surface/ — the layering claim REPORT.md §1 makes, enforced rather than asserted in prose", () => {
    // Every other module talks to the browser only through SurfaceAdapter's
    // neutral vocabulary (observe/act/resolve/close). If Playwright leaks
    // above that boundary, the "one adapter, replay is deterministic
    // because it never touches Playwright directly" argument stops being
    // true. This used to be a manual grep run before every commit; now it
    // fails the build instead of relying on memory.
    const forbiddenPatterns = [/from ["']playwright["']/, /\bpage\./, /\blocator\(/];
    const scannedDirs = ["schema", "policy", "discovery", "replay", "escalation", "evidence", "cli", "catalog"];
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
          const text = readFileSync(full, "utf-8");
          if (forbiddenPatterns.some((pattern) => pattern.test(text))) offenders.push(full);
        }
      }
    };
    for (const dir of scannedDirs) walk(new URL(`../src/${dir}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

    expect(offenders).toEqual([]);
  });
});
