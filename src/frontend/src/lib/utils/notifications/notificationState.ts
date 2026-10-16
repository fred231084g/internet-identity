// Reads this browser's notification state and picks which opt-in screen to show.
// Consent is per identity, the subscription is per browser, so the screen turns
// on the combination: a first-timer gets the full pitch, an already-set-up
// browser only needs the app's consent, a blocked browser gets guidance.
//
// Split in two around what each half needs: the browser's own capability and
// subscription need no identity and are read as soon as a request arrives, while
// the registration and the app's consent are read once an identity is chosen.

import type { ActorSubclass } from "@icp-sdk/core/agent";
import type {
  _SERVICE,
  NotificationAppInfo,
} from "$lib/generated/internet_identity_types";
import { browserAppStatus } from "$lib/utils/notifications/appStatus";
import { claimDeviceApp } from "./deviceApp";
import { saidAlreadyInstalled } from "./alreadyInstalled";
import { currentDeviceSubscription, isPushSupported } from "./pushSubscription";
import { loadVapidKey } from "./vapidKeyStore";
import { recordPermission } from "./notificationDiagnostics";
import { browserAndSystem } from "$lib/utils/describeBrowser";
import { browserKeyActor, UnregisteredBrowserError } from "./browserActor";

/** What this browser can do, and what it is subscribed with. */
export interface BrowserPushState {
  supported: boolean;
  permission: NotificationPermission;
  /** The endpoint the browser and the signing key we kept agree on, or `undefined`
   * where there is no live subscription to the key we hold. */
  endpoint?: string;
}

/**
 * This browser as what delivers for this identity.
 *
 * `permission` is Safari's own word for what the user answered here, read off
 * `Notification.permission`, so it says something only on this path.
 */
export interface BrowserDeviceState {
  source: "browser";
  supported: boolean;
  permission: NotificationPermission;
  /** This browser holds a live subscription for the signing key we still keep. */
  subscribed: boolean;
  /** The canister holds that same subscription under this identity. A second identity
   * on a subscribed browser is not registered until it registers for itself, and one
   * another identity's re-subscribe left behind is registered on a dead endpoint. */
  registered: boolean;
}

/**
 * The Home Screen app on this device as what delivers for this identity.
 *
 * It carries no permission. The one that decides whether anything arrives was given
 * inside the app, in a storage partition nothing here can read, and this browser was
 * never asked for one: what is known is what the canister says.
 */
export interface AppDeviceState {
  source: "app";
  /** The app holds a push subscription, which is what being opened and allowed there
   * leaves behind. */
  subscribed: boolean;
  /** This identity has the app switched on. */
  enabled: boolean;
}

/** Whichever of the two delivers here, so a consumer reads what was actually read
 *  rather than this browser's words for something that happened in the app. */
export type DeviceNotificationState = BrowserDeviceState | AppDeviceState;

/**
 * This browser's push state, or `undefined` where it could not be read.
 *
 * Answers rather than throws, because the caller starts this before it has anything
 * to show and a rejection there has no screen to land on. A state that reads as
 * unsupported would quietly skip the opt-in instead, so a failure keeps its own value.
 */
export const readBrowserPushState = async (): Promise<
  BrowserPushState | undefined
> => {
  try {
    const supported = isPushSupported();
    const permission =
      typeof Notification !== "undefined" ? Notification.permission : "denied";
    if (!supported) {
      return { supported, permission };
    }
    const subscription = await currentDeviceSubscription();
    const stored = await loadVapidKey();
    const live =
      subscription !== undefined &&
      stored !== undefined &&
      stored.endpoint === subscription.endpoint;
    return {
      supported,
      permission,
      endpoint: live ? stored.endpoint : undefined,
    };
  } catch (error) {
    console.error(error);
    return undefined;
  }
};

export const readDeviceState = async (
  identityNumber: bigint,
  browser: BrowserPushState,
): Promise<BrowserDeviceState> => {
  const { supported, permission, endpoint } = browser;
  if (!supported || endpoint === undefined) {
    return {
      source: "browser",
      supported,
      permission,
      subscribed: false,
      registered: false,
    };
  }
  return {
    source: "browser",
    supported,
    permission,
    subscribed: true,
    registered: await isRegisteredHere(identityNumber, endpoint),
  };
};

/**
 * Whether the canister holds this identity's registration on the endpoint the browser
 * is actually subscribed with. A registration naming any other endpoint is one another
 * identity's re-subscribe left behind, and reaches nothing.
 */
const isRegisteredHere = async (
  identityNumber: bigint,
  endpoint: string,
): Promise<boolean> => {
  // Signed as the browser, which is what the canister reads the registration off, so
  // a browser no sign-in has registered holds nothing to find.
  let actor;
  try {
    actor = await browserKeyActor(identityNumber);
  } catch (error) {
    if (error instanceof UnregisteredBrowserError) {
      return false;
    }
    throw error;
  }
  const [status] = await actor.get_webpush_subscription_status({
    anchor_number: identityNumber,
  });
  return status?.endpoint === endpoint;
};

/**
 * Whether notifications reach this identity on this device right now.
 *
 * On this browser's path the permission as well as the registration: a permission reset
 * to "default" leaves the rows in place while the browser shows nothing, so a
 * registration alone is not delivery. `registered` already implies supported and
 * subscribed. On the app's path the two things the canister knows: the app is
 * subscribed, and this identity has it switched on.
 */
const deliversHere = (state: DeviceNotificationState): boolean =>
  state.source === "app"
    ? state.subscribed && state.enabled
    : state.permission === "granted" && state.registered;

/** Where what reaches the user is a Home Screen app rather than this browser. iOS
 *  delivers web push nowhere else, so the browser's own permission and subscription say
 *  nothing about whether notifications arrive. */
export const notificationsNeedInstallHere = (): boolean => {
  const { os } = browserAndSystem();
  return "Ios" in os || "Ipados" in os;
};

/**
 * What the canister said about this device's app, as the state the screens read.
 *
 * `undefined` is an app there is nothing to say about, which is both a device with no
 * app and a device the canister could not be asked about: neither delivers, and which
 * of the two it is decides the screen rather than this value.
 */
const asAppState = (app: NotificationAppInfo | undefined): AppDeviceState => ({
  source: "app",
  subscribed: app?.subscribed === true,
  enabled: app?.enabled === true,
});

/**
 * A browser whose state could not be read.
 *
 * Nothing is known, so nothing is decided: the question is put to the user, and
 * answering it reads everything again. A value of its own, so the screen this feeds and
 * the resolution that carries it cannot drift apart over what it says.
 */
const unreadBrowserState: BrowserDeviceState = {
  source: "browser",
  supported: true,
  permission: "default",
  subscribed: false,
  registered: false,
};

export type OptInScreen = "enable" | "skip";

/** Nothing to ask, so the answer is already known, or the question and what answering
 *  it still has to do. */
export type OptInResolution =
  | { screen: "skip"; granted: boolean }
  | {
      screen: "enable";
      state: DeviceNotificationState;
      consented: boolean;
      /** Whether answering installs the Home Screen app rather than asking this browser
       *  for a permission it cannot act on. */
      installFirst: boolean;
    };

/**
 * Which screen this app and identity need.
 *
 * The app's consent and this device's state are independent, so the consent goes out
 * first and is awaited alongside whichever state this device's delivery turns on; only
 * the browser's registration has to wait, since it is read against the endpoint the
 * browser turns out to hold. A failure is left to the caller: it shows the same toast
 * whenever it happens, and the screen it lands on is the one that asks.
 */
export const resolveOptIn = async ({
  identityNumber,
  origin,
  actor,
  browser,
}: {
  identityNumber: bigint;
  origin: string;
  actor: ActorSubclass<_SERVICE>;
  browser: Promise<BrowserPushState | undefined>;
}): Promise<OptInResolution> => {
  // Started rather than awaited: the app's consent and this device's state need nothing
  // from each other, so whichever is slow must not hold up the other.
  const consent = actor
    .notification_consent_granted({ anchor_number: identityNumber, origin })
    .catch(() => false);

  // Asked first, and not after the browser probe. Where delivery is the app's, this
  // browser's own permission and subscription are beside the point: what matters is
  // whether an app on this device delivers for this identity, so the probe is one the
  // answer never reads.
  if (notificationsNeedInstallHere()) {
    return resolveAppOptIn(identityNumber, await consent);
  }

  const [consented, browserState] = await Promise.all([consent, browser]);
  const state =
    browserState === undefined
      ? unreadBrowserState
      : await readDeviceState(identityNumber, browserState);
  // This browser's own permission, which is the one the unblock guidance is written
  // about. The app's path records none, because this browser was never asked for one:
  // what decides whether anything arrives there was answered inside the app.
  recordPermission(state.permission);
  const screen = resolveOptInScreen(state, consented);
  return screen === "skip"
    ? { screen, granted: consented && deliversHere(state) }
    : { screen, state, consented, installFirst: false };
};

/**
 * Which screen a device whose notifications arrive in a Home Screen app needs.
 *
 * An app another identity here already has is pointed at rather than installed again,
 * which costs the user nothing and iOS a second icon. That is worth doing only for a
 * device the canister says has no app; a query that could not be made says nothing
 * about this device, and claiming on it would write a pointing nobody asked for.
 *
 * Returning from every arm rather than falling through: a fourth answer has to be
 * handled here, and a function that has to end in a `return` is where the compiler
 * says so.
 */
const resolveAppOptIn = async (
  identityNumber: bigint,
  consented: boolean,
): Promise<OptInResolution> => {
  let status = await browserAppStatus(identityNumber);
  if (status.kind === "no-app") {
    // The canister is asked again whenever a claim was attempted, whatever the claim
    // answered: it is written before its reply arrives, so a reply that was lost on the
    // way back leaves this browser pointing at an app that a `false` here would deny
    // and send the user to install a second time. A re-read that answers nothing takes
    // the unanswered arm below.
    await claimDeviceApp(identityNumber);
    status = await browserAppStatus(identityNumber);
  }

  switch (status.kind) {
    case "unanswered": {
      // Nothing was learned about this device, so nothing is decided for the user: the
      // question is put to them, and pressing Allow asks the canister again. An install
      // is offered only once an answer says there is no app.
      console.error(`the app could not be read: ${status.reason}`);
      const state = asAppState(undefined);
      return { screen: "enable", state, consented, installFirst: false };
    }
    case "no-app": {
      // What the user told this browser about their own device, which is the one thing
      // nothing here can see: the canister records which browser points at an app, so a
      // second browser on the same phone finds none of its own and would keep asking.
      // Kept in this browser's storage, so an answer given on one phone never speaks for
      // another. It is the whole answer where it is given: a device with an app the
      // canister knows nothing about has nothing left to ask about.
      if (await saidAlreadyInstalled(identityNumber)) {
        return { screen: "skip", granted: consented };
      }
      const state = asAppState(undefined);
      return { screen: "enable", state, consented, installFirst: true };
    }
    case "app": {
      const state = asAppState(status.app);
      const screen = resolveOptInScreen(state, consented);
      return screen === "skip"
        ? { screen, granted: consented && deliversHere(state) }
        : { screen, state, consented, installFirst: !status.app.subscribed };
    }
  }
};

/**
 * What an app is told: this identity allowed it, and this browser delivers.
 *
 * Read again rather than carried over from the resolution, because the user has
 * acted on the screen since.
 */
export const readGranted = async ({
  identityNumber,
  origin,
  actor,
}: {
  identityNumber: bigint;
  origin: string;
  actor: ActorSubclass<_SERVICE>;
}): Promise<boolean> => {
  // Started rather than awaited: the app is waiting on this answer before it can show
  // the user anything, and the consent query has nothing to learn from what this device
  // says, so the two go out together.
  const consent = actor
    .notification_consent_granted({ anchor_number: identityNumber, origin })
    .catch(() => false);

  // Asked the same way the resolution asks it, or an app told yes on one screen would
  // be told no on the next. Where delivery is the Home Screen app's, this browser's own
  // permission is not what the answer turns on.
  if (notificationsNeedInstallHere()) {
    return readAppGranted(identityNumber, consent);
  }

  const [consented, browserState] = await Promise.all([
    consent,
    readBrowserPushState(),
  ]);
  if (browserState === undefined) {
    return false;
  }
  return (
    consented &&
    deliversHere(await readDeviceState(identityNumber, browserState))
  );
};

/**
 * What an app is told where a Home Screen app is what delivers.
 *
 * A function of its own, ending in its switch the way the resolution's does: the two
 * have to agree on every answer the canister can give about this device, and a fourth
 * one is a compile error in both rather than a silent fall through to this browser's
 * permission, which is the one thing the answer here does not turn on.
 */
const readAppGranted = async (
  identityNumber: bigint,
  consent: Promise<boolean>,
): Promise<boolean> => {
  const [consented, status] = await Promise.all([
    consent,
    browserAppStatus(identityNumber),
  ]);
  switch (status.kind) {
    case "app":
      return consented && deliversHere(asAppState(status.app));
    case "no-app":
      // The same word the resolution reads: a device the canister knows no app for
      // still delivers where the user told this browser their phone has one, and an
      // app told yes on the way in must not be told no on the way out.
      return consented && (await saidAlreadyInstalled(identityNumber));
    case "unanswered":
      // An answer that could not be read is not one that delivers: an app is told
      // yes only where something said so.
      console.error(`the app could not be read: ${status.reason}`);
      return false;
  }
};

/** Picks the opt-in screen from device state and existing consent. */
export const resolveOptInScreen = (
  state: DeviceNotificationState,
  allowed: boolean,
): OptInScreen => {
  // Only this browser's path can be unable to carry notifications at all. A device whose
  // app delivers is one iOS already does them on.
  if (state.source === "browser" && !state.supported) {
    return "skip";
  }
  if (allowed && deliversHere(state)) {
    return "skip";
  }
  // A refused permission is asked for here too. No prompt can lift a refusal, so
  // answering leads to the unblock guidance rather than to a prompt, and the user
  // reaches that guidance from the screen that explains why they are being asked.
  return "enable";
};

/**
 * Calls back once this browser's notification permission stops being refused.
 *
 * The unblock steps send the user into browser settings, and nothing in the page can
 * raise the prompt again, so the screen waits for the setting itself to change rather
 * than for the user to come back and press something.
 *
 * `PermissionStatus` reports the change where the browser delivers it, which is
 * immediate and covers a toggle thrown in a site-settings bubble over the page. Not
 * every browser delivers it for notifications, and a settings window on another
 * screen may never return focus here, so the permission is also read on a timer.
 *
 * Returns the function that stops watching, which also runs before the callback.
 */
export const watchNotificationPermission = (
  onAllowed: () => void,
): (() => void) => {
  if (typeof Notification === "undefined") {
    return () => {};
  }
  let stopped = false;
  let detach = () => {};

  const check = () => {
    if (stopped || Notification.permission === "denied") {
      return;
    }
    stop();
    onAllowed();
  };

  const timer = setInterval(check, PERMISSION_POLL_MS);

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    detach();
  };

  void navigator.permissions
    ?.query({ name: "notifications" as PermissionName })
    .then((status) => {
      if (stopped) {
        return;
      }
      status.addEventListener("change", check);
      detach = () => status.removeEventListener("change", check);
    })
    // Not every browser knows the `notifications` permission name, and the ones that
    // do not reject the query. The timer covers them.
    .catch(() => undefined);

  return stop;
};

const PERMISSION_POLL_MS = 1000;
