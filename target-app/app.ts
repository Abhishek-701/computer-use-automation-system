/**
 * Express app factory for the hostile target app (SPEC.md Section 10,
 * P0), separated from server.ts's listen() bootstrap so tests can spin
 * up the app on an ephemeral port without a separate process.
 */
import express from "express";
import { router, errorHandler } from "./routes.js";

export function createTargetApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(router);
  app.use(errorHandler);
  return app;
}
