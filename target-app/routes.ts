/**
 * Route table for the hostile target app (SPEC.md Section 10).
 *
 * Flow: member search -> results -> member detail with account table ->
 * open sub-account form -> confirmation screen.
 *
 * Framing design: only the top-level `/members/search` entry point
 * constructs the two-level iframe nest (shell -> content). Every
 * subsequent navigation (links, form actions, redirects) targets a
 * plain content URL and is a same-frame navigation by ordinary browser
 * mechanics, so it replaces the document *inside* the already-nested
 * content iframe — the whole flow stays two levels deep from the top
 * document without every route needing its own wrapper.
 */
import { Router, type Request, type Response } from "express";
import { esc, framePage, hashedClass, layoutTable, page, rid } from "./lib/render.js";
import { type Flags, flagsHiddenInputs, flagsQuery, parseFlags, sleep } from "./lib/flags.js";
import {
  getMember,
  isMultipleMatchesId,
  isNotFoundId,
  isPermissionDeniedId,
  isValidMemberId,
  multipleMatchesRows,
  type Member,
} from "./lib/data.js";

export const router = Router();

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

class BoomError extends Error {}

/** Seeded conditions that apply uniformly at any content step. */
async function applyGenericFlags(flags: Flags): Promise<void> {
  if (flags.boom) throw new BoomError("Seeded failure (?boom=1)");
  if (flags.slow) await sleep(flags.slow);
}

function currentUrl(req: Request): string {
  return req.originalUrl;
}

function withDismissed(url: string): string {
  return url.includes("?") ? `${url}&dismissed=1` : `${url}?dismissed=1`;
}

/**
 * Wrap content with a blocking interstitial overlay when the flag is
 * active and this exact URL hasn't been marked dismissed yet. Every
 * content step calls this, so the interstitial can be seeded on any
 * page in the flow and always resolves the same way: dismiss, retry.
 */
function withInterstitial(flags: Flags, req: Request, contentHtml: string): string {
  if (!flags.interstitial || flags.dismissed) return contentHtml;
  const dismissHref = withDismissed(currentUrl(req));
  const overlayId = rid("overlay");
  return `
<div id="${overlayId}" class="${hashedClass()}" role="alertdialog" aria-label="System Announcement"
     style="position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:999">
  <div class="${hashedClass()}" style="background:#fff;padding:24px;max-width:360px">
    <p><strong>System Announcement</strong></p>
    <p>Scheduled maintenance tonight 11pm-1am. Some features may be unavailable.</p>
    <span role="button" tabindex="0" class="${hashedClass()}"
          onclick="location.href='${esc(dismissHref)}'">Dismiss</span>
  </div>
</div>
${contentHtml}`;
}

function errorPage(status: number, title: string, message: string): string {
  return page(
    title,
    layoutTable(`<h1>${esc(title)}</h1><p>${esc(message)}</p>`, 1),
  );
}

// ---------------------------------------------------------------------
// Entry point + iframe shell
// ---------------------------------------------------------------------

router.get("/", (_req, res) => {
  res.redirect(302, "/members/search");
});

router.get("/members/search", (req, res) => {
  const q = flagsQuery(parseFlags(req.query));
  const shellSrc = `/members/search/shell${q ? `?${q}` : ""}`;
  res.type("html").send(framePage("Member Search", shellSrc, "Application shell"));
});

router.get("/members/search/shell", (req, res) => {
  const q = flagsQuery(parseFlags(req.query));
  const contentSrc = `/members/search/content${q ? `?${q}` : ""}`;
  res.type("html").send(framePage("Member Search", contentSrc, "Application content"));
});

// ---------------------------------------------------------------------
// Search form (content level)
// ---------------------------------------------------------------------

function renderSearchForm(flags: Flags, errorMessage: string | null, memberIdLabel: string): string {
  const formId = rid("form");
  const fieldId = rid("member-id");
  const controlId = rid("search-btn");
  const errorBlock = errorMessage
    ? `<p role="alert" class="${hashedClass()}">${esc(errorMessage)}</p>`
    : "";
  return `
<form id="${formId}" class="${hashedClass()}" method="post" action="/members/search/content">
${layoutTable(
    `<label for="${fieldId}">${esc(memberIdLabel)}</label>
     <input type="text" id="${fieldId}" name="member_id" class="${hashedClass()}">
     ${errorBlock}
     <span role="button" tabindex="0" id="${controlId}" class="${hashedClass()}"
           onclick="document.getElementById('${formId}').submit()">Search</span>`,
    2,
  )}
${flagsHiddenInputs(flags)}
</form>`;
}

router.get("/members/search/content", async (req, res, next) => {
  try {
    const flags = parseFlags(req.query);
    await applyGenericFlags(flags);
    const memberIdLabel = req.app.locals["memberIdLabel"] as string;
    const content = withInterstitial(flags, req, renderSearchForm(flags, null, memberIdLabel));
    res.type("html").send(page("Member Search", content));
  } catch (err) {
    next(err);
  }
});

router.post("/members/search/content", async (req, res, next) => {
  try {
    const flags = parseFlags(req.body, req.query);
    await applyGenericFlags(flags);
    const memberIdLabel = req.app.locals["memberIdLabel"] as string;

    const memberId = String(req.body["member_id"] ?? "").trim();

    if (!isValidMemberId(memberId)) {
      const content = withInterstitial(
        flags,
        req,
        renderSearchForm(flags, "Please enter a valid 5-digit member ID.", memberIdLabel),
      );
      res.type("html").send(page("Member Search", content));
      return;
    }

    if (isNotFoundId(memberId)) {
      const content = withInterstitial(flags, req, renderResults([], "No member matching that ID."));
      res.type("html").send(page("Search Results", content));
      return;
    }

    if (isPermissionDeniedId(memberId)) {
      const content = withInterstitial(
        flags,
        req,
        `${layoutTable(`<h1>Access Denied</h1><p>You are not authorized to view this member record.</p>`, 1)}`,
      );
      res.type("html").send(page("Access Denied", content));
      return;
    }

    if (isMultipleMatchesId(memberId)) {
      const rows = multipleMatchesRows(memberId);
      const content = withInterstitial(flags, req, renderResults(rows, null, flags));
      res.type("html").send(page("Search Results", content));
      return;
    }

    // Single canonical match: redirect to the canonical member URL.
    const q = flagsQuery(flags);
    res.redirect(302, `/members/${memberId}${q ? `?${q}` : ""}`);
  } catch (err) {
    next(err);
  }
});

function renderResults(rows: Member[], emptyMessage: string | null, flags?: Flags): string {
  if (rows.length === 0) {
    return layoutTable(`<h1>Search Results</h1><p>${esc(emptyMessage ?? "No results.")}</p>`, 1);
  }
  const q = flags ? flagsQuery(flags) : "";
  const rowsHtml = rows
    .map(
      (m) => `<tr class="${hashedClass()}">
        <td class="${hashedClass()}">${esc(m.id)}</td>
        <td class="${hashedClass()}">${esc(m.name)}</td>
        <td class="${hashedClass()}"><a href="/members/${esc(m.id)}${q ? `?${q}` : ""}">View</a></td>
      </tr>`,
    )
    .join("\n");
  return layoutTable(
    `<h1>Search Results</h1>
     <table class="${hashedClass()}">
       <thead><tr><th>Member ID</th><th>Name</th><th></th></tr></thead>
       <tbody>${rowsHtml}</tbody>
     </table>`,
    1,
  );
}

// ---------------------------------------------------------------------
// Member detail
// ---------------------------------------------------------------------

router.get("/members/:id", async (req, res, next) => {
  try {
    const flags = parseFlags(req.query);
    await applyGenericFlags(flags);

    const id = req.params["id"] ?? "";
    if (!isValidMemberId(id)) {
      res.status(404).type("html").send(errorPage(404, "Not Found", "No such member route."));
      return;
    }
    const member = getMember(id);
    const q = flagsQuery(flags);
    const subaccountHref = `/members/${esc(member.id)}/subaccount/new${q ? `?${q}` : ""}`;

    const body = `
<h2>Account summary</h2>
${layoutTable(
      `<table class="${hashedClass()}">
        <tbody>
          <tr><td><label for="mid-${member.id}">Member ID</label></td>
              <td><input id="mid-${member.id}" type="text" value="${esc(member.id)}" readonly></td></tr>
          <tr><td><label for="mname-${member.id}">Name</label></td>
              <td><input id="mname-${member.id}" type="text" value="${esc(member.name)}" readonly></td></tr>
          <tr><td><label for="sv-${member.id}">Savings</label></td>
              <td><input id="sv-${member.id}" type="text" value="${esc(member.savingsBalance)}" readonly></td></tr>
          <tr><td><label for="notes-${member.id}">Notes</label></td>
              <td><textarea id="notes-${member.id}" readonly>${esc(member.notes)}</textarea></td></tr>
        </tbody>
      </table>
      <h3>Sub-accounts</h3>
      <table class="${hashedClass()}">
        <thead><tr><th>Type</th><th>Balance</th></tr></thead>
        <tbody><tr><td>Primary Savings</td><td>${esc(member.savingsBalance)}</td></tr></tbody>
      </table>
      <a href="${esc(subaccountHref)}">Open sub-account</a>`,
      2,
    )}`;

    const content = withInterstitial(flags, req, body);
    res.type("html").send(page(`Member ${member.id}`, content));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Sub-account form + confirmation (mutating step)
// ---------------------------------------------------------------------

router.get("/members/:id/subaccount/new", async (req, res, next) => {
  try {
    const flags = parseFlags(req.query);
    await applyGenericFlags(flags);

    if (flags.expire) {
      res
        .status(440)
        .type("html")
        .send(
          errorPage(
            440,
            "Session Expired",
            "Your session has expired. Please sign in again to continue.",
          ),
        );
      return;
    }

    const id = req.params["id"] ?? "";
    if (!isValidMemberId(id)) {
      res.status(404).type("html").send(errorPage(404, "Not Found", "No such member route."));
      return;
    }

    const formId = rid("form");
    const typeFieldId = rid("acct-type");
    const depositFieldId = rid("deposit");
    const submitId = rid("confirm-btn");

    const body = `
<h2>Open sub-account</h2>
<form id="${formId}" method="post" action="/members/${esc(id)}/subaccount/new">
${layoutTable(
      `<label for="${typeFieldId}">Account type</label>
       <select id="${typeFieldId}" name="account_type">
         <option value="checking">Checking</option>
         <option value="savings">Savings</option>
       </select>
       <label for="${depositFieldId}">Initial deposit</label>
       <input type="text" id="${depositFieldId}" name="initial_deposit">
       <button type="submit" id="${submitId}">Confirm</button>`,
      2,
    )}
${flagsHiddenInputs(flags)}
</form>`;

    const content = withInterstitial(flags, req, body);
    res.type("html").send(page("Open Sub-account", content));
  } catch (err) {
    next(err);
  }
});

router.post("/members/:id/subaccount/new", async (req, res, next) => {
  try {
    const flags = parseFlags(req.body, req.query);
    await applyGenericFlags(flags);

    if (flags.expire) {
      res
        .status(440)
        .type("html")
        .send(
          errorPage(
            440,
            "Session Expired",
            "Your session has expired. Please sign in again to continue.",
          ),
        );
      return;
    }

    const id = req.params["id"] ?? "";
    const accountNumber = `SA-${id}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const acctNumFieldId = rid("acct-num");
    const body = layoutTable(
      `<h2>Sub-account opened</h2>
       <label for="${acctNumFieldId}">Account number</label>
       <input id="${acctNumFieldId}" type="text" value="${esc(accountNumber)}" readonly>`,
      1,
    );
    const content = withInterstitial(flags, req, body);
    res.type("html").send(page("Confirmation", content));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Error handler (must be registered last by server.ts)
// ---------------------------------------------------------------------

export function errorHandler(err: unknown, _req: Request, res: Response, _next: unknown): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  res
    .status(500)
    .type("html")
    .send(errorPage(500, "Internal Server Error", message));
}
