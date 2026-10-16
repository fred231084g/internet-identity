/**
 * Where a launch of this page lands.
 *
 * The same URL is a browser tab and the installed app, and what either shows is settled
 * against the canister rather than against anything this document holds: a browser can
 * point another identity at an app while it is not running, and iOS can destroy the
 * app's storage without telling it. Kept apart from the page so that the deciding can be
 * read, and tested, without a document around it.
 */
import { isCanisterError, throwCanisterError } from "$lib/utils/utils";
import { browserKeyActor } from "$lib/utils/notifications/browserActor";
import { ensureAppKey } from "$lib/utils/notifications/notificationAppKey";
import { registerForAnyAnchor } from "$lib/utils/notifications/subscribeDevice";
import {
  appAnchors,
  browserAppStatus,
} from "$lib/utils/notifications/appStatus";
import {
  decodeLinkToken,
  type FragmentLinkToken,
  type LinkToken,
} from "$lib/utils/notifications/linkToken";
import { recordAlreadyInstalled } from "$lib/utils/notifications/alreadyInstalled";
import { appKeyActor } from "./appKeyActor";
import { linkWithToken, type LinkOutcome } from "./link";

/** What this page is doing, which is settled on mount and not before: the answer
 *  depends on the document it is running in and on storage this partition holds. */
export type Screen =
  | { kind: "working" }
  /** A browser tab, with no app on this device to point at yet. */
  | { kind: "install"; replacingApp?: boolean }
  /** Nothing here reaches an identity, and the host is where that is fixed: a tab
   *  arrived without a link token, which is the only thing that can point an app at an
   *  identity, or an app every identity pointing at it refuses to register for. */
  | { kind: "unlinked" }
  /** A browser tab the user is done with, where `window.close()` did nothing because
   *  no script opened it. */
  | { kind: "closed" }
  /** A browser tab, where this browser already points at an app. Nothing here can open
   *  it: iOS has no link capturing, so only the user's finger crosses that boundary. */
  | { kind: "open-app" }
  /** The app, with the permission still to ask for. iOS raises the prompt only from a
   *  gesture, so there is a button and not a call on mount. */
  | { kind: "ask" }
  /** The app, with the permission refused. Only iOS Settings can lift it. */
  | { kind: "blocked" }
  /** Delivering. Reached in both documents, and `inTheApp` is which one this is: the
   *  tab carries a way to say the app is gone, which inside the running app would be
   *  asking the user about something they are looking at. */
  | { kind: "ready"; inTheApp: boolean }
  /** The app, with no identity pointing at it. */
  | { kind: "orphaned" }
  /** The app, carrying a link it could not spend: a token the canister refused, or a
   *  fragment it could not read. A fresh link finishes the install either way, so there
   *  is nothing to remove and add back. */
  | { kind: "stale-link" }
  /** The app, whose own key the canister will not link. A key is minted once per storage
   *  partition and this app has no way to mint another, so the way on is a fresh app. */
  | { kind: "unusable-key" }
  | { kind: "failed"; reason: string };

/**
 * Where a launch that could not be settled lands.
 *
 * Registering is part of every launch and it can be refused, and `CanisterError`
 * carries no message, so the variant is the whole of what it said.
 */
export const failed = (error: unknown): Screen => {
  console.error(error);
  return {
    kind: "failed",
    reason: isCanisterError(error)
      ? String(error.type)
      : error instanceof Error
        ? error.message
        : String(error),
  };
};

/**
 * What the browser tab shows: the steps, where to find the app it already has, or that
 * there is nothing left to do.
 *
 * The token names the identity and is what an app spends to get a record of its own, so
 * a tab that cannot read one can only send the user back to where tokens are handed out.
 * Otherwise there are three answers and this browser's entry carries all three: no app,
 * an app that is not delivering yet, and one that is.
 */
export const insideTheBrowser = async (hash: string): Promise<Screen> => {
  const fragment = decodeLinkToken(hash);
  switch (fragment.kind) {
    case "no-token":
      return { kind: "unlinked" };
    case "unreadable":
      // A damaged link, which this tab is on the handing-out end of rather than the
      // receiving one: the host it is sent back to mints another. The same screen as a
      // tab with no token, and the reason is of use in a log and nowhere else.
      console.error(fragment.reason);
      return { kind: "unlinked" };
    case "token":
      return await settleTheTab(fragment.token);
  }
};

/** What this browser's entry says to do about the identity a readable token named. */
const settleTheTab = async (token: LinkToken): Promise<Screen> => {
  const status = await browserAppStatus(token.identityNumber);
  switch (status.kind) {
    case "unanswered":
      // Offering the install here would walk a user who already has the app through
      // adding a second one, on the strength of a query that never happened.
      return { kind: "failed", reason: status.reason };
    case "no-app":
      return { kind: "install" };
    case "app": {
      if (!status.app.enabled) {
        // The token this user arrived with is minted by pressing turn notifications
        // on, so the flag is what they came to flip. Nothing else here can: a replayed
        // link does not re-enable, registering does not touch the flag, and the probe
        // behind the open-app screen answers not-reachable while it is off. Signed as
        // the browser, which is whose choice it is.
        try {
          const browser = await browserKeyActor(token.identityNumber);
          await browser
            .set_notification_app_enabled({
              anchor_number: token.identityNumber,
              enabled: true,
            })
            .then(throwCanisterError);
        } catch (error) {
          // A write nothing else in this launch reads. The app is there and switched
          // off, which is what the open-app screen says and is still true, so ending
          // the whole tab on a failure screen would take away the one screen that
          // fits. The token stays in the URL, so a reload asks again.
          console.error(error);
          return { kind: "open-app" };
        }
      }
      return status.app.subscribed
        ? { kind: "ready", inTheApp: false }
        : { kind: "open-app" };
    }
  }
};

/**
 * What spending this launch's fragment did, and `null` where there was nothing to spend.
 *
 * A fragment that cannot be read is a refused token and not a launch carrying none:
 * there is a browser waiting at the other end of a damaged link, so the app that holds
 * one needs a fresh link rather than the steps shown to someone who has not started.
 *
 * `null` rather than `undefined` so that a fourth arm is a compile error here: a return
 * type carrying `undefined` lets an unhandled arm fall out of the switch as the ordinary
 * launch, which is the one answer that quietly goes on as if nothing had arrived.
 */
const spendTheFragment = async (
  fragment: FragmentLinkToken,
  actor: Awaited<ReturnType<typeof appKeyActor>>,
  record: Awaited<ReturnType<typeof ensureAppKey>>,
): Promise<LinkOutcome | null> => {
  switch (fragment.kind) {
    case "no-token":
      // The ordinary launch, which is every launch after the one that dropped the token
      // from the URL.
      return null;
    case "unreadable":
      return { status: "token-refused", reason: fragment.reason };
    case "token":
      return await linkWithToken(actor, record, fragment.token);
  }
};

/**
 * What the app shows.
 *
 * `onTokenSpent` runs for a token the canister took, so the page can drop it from the
 * URL rather than present it again on a reload.
 */
export const insideTheApp = async (
  hash: string,
  permission: NotificationPermission,
  onTokenSpent: () => void,
): Promise<Screen> => {
  const record = await ensureAppKey();
  const actor = await appKeyActor(record);

  // The Home Screen entry captured the URL as it was at install and replays it at every
  // launch, token and all, so from half an hour after the install every launch presents
  // an expired one. Only a failure to reach the canister stops a launch: a token it
  // refuses leaves the app exactly as the launch before it found it, and what this app
  // already serves is the question the rest of the launch answers.
  const outcome = await spendTheFragment(decodeLinkToken(hash), actor, record);
  if (outcome?.status === "failed") {
    return { kind: "failed", reason: outcome.reason };
  }
  if (outcome?.status === "key-refused") {
    // Terminal, and before the anchors are read: whatever this app already serves, the
    // key it signs with is one the canister will not take, and only a fresh install
    // gives it another.
    return { kind: "unusable-key" };
  }
  if (outcome?.status === "linked") {
    onTokenSpent();
  }

  const anchors = await appAnchors(actor);
  if (anchors.length === 0 && outcome?.status === "token-refused") {
    return { kind: "stale-link" };
  }
  return await settle(permission, actor, anchors);
};

/** Where this launch lands, for a permission in whichever state it is in. */
const settle = async (
  permission: NotificationPermission,
  actor: Awaited<ReturnType<typeof appKeyActor>>,
  anchors: bigint[],
): Promise<Screen> => {
  if (anchors.length === 0) {
    // Nothing to register for, and nothing to ask a permission for either: what is
    // registered is signed as the app and named for an anchor it serves.
    return { kind: "orphaned" };
  }
  if (permission === "denied") {
    return { kind: "blocked" };
  }
  if (permission === "default") {
    return { kind: "ask" };
  }
  // Registered on every launch and not only the one that linked: the push service hands
  // out a new endpoint whenever it likes, and opening the app is the only moment
  // anything can write the new one.
  //
  // Signed as the app, so what it registers lands on its own record and every identity
  // pointing at it is delivered through it. The anchor named is one it serves, which is
  // what authorizes the call rather than where the subscription goes, so the first that
  // the canister accepts settles the whole launch. The list is what the app serves and
  // not what reaches it: an identity that switched this app off, and one whose browser
  // holds no session, are both in it and both refuse the call.
  if (!(await registerForAnyAnchor(anchors, actor))) {
    // Every identity pointing at this app has it switched off or is signed out, and
    // the host is where either is fixed. The app itself is intact, so telling the user
    // to delete it would be asking for the wrong thing.
    return { kind: "unlinked" };
  }
  return { kind: "ready", inTheApp: true };
};

/** Settles against the canister as the app, for a permission the page has just read. */
export const settleWithTheApp = async (
  permission: NotificationPermission,
): Promise<Screen> => {
  const record = await ensureAppKey();
  const actor = await appKeyActor(record);
  return await settle(permission, actor, await appAnchors(actor));
};

/**
 * Where the app lands when the user comes back from iOS Settings, which is the only
 * place a refused permission can be lifted.
 *
 * This runs in the app document, where `Notification.permission` is defined and is the
 * whole of what the rest of the launch needs. Read here rather than through a reader
 * that answers `undefined` on failure, since the only value to put in its place is a
 * state the user may have just left.
 */
export const settleFromSettings = (): Promise<Screen> =>
  settleWithTheApp(Notification.permission);

/**
 * Where the tab lands when the user says this device already has the app.
 *
 * Their word is the whole of the answer: the app runs in a storage partition of its own
 * and the canister records which browser points at one, so a second browser on the same
 * phone finds nothing however often it looks. Recording it is what stops this browser
 * offering the install again; nothing here can reach the app it is being told about, so
 * there is no link to promise and the tab is done. The way back from saying it by
 * mistake is the switch in settings, off and on.
 */
export const afterAlreadyAdded = async (hash: string): Promise<Screen> => {
  const fragment = decodeLinkToken(hash);
  switch (fragment.kind) {
    case "token":
      await recordAlreadyInstalled(fragment.token.identityNumber);
      return { kind: "closed" };
    case "no-token":
    case "unreadable":
      // Nothing names an identity to record the answer against, and the tab is done
      // either way: what it was told is about a device, not about a link.
      return { kind: "closed" };
  }
};
