/**
 * Entry point for the hostile target app (SPEC.md Section 10, P0).
 *
 * Server-rendered, full page reloads, no SPA framework, no API. This is
 * the deliberately hostile stand-in for a legacy back-office banking
 * screen: the only way in is driving the UI the way a human operator
 * would. See target-app/README.md for the full design writeup and
 * seeded-condition table.
 */
import express from "express";
import { router, errorHandler } from "./routes.js";

const PORT = Number(process.env["TARGET_APP_PORT"] ?? 3000);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(router);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`target-app listening on http://localhost:${PORT}`);
  console.log(`entry point: http://localhost:${PORT}/members/search`);
});
