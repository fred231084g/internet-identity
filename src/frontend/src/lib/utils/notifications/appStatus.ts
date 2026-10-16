/**
 * What the canister says about this device's Home Screen app, asked by whoever is asking.
 *
 * The browser asks about its own entry, signing with its browser key, because the install
 * page is a tab of its own with no session. The app asks which identities point at it,
 * signing as itself, because nothing in its storage knows: a browser can point another
 * identity at it while it is not running.
 */
import type { ActorSubclass } from "@icp-sdk/core/agent";
import type {
  _SERVICE,
  NotificationAppInfo,
  ProbeNotificationAppError,
} from "$lib/generated/internet_identity_types";
import {
  browserKeyActor,
  UnregisteredBrowserError,
} from "$lib/utils/notifications/browserActor";
import { isCanisterError, throwCanisterError } from "$lib/utils/utils";

/**
 * What this browser's entry says about the app it points at.
 *
 * Three answers and not two. A query that could not be made is not an entry that points
 * at nothing: a caller that read the one as the other would take a flaky network for an
 * app the user deleted, and send someone with a working app through the install again.
 *
 * A browser the canister has never registered is an answer, not a failure. It has no
 * key to ask with, so there is nothing for this identity on this device, and nothing a
 * later attempt would find either.
 */
export type BrowserAppStatus =
  | { kind: "app"; app: NotificationAppInfo }
  | { kind: "no-app" }
  | { kind: "unanswered"; reason: string };

export const browserAppStatus = async (
  identityNumber: bigint,
): Promise<BrowserAppStatus> => {
  try {
    const actor = await browserKeyActor(identityNumber);
    const [app] = await actor.get_notification_app_status({
      anchor_number: identityNumber,
    });
    return app === undefined ? { kind: "no-app" } : { kind: "app", app };
  } catch (error) {
    if (error instanceof UnregisteredBrowserError) {
      return { kind: "no-app" };
    }
    console.error(error);
    return {
      kind: "unanswered",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * The identities this app delivers for.
 *
 * Empty where its record is gone and where it never had one, which the app answers the
 * same way: there is nothing here, and the user is sent back to their browser.
 */
export const appAnchors = async (
  actor: ActorSubclass<_SERVICE>,
): Promise<bigint[]> => Array.from(await actor.notification_app_anchors());

/**
 * What asking the canister to wake this browser's app did.
 *
 * `no-app` is not a probe that failed. This browser points at nothing, so there is no
 * app to open and the user belongs on the install steps. `not-sent` is nothing having
 * left the canister, which is no evidence about the app in either direction: it is what
 * an app with no endpoint registered, an identity that has it switched off, a browser
 * without a session or one past its gone-after window, and a canister out of outcall
 * capacity all come back as.
 */
export type ProbeOutcome =
  | { kind: "sent"; probeId: bigint }
  | { kind: "no-app" }
  | { kind: "not-sent"; reason: string };

/**
 * Asks the canister to wake the app this browser points at, answering what it queued.
 *
 * Nothing says when a user deletes a web app, so the only way to tell a live one from a
 * deleted one is to send it something: an app that is gone answers 404 or 410 at the
 * push service, which takes its record with it, and an app that is there takes the
 * notification off this browser's queue.
 */
export const probeApp = async (
  identityNumber: bigint,
): Promise<ProbeOutcome> => {
  try {
    const actor = await browserKeyActor(identityNumber);
    const probeId = await actor
      .probe_notification_app({ anchor_number: identityNumber })
      .then(throwCanisterError);
    return { kind: "sent", probeId };
  } catch (error) {
    if (error instanceof UnregisteredBrowserError) {
      return { kind: "no-app" };
    }
    if (isCanisterError<ProbeNotificationAppError>(error)) {
      switch (error.type) {
        case "NoNotificationApp":
          return { kind: "no-app" };
        case "NotReachable":
          return { kind: "not-sent", reason: error.type };
      }
    }
    console.error(error);
    return {
      kind: "not-sent",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
