/**
 * What this app is called, in one place.
 *
 * iOS shows it on the Home Screen and in Settings, and the install and unblock steps tell
 * the user to look for it by name, so the steps and the manifest have to agree on it.
 *
 * Must match `name` and `short_name` in `static/ios-icp-alerts.webmanifest`, which
 * `webmanifest.test.ts` asserts.
 */
export const NOTIFICATION_APP_NAME = "ICP Alerts";
