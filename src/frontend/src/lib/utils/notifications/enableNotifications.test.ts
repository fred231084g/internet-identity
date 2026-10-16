import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Mocked before the unit is imported: the device registration reaches for a browser,
// and what is under test is which steps run and in what order.
vi.mock("./subscribeDevice", () => ({
  ensureRegisteredDevice: vi.fn(() => Promise.resolve()),
}));
vi.mock("./pushSubscription", () => ({
  requestNotificationPermission: vi.fn(() => Promise.resolve("granted")),
}));
// Where notifications arrive is the platform's business, and each case says which of
// the two it is.
vi.mock("./notificationState", () => ({
  notificationsNeedInstallHere: vi.fn(() => false),
}));
vi.mock("./deviceApp", () => ({ claimDeviceApp: vi.fn() }));
vi.mock("$lib/utils/notifications/appStatus", () => ({
  browserAppStatus: vi.fn(),
}));
vi.mock("./browserActor", () => ({ browserKeyActor: vi.fn() }));
// This identity's word about this browser, which turning them on takes back. It lives
// in the browser's storage, and what is under test is which steps run.
vi.mock("./turnedOff", () => ({ clearNotificationsOff: vi.fn() }));
import type { ActorSubclass } from "@icp-sdk/core/agent";
import type {
  NotificationAppInfo,
  _SERVICE,
} from "$lib/generated/internet_identity_types";
import { disallowApp, turnOnNotifications } from "./enableNotifications";
import type { AppDeviceState, BrowserDeviceState } from "./notificationState";
import { ensureRegisteredDevice } from "./subscribeDevice";
import { requestNotificationPermission } from "./pushSubscription";
import {
  browserAppStatus,
  type BrowserAppStatus,
} from "$lib/utils/notifications/appStatus";
import { claimDeviceApp } from "./deviceApp";
import { browserKeyActor } from "./browserActor";
import { clearNotificationsOff } from "./turnedOff";
import { notificationsNeedInstallHere } from "./notificationState";

const register = vi.mocked(ensureRegisteredDevice);
const permission = vi.mocked(requestNotificationPermission);
const deliversInApp = vi.mocked(notificationsNeedInstallHere);
const appStatus = vi.mocked(browserAppStatus);
const claim = vi.mocked(claimDeviceApp);
const browserActor = vi.mocked(browserKeyActor);
const ORIGIN = "https://app.example";
const IDENTITY = BigInt(10_000);

/** An actor whose grant answers with `replies` in order, one per call. */
const actorAnswering = (...replies: { Ok: null }[]) => {
  const notification_grant_consent = vi.fn(() =>
    Promise.resolve(replies[notification_grant_consent.mock.calls.length - 1]),
  );
  return {
    actor: { notification_grant_consent } as unknown as ActorSubclass<_SERVICE>,
    grant: notification_grant_consent,
  };
};

const ok = { Ok: null } as const;

const state = (over: Partial<BrowserDeviceState> = {}): BrowserDeviceState => ({
  source: "browser",
  supported: true,
  permission: "default",
  subscribed: false,
  registered: false,
  ...over,
});

const appState = (over: Partial<AppDeviceState> = {}): AppDeviceState => ({
  source: "app",
  subscribed: true,
  enabled: true,
  ...over,
});

describe("withdrawing consent", () => {
  it("revokes for the app in one call", async () => {
    const revoke = vi.fn(() => Promise.resolve(ok));
    const actor = {
      notification_revoke_consent: revoke,
    } as unknown as ActorSubclass<_SERVICE>;

    await disallowApp({ identityNumber: IDENTITY, origin: ORIGIN, actor });

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith({
      anchor_number: IDENTITY,
      origin: ORIGIN,
    });
  });

  it("reports a refusal rather than swallowing it", async () => {
    const actor = {
      notification_revoke_consent: vi.fn(() =>
        Promise.resolve({ Err: { InternalCanisterError: "not enabled" } }),
      ),
    } as unknown as ActorSubclass<_SERVICE>;

    await expect(
      disallowApp({ identityNumber: IDENTITY, origin: ORIGIN, actor }),
    ).rejects.toThrow();
  });
});

describe("turnOnNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permission.mockResolvedValue("granted");
  });

  it("registers the device before recording consent", async () => {
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state(),
        consented: false,
      }),
    ).resolves.toEqual({ status: "enabled" });

    // A refusal at the browser prompt must leave no consent behind, so the
    // registration has to land first.
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(
      grant.mock.invocationCallOrder[0],
    );
    // Asking for them here takes back whatever the switch in settings said.
    expect(clearNotificationsOff).toHaveBeenCalledWith(IDENTITY);
    expect(grant).toHaveBeenCalledWith({
      anchor_number: IDENTITY,
      origin: ORIGIN,
    });
  });

  /** Subscribing drops the endpoint every other identity here is registered with, so
   *  a browser that already holds a registration must not run that step again. */
  it("skips the registration for a browser already registered", async () => {
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state({
          permission: "granted",
          subscribed: true,
          registered: true,
        }),
        consented: false,
      }),
    ).resolves.toEqual({ status: "enabled" });

    expect(permission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(grant).toHaveBeenCalledTimes(1);
  });

  /** The app was allowed on another device, so only this browser needs setting up. */
  it("skips the consent for an app already allowed", async () => {
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state(),
        consented: true,
      }),
    ).resolves.toEqual({ status: "enabled" });

    expect(register).toHaveBeenCalledTimes(1);
    expect(grant).not.toHaveBeenCalled();
  });

  it("asks for permission only where it is not already granted", async () => {
    const { actor } = actorAnswering(ok);

    await turnOnNotifications({
      identityNumber: IDENTITY,
      origin: ORIGIN,
      actor,
      device: state({ permission: "granted" }),
      consented: false,
    });

    expect(permission).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("records nothing when the prompt is denied", async () => {
    permission.mockResolvedValue("denied");
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state(),
        consented: false,
      }),
    ).resolves.toEqual({ status: "denied" });

    expect(register).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });

  it("reports a dismissed prompt apart from a denial", async () => {
    permission.mockResolvedValue("default");
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state(),
        consented: false,
      }),
    ).resolves.toEqual({ status: "dismissed" });

    expect(register).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });

  /** Where a Home Screen app delivers, the permission was given inside the app and the
   *  subscription is the app's: a prompt here would ask for one that decides nothing,
   *  and subscribing would register an endpoint iOS never delivers to. */
  it("asks this browser for nothing where the app delivers", async () => {
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: appState({ subscribed: false, enabled: false }),
        consented: false,
      }),
    ).resolves.toEqual({ status: "enabled" });

    expect(permission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it("reports a refused grant rather than swallowing it", async () => {
    const { actor } = actorAnswering({
      Err: { Disabled: null },
    } as unknown as { Ok: null });

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state({
          permission: "granted",
          subscribed: true,
          registered: true,
        }),
        consented: false,
      }),
    ).rejects.toThrow();
  });
});

/** An app this device has, as the canister reports it to this browser. */
const appInfo = (enabled: boolean): BrowserAppStatus => ({
  kind: "app",
  app: { subscribed: true, enabled } as unknown as NotificationAppInfo,
});

describe("turnOnNotifications where a Home Screen app delivers", () => {
  const setEnabled = vi.fn(() => Promise.resolve(ok));

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset, not clear: a queued one-shot answer outlives a clear and would answer the
    // next case here.
    appStatus.mockReset();
    deliversInApp.mockReturnValue(true);
    setEnabled.mockResolvedValue(ok);
    browserActor.mockResolvedValue({
      set_notification_app_enabled: setEnabled,
    } as unknown as ActorSubclass<_SERVICE>);
  });

  // The platform is read per call, so the browser's own cases keep their answer.
  afterEach(() => {
    deliversInApp.mockReturnValue(false);
  });

  /** The user turned this identity's half off in settings. The app still delivers for
   *  the identities that have it on, so allowing here is that flag and nothing else. */
  it("turns this identity's flag back on before reporting success", async () => {
    appStatus.mockResolvedValue(appInfo(false));
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state(),
        consented: false,
      }),
    ).resolves.toEqual({ status: "enabled" });

    expect(setEnabled).toHaveBeenCalledWith({
      anchor_number: IDENTITY,
      enabled: true,
    });
    expect(grant).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
  });

  it("writes nothing where the app already delivers for this identity", async () => {
    appStatus.mockResolvedValue(appInfo(true));
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state(),
        consented: true,
      }),
    ).resolves.toEqual({ status: "enabled" });

    expect(setEnabled).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });

  /** Nothing here can install an app, and a browser that cannot hold a subscription has
   *  no prompt to raise: the install steps are the whole answer. */
  it("asks for the install where no app can be claimed", async () => {
    appStatus.mockResolvedValue({ kind: "no-app" });
    claim.mockResolvedValue(false);
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state(),
        consented: false,
      }),
    ).resolves.toEqual({ status: "install-required" });

    expect(grant).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  /** The claim reaches the canister and its reply is lost on the way back. This browser
   *  points at the app, and the install steps would give the user a second icon for an
   *  app they already have. */
  it("reads the canister again after a claim that answered nothing", async () => {
    appStatus
      .mockResolvedValueOnce({ kind: "no-app" })
      .mockResolvedValueOnce(appInfo(true));
    claim.mockResolvedValue(false);
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state(),
        consented: false,
      }),
    ).resolves.toEqual({ status: "enabled" });

    expect(appStatus).toHaveBeenCalledTimes(2);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  /** A re-read that answers nothing says nothing about this device, so it is neither a
   *  yes nor a no any more than the first read was. */
  it("reports a re-read it could not make as neither yes nor no", async () => {
    appStatus
      .mockResolvedValueOnce({ kind: "no-app" })
      .mockResolvedValueOnce({ kind: "unanswered", reason: "offline" });
    claim.mockResolvedValue(false);
    const { actor } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state(),
        consented: false,
      }),
    ).resolves.toEqual({ status: "unanswered", reason: "offline" });
  });

  /** A query that could not be made is not a device without an app: answering it as one
   *  would send a user whose app is delivering through the install for a second icon. */
  it("reports an app it could not read as neither yes nor no", async () => {
    appStatus.mockResolvedValue({ kind: "unanswered", reason: "offline" });
    const { actor, grant } = actorAnswering(ok);

    await expect(
      turnOnNotifications({
        identityNumber: IDENTITY,
        origin: ORIGIN,
        actor,
        device: state(),
        consented: false,
      }),
    ).resolves.toEqual({ status: "unanswered", reason: "offline" });

    expect(claim).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });
});
