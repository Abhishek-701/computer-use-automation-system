/**
 * Entry point for the hostile target app (SPEC.md Section 10, P0).
 *
 * Server-rendered, full page reloads, no SPA framework, no API. This is
 * the deliberately hostile stand-in for a legacy back-office banking
 * screen: the only way in is driving the UI the way a human operator
 * would. See target-app/README.md for the full design writeup and
 * seeded-condition table.
 */
import { createTargetApp } from "./app.js";

/**
 * Plain positional-flag parsing, not src/cli's parseArgs — target-app
 * has no dependency on the CLI package and this is the only flag it
 * needs. CLI args take priority over env vars so the same command works
 * identically on Windows (no `VAR=value cmd` shell syntax) and POSIX.
 */
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const PORT = Number(argValue("--port") ?? process.env["TARGET_APP_PORT"] ?? 3000);
const MEMBER_ID_LABEL = argValue("--member-id-label") ?? process.env["MEMBER_ID_LABEL"] ?? "Member ID";

createTargetApp({ memberIdLabel: MEMBER_ID_LABEL }).listen(PORT, () => {
  console.log(`target-app listening on http://localhost:${PORT} (member id label: "${MEMBER_ID_LABEL}")`);
  console.log(`entry point: http://localhost:${PORT}/members/search`);
});
