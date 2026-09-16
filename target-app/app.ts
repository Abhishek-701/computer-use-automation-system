/**
 * Express app factory for the hostile target app (SPEC.md Section 10,
 * P0), separated from server.ts's listen() bootstrap so tests can spin
 * up the app on an ephemeral port without a separate process.
 */
import express from "express";
import { router, errorHandler } from "./routes.js";

export interface TargetAppOptions {
  /**
   * Stand-in for "the same vendor product, branded/configured
   * differently per tenant" (SPEC.md Section 3.7 / brief): a deployment-level
   * setting, not a per-request query flag, since a real second bank's
   * install wouldn't be distinguished by a URL parameter. Only the
   * search field's label/accessible-name varies; everything else about
   * the app (routes, business logic, iframe nesting) is identical,
   * which is the whole point — proving artifact reuse via a sparse
   * `overlays` patch, not a rebuild.
   */
  memberIdLabel?: string;
}

export function createTargetApp(options: TargetAppOptions = {}): express.Express {
  const app = express();
  app.locals["memberIdLabel"] = options.memberIdLabel ?? "Member ID";
  app.use(express.urlencoded({ extended: false }));
  app.use(router);
  app.use(errorHandler);
  return app;
}
