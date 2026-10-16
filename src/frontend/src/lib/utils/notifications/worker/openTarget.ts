/**
 * What a tapped notification opens, which from the Home Screen app is not the link.
 *
 * iOS gives a standalone web app an in-app browser view for a window opened on another
 * origin, and that view carries its own storage, so the user lands at the app signed
 * out. Handing the link to Safari is possible, but only from a page: a scheme passed to
 * `clients.openWindow` is not honoured and opens the app itself, losing the link. So the
 * app opens a page of its own, in scope, and that page does the handing over.
 *
 * A browser's own worker opens the link directly: a window is a tab there, already
 * carrying the user's session.
 */
import { readAppKey } from "../notificationAppKey";
import { NOTIFICATION_APP_PATH } from "../installUrl";

/** The page that hands the link over, inside the app's scope so it opens in the app. */
const DOORWAY = `${NOTIFICATION_APP_PATH}/open`;

/**
 * Whether this worker is the Home Screen app's.
 *
 * The registration is shared with the browser that installed it, but storage is not: an
 * app key exists only in the app's own partition.
 *
 * Storage that will not answer is taken for the app, because the two wrong answers do
 * not cost the same. Opening the link directly in the app lands the user in the in-app
 * browser view, which carries storage of its own and so no session, with nothing on
 * screen to get them out of it. Sending a browser's user through the doorway costs them
 * one tap on a page that offers the link both ways.
 */
const isTheApp = async (): Promise<boolean> => {
  const stored = await readAppKey();
  switch (stored.kind) {
    case "key":
      return true;
    case "no-key":
      return false;
    case "unreadable":
      return true;
  }
};

export const openable = async (url: string): Promise<string> =>
  url.startsWith("https:") && (await isTheApp())
    ? `${DOORWAY}#${encodeURIComponent(url)}`
    : url;
