import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "../src/policy/redact.js";

describe("redact", () => {
  it("redactValue produces the canonical marker", () => {
    expect(redactValue("money")).toBe("[REDACTED:money]");
  });

  it("redactText scrubs every occurrence of every configured pattern", () => {
    const patterns = [
      { name: "member_id", pattern: "\\b[0-9]{5}\\b" },
      { name: "account_number", pattern: "\\bSA-[0-9]{5}-[0-9]{4}\\b" },
    ];
    const text = "Member 10002 opened account SA-10002-4821, previously seen as 99999.";
    expect(redactText(text, patterns)).toBe(
      "Member [REDACTED:member_id] opened account [REDACTED:account_number], previously seen as [REDACTED:member_id].",
    );
  });

  it("redactText is a no-op with no patterns configured", () => {
    expect(redactText("nothing to see", [])).toBe("nothing to see");
  });
});
