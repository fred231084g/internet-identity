/**
 * What the notifications switch does on a device whose notifications arrive in a Home
 * Screen app.
 *
 * This page cannot install one, so the whole of turning them on here is either pointing
 * this identity at an app the device already has or handing the user to the steps that
 * install it. Which of the two it is is only known once the canister has answered, and
 * the press has a tab open and waiting by then.
 */
import type { NotificationAppInfo } from "$lib/generated/internet_identity_types";
import { browserAppStatus } from "$lib/utils/notifications/appStatus";
import { claimDeviceApp } from "$lib/utils/notifications/deviceApp";
import { signedInstallUrl } from "$lib/utils/notifications/installUrl";

/** Notifications reach this identity on this device now, or the install is what is
 *  left and this is where it lives. */
export type AppSwitchOutcome =
  { delivering: true } | { delivering: false; installUrl: string | undefined };

/**
 * Whether pointing this identity at the app another identity here holds left it able to
 * deliver.
 *
 * A handle is offered on the strength of the donor browser pointing at an app, and
 * nothing in that asks the app for a subscription: an app that was installed and never
 * opened has a record and no endpoint. Claiming it would then leave the switch saying
 * on while nothing can arrive, so what the canister says about the app after the claim
 * is what answers.
 */
const claimedAppDelivers = async (identityNumber: bigint): Promise<boolean> => {
  if (!(await claimDeviceApp(identityNumber))) {
    return false;
  }
  const status = await browserAppStatus(identityNumber);
  return status.kind === "app" && status.app.subscribed;
};

/**
 * Turns notifications on for a device whose app carries them, answering what is left.
 *
 * The install URL is signed here rather than kept from the render. Its token is good
 * for half an hour and a settings page sits open for longer, and a token that expired
 * while the page was up is refused at the end of the steps, with the app already added
 * to the Home Screen.
 */
export const turnOnWithApp = async ({
  identityNumber,
  ownApp,
}: {
  identityNumber: bigint;
  /** What this browser's entry says about the app it points at. */
  ownApp: NotificationAppInfo | undefined;
}): Promise<AppSwitchOutcome> => {
  // An app another identity on this browser can hand over is pointed at instead of
  // installed again, which costs the user nothing and iOS a second icon. Only worth
  // asking for where this browser points at nothing.
  if (ownApp === undefined && (await claimedAppDelivers(identityNumber))) {
    return { delivering: true };
  }
  return {
    delivering: false,
    installUrl: await signedInstallUrl(identityNumber),
  };
};
