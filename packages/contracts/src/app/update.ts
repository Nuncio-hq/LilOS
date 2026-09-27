import { z } from "zod";

/**
 * Update-feed contract (issue #35): the JSON document the desktop app polls
 * to learn about a newer release. The feed is one static file served over
 * HTTP(S) — `update-feed.json` next to the release assets (GitHub Releases
 * by default); the app never talks to an updater service.
 *
 * One release updates app + relay + harness together: the DMG payload is a
 * zipped `LilOS.app` whose bundled helper binaries are stamped with the same
 * release version, so a single `build` number orders every component.
 */

/** One downloadable release: a zipped `LilOS.app` plus its checksum. */
export const UpdateRelease = z.object({
  /** Marketing version shown to the user (CFBundleShortVersionString). */
  version: z.string().min(1),
  /** Monotonic build number (CFBundleVersion) — the update compare key. */
  build: z.int().min(1),
  /** URL of the zipped .app payload (`ditto -x -k` extracts it). */
  url: z.string().min(1),
  /** Lowercase hex SHA-256 of the zip — verified before anything stages. */
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  sizeBytes: z.int().min(1).optional(),
  notes: z.string().optional(),
});
export type UpdateRelease = z.infer<typeof UpdateRelease>;

/** The feed document the app fetches: which release is current. */
export const UpdateFeed = z.object({
  latest: UpdateRelease,
});
export type UpdateFeed = z.infer<typeof UpdateFeed>;
