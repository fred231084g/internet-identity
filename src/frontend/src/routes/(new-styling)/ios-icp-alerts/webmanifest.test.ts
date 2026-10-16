// The path constant's module reaches the browser key store, which opens its database as
// it is imported, and jsdom serves no IndexedDB.
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_APP_PATH } from "$lib/utils/notifications/installUrl";
import { NOTIFICATION_APP_NAME } from "./appName";

/**
 * The manifest iOS reads when the user adds this app to the Home Screen.
 *
 * Read off disk, because it is served as a static file and nothing in the bundle imports
 * it: the name and the path are spelled here and again as constants, so only a test that
 * reads both can keep the two spellings together.
 */
const manifest = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../static/ios-icp-alerts.webmanifest",
    ),
    "utf-8",
  ),
) as Record<string, string>;

describe("the Home Screen app's manifest", () => {
  /**
   * iOS labels the Home Screen icon from the manifest, and the install and unblock steps
   * name the app from the constant. A disagreement sends the user looking for an app that
   * is not there under the name they were told.
   */
  it.each(["name", "short_name"])("names the app in %s", (field) => {
    expect(manifest[field]).toBe(NOTIFICATION_APP_NAME);
  });

  /**
   * The install URL is built from the constant, and iOS launches the installed app at the
   * manifest's `start_url` and keeps it inside its `scope`. A path that disagrees opens
   * the app away from the token that was installed with it, or leaves iOS treating the
   * launch as a different app under a second `id`.
   */
  it.each(["id", "start_url", "scope"])("serves the app at %s", (field) => {
    expect(manifest[field]).toBe(NOTIFICATION_APP_PATH);
  });
});
