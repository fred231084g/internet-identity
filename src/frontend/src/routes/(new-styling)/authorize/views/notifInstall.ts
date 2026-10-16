/**
 * Handing the user to the install that will carry their notifications.
 *
 * Everything the press has to do inside the gesture happens here, and everything the
 * screen still owes the user comes back as a promise: the tab a browser allows only
 * from the click itself, the consent the app is told about when sign-in hands back, and
 * the token the install steps are read off.
 */
import type { ActorSubclass } from "@icp-sdk/core/agent";
import type { _SERVICE } from "$lib/generated/internet_identity_types";
import { allowApp } from "$lib/utils/notifications/enableNotifications";
import {
  openPendingInstallTab,
  signedInstallUrl,
} from "$lib/utils/notifications/installUrl";

/** What pressing Allow on the install screen started. */
export interface StartedInstall {
  /** The consent this press records, settled already where the app held it before.
   *  Held rather than awaited, because sign-in is settled on the screen after this
   *  one and that is where it has to have landed. */
  granted: Promise<void>;
  /** Where the install lives, once there is a token to point at it. */
  url: Promise<string | undefined>;
}

/**
 * Starts the install, synchronously, so it can be called straight from the press.
 *
 * The tab goes first: a browser allows `window.open` only inside the gesture, and an
 * await between the two loses it. It is pointed once the token is signed, and closes
 * itself where this browser has no key to sign one with.
 *
 * The token is signed here rather than while the screen rendered. It is good for half
 * an hour, and one that ran out while the screen was up is refused at the end of the
 * steps, with the app already added to the Home Screen.
 */
export const startAppInstall = ({
  identityNumber,
  origin,
  actor,
  consented,
}: {
  identityNumber: bigint;
  origin: string;
  actor: ActorSubclass<_SERVICE>;
  /** Whether this app already holds consent from this identity. */
  consented: boolean;
}): StartedInstall => {
  const tab = openPendingInstallTab();

  const granted = consented
    ? Promise.resolve()
    : allowApp({ identityNumber, origin, actor });
  // Nothing awaits this until the user leaves the handoff, which is as long as the
  // install steps take. A rejection with nothing attached in between is an unhandled
  // rejection; the promise handed back still carries it to whoever does await.
  void granted.catch(() => undefined);

  const url = signedInstallUrl(identityNumber);
  void url.then(tab.point);

  return { granted, url };
};
