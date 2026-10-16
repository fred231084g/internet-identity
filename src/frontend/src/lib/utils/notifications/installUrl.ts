/**
 * Sending the user to install the Home Screen app that will carry their notifications.
 *
 * The token is signed before the button is pressed, not in the handler: Safari allows
 * `window.open` only from inside a user gesture, and an `await` between the click and
 * the call loses it. So the screen prepares a URL while it renders and the handler does
 * nothing but open it.
 */
import { signNotificationAppLink } from "$lib/stores/browser-key.store";
import { millisToNanos } from "$lib/utils/time";
import { encodeLinkToken, LINK_TOKEN_LIFETIME_MS } from "./linkToken";

/**
 * The installed app's own path, which is also its manifest scope and start url. It
 * exists for iOS alone, where web push needs a Home Screen app.
 *
 * Everything inside the app is a path under this one, so the pages and the worker
 * compose it rather than spelling the prefix again.
 *
 * Must match `id`, `start_url` and `scope` in `static/ios-icp-alerts.webmanifest`, which
 * `webmanifest.test.ts` asserts.
 */
export const NOTIFICATION_APP_PATH = "/ios-icp-alerts";

/**
 * The URL to install from, or `undefined` where this browser has no key to sign with,
 * which is a browser no sign-in has registered.
 *
 * The token rides the fragment, so it is never sent to the gateway, and iOS bookmarks
 * the whole URL: the installed app launches holding it.
 *
 * Rejects where the key could not be read or signed with, which is not a browser
 * without a key and must not be offered the install as though it were.
 */
export const prepareInstallUrl = async (
  identityNumber: bigint,
): Promise<string | undefined> => {
  const expiresAtNs = millisToNanos(Date.now() + LINK_TOKEN_LIFETIME_MS);
  const signature = await signNotificationAppLink({
    identityNumber,
    expiresAtNs,
  });
  if (signature === undefined) {
    return undefined;
  }
  return `${NOTIFICATION_APP_PATH}#${encodeLinkToken({
    identityNumber,
    expiresAtNs,
    signature,
  })}`;
};

/**
 * Where the install lives, or `undefined` where this browser has nothing to send the
 * user to: no key to sign a token with, or a key store that could not be read.
 *
 * The reason is logged rather than raised. The two read the same way on screen, and a
 * rejection would leave the blank tab the press opened standing with nothing in it and
 * nothing to close it.
 */
export const signedInstallUrl = async (
  identityNumber: bigint,
): Promise<string | undefined> => {
  try {
    return await prepareInstallUrl(identityNumber);
  } catch (error) {
    console.error(error);
    return undefined;
  }
};

/**
 * Opens the install in a tab of its own, reporting whether the browser allowed it.
 *
 * Must be called straight from the click, which is the only time a browser allows it.
 * The tab is opened empty and pointed afterwards where the URL is still being signed:
 * the token is a signature over an expiry, so it is not ready the instant a screen
 * renders, and a user who answers quickly would otherwise be told their browser had not
 * finished signing in. Opening now and navigating when the signature lands keeps both
 * the gesture and the token.
 *
 * A blocked tab is not an error: the design answers it by showing the link instead,
 * which the user can follow themselves.
 */
export const openInstallTab = (
  url: string | Promise<string | undefined>,
): boolean => {
  const opened = window.open("", "_blank");
  if (opened === null) {
    return false;
  }
  if (typeof url === "string") {
    opened.location.href = url;
    return true;
  }
  void url.then(
    (signed) => {
      if (signed === undefined) {
        // Nothing to send them to, and an empty tab says less than none.
        opened.close();
        return;
      }
      opened.location.href = signed;
    },
    (error: unknown) => {
      // Signing reaches storage and WebCrypto, either of which can refuse. The caller
      // is handed a boolean before any of that happens and has nothing to await, so a
      // rejection left here would be an empty tab nothing ever closes.
      console.error(error);
      opened.close();
    },
  );
  return true;
};

/** A tab opened inside the press, waiting for somewhere to go. */
export interface PendingInstallTab {
  /** Whether the browser allowed the tab. A refused one is not a failure: the screen
   *  behind it carries the link, which the user can follow themselves. */
  opened: boolean;
  /** Points it at the install, or closes it where there is nothing to point it at. */
  point: (url: string | undefined) => void;
}

/**
 * Opens the install tab and hands back the way to point it, for a press that only knows
 * where the install lives once the canister has answered and the token is signed.
 *
 * Must be called straight from the click. Both entry points onto the install do this,
 * and both have to open before they await anything, which is what makes it one thing
 * rather than a pair of promise dances.
 */
export const openPendingInstallTab = (): PendingInstallTab => {
  let point: (url: string | undefined) => void = () => {};
  const opened = openInstallTab(
    new Promise<string | undefined>((resolve) => {
      point = resolve;
    }),
  );
  return { opened, point };
};
