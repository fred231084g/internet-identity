import { beforeEach, describe, expect, it, vi } from "vitest";
// The canister reads and the token signing, which is what this orchestrates: what is
// under test is which of them it asks and when.
vi.mock("$lib/utils/notifications/appStatus", () => ({
  browserAppStatus: vi.fn(),
}));
vi.mock("$lib/utils/notifications/deviceApp", () => ({
  claimDeviceApp: vi.fn(),
}));
vi.mock("$lib/utils/notifications/installUrl", () => ({
  signedInstallUrl: vi.fn(),
}));

import type { NotificationAppInfo } from "$lib/generated/internet_identity_types";
import { browserAppStatus } from "$lib/utils/notifications/appStatus";
import { claimDeviceApp } from "$lib/utils/notifications/deviceApp";
import { signedInstallUrl } from "$lib/utils/notifications/installUrl";
import { turnOnWithApp } from "./notificationsSwitch";

const IDENTITY = BigInt(10_000);

const appStatus = vi.mocked(browserAppStatus);
const claim = vi.mocked(claimDeviceApp);
const installUrl = vi.mocked(signedInstallUrl);

const app = (over: Partial<NotificationAppInfo> = {}) =>
  ({ subscribed: true, enabled: true, ...over }) as NotificationAppInfo;

describe("turnOnWithApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appStatus.mockReset();
    claim.mockResolvedValue(false);
    installUrl.mockResolvedValue("/ios-icp-alerts#first");
  });

  it("points this identity at the app another identity here hands over", async () => {
    claim.mockResolvedValue(true);
    appStatus.mockResolvedValue({ kind: "app", app: app() });

    await expect(
      turnOnWithApp({ identityNumber: IDENTITY, ownApp: undefined }),
    ).resolves.toEqual({ delivering: true });
    expect(installUrl).not.toHaveBeenCalled();
  });

  /** Offering asks only that the donor browser points at an app, and an app installed
   *  and never opened has a record with no endpoint. Reported on, the switch would say
   *  so while nothing could arrive. */
  it("offers the install where the app it claimed has no subscription", async () => {
    claim.mockResolvedValue(true);
    appStatus.mockResolvedValue({
      kind: "app",
      app: app({ subscribed: false }),
    });

    await expect(
      turnOnWithApp({ identityNumber: IDENTITY, ownApp: undefined }),
    ).resolves.toEqual({
      delivering: false,
      installUrl: "/ios-icp-alerts#first",
    });
  });

  it("offers the install where the claim could not be read back", async () => {
    claim.mockResolvedValue(true);
    appStatus.mockResolvedValue({ kind: "unanswered", reason: "offline" });

    await expect(
      turnOnWithApp({ identityNumber: IDENTITY, ownApp: undefined }),
    ).resolves.toMatchObject({ delivering: false });
  });

  it("offers the install where there is no app to claim", async () => {
    await expect(
      turnOnWithApp({ identityNumber: IDENTITY, ownApp: undefined }),
    ).resolves.toEqual({
      delivering: false,
      installUrl: "/ios-icp-alerts#first",
    });
    expect(appStatus).not.toHaveBeenCalled();
  });

  /** This browser already points at an app of its own, so there is nothing to claim
   *  and nothing to hand over to another identity here. */
  it("claims nothing where this browser points at an app already", async () => {
    await expect(
      turnOnWithApp({
        identityNumber: IDENTITY,
        ownApp: app({ subscribed: false }),
      }),
    ).resolves.toMatchObject({ delivering: false });
    expect(claim).not.toHaveBeenCalled();
  });

  /** The token is good for half an hour and a settings page sits open for longer. One
   *  signed at mount is refused at the end of the steps, with the app already added to
   *  the Home Screen. */
  it("signs a fresh token for every press", async () => {
    installUrl
      .mockResolvedValueOnce("/ios-icp-alerts#first")
      .mockResolvedValueOnce("/ios-icp-alerts#second");

    await turnOnWithApp({ identityNumber: IDENTITY, ownApp: undefined });
    await expect(
      turnOnWithApp({ identityNumber: IDENTITY, ownApp: undefined }),
    ).resolves.toEqual({
      delivering: false,
      installUrl: "/ios-icp-alerts#second",
    });
    expect(installUrl).toHaveBeenCalledTimes(2);
  });

  /** A browser with no key to sign with has nowhere to send the user, which the tab
   *  the press opened reads as a tab to close. */
  it("carries no install url where this browser cannot sign one", async () => {
    installUrl.mockResolvedValue(undefined);

    await expect(
      turnOnWithApp({ identityNumber: IDENTITY, ownApp: undefined }),
    ).resolves.toEqual({ delivering: false, installUrl: undefined });
  });
});
