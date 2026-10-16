// Opt-in orchestration: ask for permission where it is not granted, subscribe and
// register the device where it is not registered, then record consent where the app
// does not have it. Each step is skipped when the resolved state says it is already
// done, so an app allowed elsewhere only costs this browser its registration and a
// browser already set up only costs the consent.
//
// Subscribing before recording consent, so a refusal at the browser prompt leaves no
// consent row behind for a browser that cannot receive anything.

import type { ActorSubclass } from "@icp-sdk/core/agent";
import type { _SERVICE } from "$lib/generated/internet_identity_types";
import { throwCanisterError } from "$lib/utils/utils";
import { requestNotificationPermission } from "./pushSubscription";
import { ensureRegisteredDevice } from "./subscribeDevice";
import { claimDeviceApp } from "./deviceApp";
import { setAppEnabled } from "./appEnabled";
import { clearNotificationsOff } from "./turnedOff";
import { browserAppStatus } from "$lib/utils/notifications/appStatus";
import type { DeviceNotificationState } from "./notificationState";

type GrantArgs = {
  identityNumber: bigint;
  origin: string;
  actor: ActorSubclass<_SERVICE>;
};

export type EnableNotificationsResult =
  | {
      /** `dismissed` is a prompt closed without an answer, which leaves the permission
       * at `default` and can be asked again; `denied` cannot, and needs unblock steps.
       * `install-required` is a device whose notifications arrive in a Home Screen app
       * that is not there, which is the install steps rather than anything this can
       * do. */
      status: "enabled" | "denied" | "dismissed" | "install-required";
    }
  | {
      /** Nothing could be read about the app this device's notifications arrive in, so
       * this is neither a yes nor a no: what the caller does with it has to be
       * something the user never has to undo. */
      status: "unanswered";
      reason: string;
    };

export const turnOnNotifications = async ({
  identityNumber,
  origin,
  actor,
  device,
  consented,
}: {
  identityNumber: bigint;
  origin: string;
  actor: ActorSubclass<_SERVICE>;
  /** This browser as the opt-in resolved it, which is what each step reads to know
   *  whether it has anything to do. */
  device: DeviceNotificationState;
  consented: boolean;
}): Promise<EnableNotificationsResult> => {
  // A browser that cannot hold a subscription has nothing to prompt for: what reaches the
  // user is the app this device has, and pointing this identity at it is the whole of
  // turning notifications on here. Raising a prompt would ask for a permission that
  // decides nothing, and subscribing would register an endpoint iOS never delivers to.
  if (device.source === "app") {
    return turnOnInApp({ identityNumber, origin, actor, consented });
  }

  if (device.permission !== "granted") {
    const permission = await requestNotificationPermission();
    if (permission !== "granted") {
      return { status: permission === "denied" ? "denied" : "dismissed" };
    }
  }

  // Whatever the switch in settings said, the user is asking for notifications here.
  await clearNotificationsOff(identityNumber);

  if (!device.registered) {
    // Subscribing drops the endpoint every other identity here is registered with, so
    // this is the one call that must not run for a browser already registered.
    await ensureRegisteredDevice(identityNumber);
  }

  if (!consented) {
    await grantConsent({ identityNumber, origin, actor });
  }

  return { status: "enabled" };
};

/**
 * Turning notifications on where a Home Screen app carries them.
 *
 * An app another identity on this browser has is pointed at rather than installed
 * again, which costs the user nothing and iOS a second icon. That is worth trying only
 * where the canister says this browser points at no app: a query that could not be made
 * says nothing about this device, and claiming on it would write a pointing nobody
 * asked for and send someone with a working app through the install.
 *
 * Returning from every arm rather than falling through: a fourth answer has to be
 * handled here, and a function that must end in a `return` is where the compiler says
 * so.
 */
const turnOnInApp = async ({
  identityNumber,
  origin,
  actor,
  consented,
}: GrantArgs & { consented: boolean }): Promise<EnableNotificationsResult> => {
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
    case "unanswered":
      return { status: "unanswered", reason: status.reason };
    case "no-app":
      return { status: "install-required" };
    case "app": {
      const { subscribed, enabled } = status.app;
      // A record without a subscription is an app that has not been opened and allowed
      // yet, which is the install steps rather than anything this can do.
      if (!subscribed) {
        return { status: "install-required" };
      }
      if (!enabled) {
        // The app delivers, and this identity has it switched off in settings: its flag
        // is the whole of whether the app delivers for them, so allowing here turns it
        // back on.
        await setAppEnabled({ identityNumber, enabled: true });
      }
      if (!consented) {
        await grantConsent({ identityNumber, origin, actor });
      }
      return { status: "enabled" };
    }
  }
};

/**
 * Records consent for an app without touching any subscription, so there is no
 * permission prompt and no new endpoint. Consent belongs to the identity, so it
 * reaches every browser already registered for notifications.
 */
export const allowApp = ({
  identityNumber,
  origin,
  actor,
}: {
  identityNumber: bigint;
  origin: string;
  actor: ActorSubclass<_SERVICE>;
}): Promise<void> => grantConsent({ identityNumber, origin, actor });

/**
 * Withdraws an app's consent, which also drops what it has queued for every browser.
 * The subscription stays: it belongs to the browser, and the identity's other apps
 * still reach it.
 */
export const disallowApp = ({
  identityNumber,
  origin,
  actor,
}: GrantArgs): Promise<void> =>
  actor
    .notification_revoke_consent({ anchor_number: identityNumber, origin })
    .then(throwCanisterError)
    .then(() => undefined);

/** Records consent for the app. The canister mints the application it hangs off. */
const grantConsent = ({
  identityNumber,
  origin,
  actor,
}: GrantArgs): Promise<void> =>
  actor
    .notification_grant_consent({ anchor_number: identityNumber, origin })
    .then(throwCanisterError)
    .then(() => undefined);
