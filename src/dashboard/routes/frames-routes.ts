/**
 * The frames a capture summary quotes inline, served READ-ONLY off
 * `~/.muninn/frames/<source>/<id>/<sec>.jpg` — the only writer is a capture's
 * `keepReferencedFrames`.
 *
 * `GET /api/frames/:source/:id/:file` is the shape every vertical uses.
 * `GET /api/vimeo/frames/:videoId/:file` is an ALIAS over the same root, kept
 * because every Vimeo document ingested before the seam quotes that path and
 * huginn stores the summary markdown verbatim — a reader opening a talk
 * captured last week must still see its slides.
 *
 * Registered INSIDE the `summaries` route group rather than as a group of its
 * own: vimeo, youtube and summaries are all dropped together on
 * `MUNINN_PROFILE=nais`, so a new group would buy nothing but a `ROUTE_GROUPS`
 * + `NAIS_DROPPED_ROUTE_GROUPS` + registration-list edit and a restructuring of
 * `routes-profile.test.ts`, whose probe table is literal paths a parameterised
 * route cannot satisfy.
 *
 * Default-deny by charset: the source must be a known one, the id must pass
 * THAT source's `idRe` and the file must be `<digits>.jpg`, all before any
 * filesystem access. Anything else is a 404, never a 400 that confirms the
 * shape.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import { realpath } from "node:fs/promises";
import {
  FRAME_FILE_RE,
  VIMEO_FRAME_SOURCE,
  frameSourceByName,
  framesRootDir,
  isFrameId,
  type FrameSource,
} from "../../summaries/frames.ts";

export interface FramesRouteOptions {
  /** Where the route reads from; default {@link framesRootDir}. A TEST MUST pass one. */
  framesRoot?: string;
}

export function registerFramesRoutes(app: Hono, _config: Config, opts: FramesRouteOptions = {}): void {
  const framesRoot = opts.framesRoot ?? framesRootDir();

  async function serveFrame(
    source: FrameSource | undefined,
    id: string,
    file: string,
  ): Promise<Response | null> {
    if (!source || !isFrameId(source, id) || !FRAME_FILE_RE.test(file)) return null;
    const fileAbs = resolvePath(framesRoot, source.name, id, file);
    // Containment is judged on the REAL path the kernel would open, not on the
    // spelling: with the charset gates holding, the spelling is always
    // `<root>/<source>/<id>/<digits>.jpg` (enumerated), so a lexical prefix
    // check is dead code — and blind to a SYMLINK under the root pointing
    // outside it (measured by review of #525: a planted `<root>/7 →
    // /tmp/outside` served `/7/9.jpg` with 200). `realpath` follows symlinks on
    // both sides; a missing file throws and is the same 404 as before.
    // RESIDUAL, stated: a HARDLINK planted under the root is invisible to
    // `realpath` too and still serves — the guard against that is that the only
    // writer under the root is `keepReferencedFrames`, which writes plain files.
    let rootReal: string;
    let fileReal: string;
    try {
      [rootReal, fileReal] = await Promise.all([realpath(framesRoot), realpath(fileAbs)]);
    } catch {
      return null;
    }
    if (!fileReal.startsWith(rootReal + pathSep)) return null;
    const f = Bun.file(fileReal);
    if (!(await f.exists())) return null;
    return new Response(f, {
      headers: {
        "Content-Type": "image/jpeg",
        // A frame is (video, second) — re-extracting the same second of the
        // same rendition is the same picture, so a day of caching is safe —
        // PRIVATE, because this route sits in the default-deny (admin) zone
        // under MUNINN_AUTH and `public` would let a shared cache in front of
        // the instance serve a slide to a request that would otherwise 403.
        "Cache-Control": "private, max-age=86400",
      },
    });
  }

  app.get("/api/frames/:source/:id/:file", async (c) => {
    const { source, id, file } = c.req.param();
    return (await serveFrame(frameSourceByName(source), id, file)) ?? c.notFound();
  });

  // The alias. Same root, same bytes, same headers — it resolves the source
  // itself rather than reading one off the path.
  app.get("/api/vimeo/frames/:videoId/:file", async (c) => {
    const { videoId, file } = c.req.param();
    return (await serveFrame(VIMEO_FRAME_SOURCE, videoId, file)) ?? c.notFound();
  });
}
