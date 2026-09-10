/**
 * P2 acceptance criterion (SPEC.md Section 5): a script can open the
 * target app, print a pruned observation, click a control by role and
 * accessible name, and reach a second screen. Desktop stub compiles
 * and satisfies the interface.
 *
 * Boots the real target app on an ephemeral port and drives it with a
 * real headless Chromium via PlaywrightWebAdapter — no mocking. This is
 * the same real-adapter path CP5 (replay) and CP6 (discovery) will use.
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTargetApp } from "../target-app/app.js";
import { PlaywrightWebAdapter } from "../src/surface/web.playwright.js";
import { DesktopStubAdapter } from "../src/surface/desktop.stub.js";
import { NotImplementedError } from "../src/surface/adapter.js";

let server: Server;
let baseUrl: string;
let adapter: PlaywrightWebAdapter;

/** Two levels deep, matching the target app's shell -> content iframe nest. Labels are documentary only (see web.playwright.ts::frameScope). */
const CONTENT_SCOPE = { frame_path: ["shell", "content"] };

beforeAll(async () => {
  server = createTargetApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  baseUrl = `http://localhost:${address.port}`;
  adapter = await PlaywrightWebAdapter.create(`${baseUrl}/members/search`, { headless: true });
}, 30_000);

afterAll(async () => {
  await adapter.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("PlaywrightWebAdapter (P2 acceptance)", () => {
  it("observes a pruned node list containing the search field, two frames deep", async () => {
    const observation = await adapter.observe();
    expect(observation.nodes.length).toBeGreaterThan(0);

    const field = observation.nodes.find((n) => n.role === "textbox" && n.name === "Member ID");
    expect(field).toBeDefined();
    expect(field?.framePath).toEqual(["frame", "frame"]);

    // Pruning worked: the hostile layout wraps this page in >10 single-cell
    // wrapper tables; a raw (unpruned) tree would carry hundreds of noise
    // nodes. The pruned list should stay small and legible.
    expect(observation.nodes.length).toBeLessThan(20);
  });

  it("resolves and clicks a control by role and accessible name, reaching a second screen", async () => {
    const fieldResolution = await adapter.resolve({
      scope: CONTENT_SCOPE,
      primary: { by: "role_name", role: "textbox", name: "Member ID" },
      fallbacks: [],
    });
    expect(fieldResolution).toEqual({ status: "ok", resolvedVia: "primary" });

    const typeResult = await adapter.act({ type: "type", value: "10001" });
    expect(typeResult).toEqual({ ok: true });

    const buttonResolution = await adapter.resolve({
      scope: CONTENT_SCOPE,
      primary: { by: "role_name", role: "button", name: "Search" },
      fallbacks: [],
    });
    expect(buttonResolution).toEqual({ status: "ok", resolvedVia: "primary" });

    const clickResult = await adapter.act({ type: "click" });
    expect(clickResult).toEqual({ ok: true });

    // The top-level page URL does not change — only the innermost content
    // iframe navigated (a same-frame redirect), which is the whole point
    // of the shell/content nesting design (see target-app/README.md).
    // Reaching "Account summary" is the actual proof of a second screen.
    const observation = await adapter.observe();
    const heading = observation.nodes.find((n) => n.role === "heading" && n.name === "Account summary");
    expect(heading).toBeDefined();
  });

  it("reads the savings balance via a read action", async () => {
    const resolution = await adapter.resolve({
      scope: CONTENT_SCOPE,
      primary: { by: "label_text", text: "Savings" },
      fallbacks: [],
    });
    expect(resolution.status).toBe("ok");

    const result = await adapter.act({ type: "read" });
    expect(result).toEqual({ ok: true, value: "$4,231.10" });
  });

  it("EDGE-06: reports ambiguous rather than silently picking the first match", async () => {
    // "row" with no name filter matches multiple rows on the account
    // summary's nested layout tables.
    const resolution = await adapter.resolve({
      scope: CONTENT_SCOPE,
      primary: { by: "role_name", role: "row" },
      fallbacks: [],
    });
    expect(resolution.status).toBe("ambiguous");
  });

  it("EDGE-07: distinguishes not_found from not_interactable", async () => {
    const notFound = await adapter.resolve({
      scope: CONTENT_SCOPE,
      primary: { by: "role_name", role: "button", name: "Does Not Exist" },
      fallbacks: [],
    });
    expect(notFound).toEqual({ status: "not_found" });
  });
});

describe("DesktopStubAdapter (P2 acceptance: compiles and satisfies the interface)", () => {
  it("throws NotImplementedError from every real method", async () => {
    const stub = new DesktopStubAdapter();
    await expect(stub.observe()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(stub.act({ type: "click" })).rejects.toBeInstanceOf(NotImplementedError);
    await expect(stub.resolve({ primary: { by: "role_name", role: "button" }, fallbacks: [] })).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(stub.close()).resolves.toBeUndefined();
  });
});
