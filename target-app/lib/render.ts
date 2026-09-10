/**
 * Rendering helpers for the hostile target app (SPEC.md Section 10).
 *
 * Every helper here exists to manufacture one of the required hostile
 * properties: hashed/regenerated ids and classes, deeply nested
 * table-based layout, and inline onclick handlers in place of semantic
 * controls. None of it is real styling — it only needs to *look* like a
 * legacy enterprise app to an automated observer, not to a human.
 */
import { randomBytes } from "node:crypto";

/** Escape untrusted/dynamic text before interpolating into HTML. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A regenerated-per-render id. Never stable across two requests. */
export function rid(prefix = "f"): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/** A hashed, meaningless CSS class name. */
export function hashedClass(): string {
  return `c${randomBytes(3).toString("hex")}`;
}

/**
 * Wrap content in N levels of single-cell `<table>` used purely for
 * layout, not data. Real legacy back-office markup does this to nest
 * toolbars/panels/forms without CSS.
 */
export function layoutTable(inner: string, depth = 3): string {
  let html = inner;
  for (let i = 0; i < depth; i++) {
    html = `<table class="${hashedClass()}" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td class="${hashedClass()}">${html}</td></tr></tbody></table>`;
  }
  return html;
}

/** Full HTML document shell. */
export function page(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
</head>
<body class="${hashedClass()}">
${bodyHtml}
</body>
</html>`;
}

/** HTML document containing a single iframe pointing at the given src. */
export function framePage(title: string, iframeSrc: string, frameLabel: string): string {
  const frameId = rid("frame");
  return page(
    title,
    layoutTable(
      `<iframe id="${frameId}" title="${esc(frameLabel)}" src="${esc(iframeSrc)}" style="width:100%;height:640px;border:1px solid #999"></iframe>`,
      1,
    ),
  );
}
