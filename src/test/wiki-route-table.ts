/**
 * The route table each wiki registration registers — `wiki-read`, `wiki` or
 * `wiki-answers` — derived from a live registration on a bare `Hono`, never
 * hand-typed. Shared by `src/auth/zones.test.ts` and
 * `src/dashboard/routes-profile.test.ts`, so a route moved between the halves
 * moves its zone answer and its presence answer with it.
 */
import { Hono } from "hono";
import type { Config } from "../config.ts";
import { registerWikiReadRoutes, registerWikiToolRoutes } from "../dashboard/routes/wiki-routes.ts";
import { registerWikiAnswerRoutes } from "../dashboard/routes/wiki-answers.ts";

export interface RouteRow {
  readonly method: string;
  readonly path: string;
}

export function wikiRouteTable(half: "read" | "tools" | "answers", profile: "default" | "nais" = "default"): RouteRow[] {
  const app = new Hono();
  const config = { dashboardPort: 3010, profile } as Config;
  if (half === "read") registerWikiReadRoutes(app, config);
  else if (half === "answers") registerWikiAnswerRoutes(app, config);
  else registerWikiToolRoutes(app, config);
  return app.routes.filter((r) => r.method !== "ALL").map((r) => ({ method: r.method, path: r.path }));
}
