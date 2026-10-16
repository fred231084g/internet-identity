import { beforeEach, describe, expect, it, vi } from "vitest";

const probe_notification_app = vi.fn();
const get_notification_app_status = vi.fn();

class UnregisteredBrowserError extends Error {}

const browserKeyActor = vi.fn<() => Promise<unknown>>();

vi.mock("$lib/utils/notifications/browserActor", () => ({
  browserKeyActor: () => browserKeyActor(),
  UnregisteredBrowserError,
}));

const { browserAppStatus, probeApp } = await import("./appStatus");

const IDENTITY = BigInt(10_000);

beforeEach(() => {
  vi.clearAllMocks();
  browserKeyActor.mockResolvedValue({
    probe_notification_app,
    get_notification_app_status,
  });
  get_notification_app_status.mockResolvedValue([]);
});

/** What the canister holds for a browser that points at an app. */
const APP = {
  subscribed: true,
  enabled: true,
  last_seen_ns: BigInt(100),
  pending_probe: [],
};

/**
 * The read the install page settles every browser-tab launch against. Three answers and
 * not two: a query that could not be made is not an entry that points at nothing, and a
 * caller that took the one for the other would walk a user whose app is working through
 * adding a second one.
 */
describe("browserAppStatus", () => {
  it("carries back the entry the canister holds", async () => {
    get_notification_app_status.mockResolvedValue([APP]);

    await expect(browserAppStatus(IDENTITY)).resolves.toEqual({
      kind: "app",
      app: APP,
    });
  });

  it("says this browser points at no app where the canister holds none", async () => {
    await expect(browserAppStatus(IDENTITY)).resolves.toEqual({
      kind: "no-app",
    });
  });

  /// A browser the canister never registered has no key to ask with, so there is nothing
  /// for this identity on this device and nothing a later attempt would find either.
  it("says there is no app for a browser that was never registered", async () => {
    browserKeyActor.mockRejectedValue(new UnregisteredBrowserError());

    await expect(browserAppStatus(IDENTITY)).resolves.toEqual({
      kind: "no-app",
    });
  });

  /// Read as "no app", a flaky network stands in for an app the user deleted.
  it("keeps a query that could not be made apart from having no app", async () => {
    get_notification_app_status.mockRejectedValue(new Error("no consensus"));
    const reported = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(browserAppStatus(IDENTITY)).resolves.toEqual({
      kind: "unanswered",
      reason: "no consensus",
    });
    expect(reported).toHaveBeenCalledOnce();
  });
});

/**
 * The canister answers a probe with one of two errors that mean opposite things to the
 * screen, so what matters here is that they stay apart all the way to the caller.
 */
describe("probeApp", () => {
  it("carries back the id of a probe that was sent", async () => {
    probe_notification_app.mockResolvedValue({ Ok: BigInt(7) });

    await expect(probeApp(IDENTITY)).resolves.toEqual({
      kind: "sent",
      probeId: BigInt(7),
    });
  });

  /// This browser points at nothing, so the screen telling the user to open an app is
  /// the wrong screen rather than a probe that went wrong.
  it("says there is no app where the canister says so", async () => {
    probe_notification_app.mockResolvedValue({
      Err: { NoNotificationApp: null },
    });

    await expect(probeApp(IDENTITY)).resolves.toEqual({ kind: "no-app" });
  });

  /// A browser the canister never registered has no key to ask with, which is an answer
  /// and not a failure: no later attempt would find anything either.
  it("says there is no app for a browser that was never registered", async () => {
    browserKeyActor.mockRejectedValue(new UnregisteredBrowserError());

    await expect(probeApp(IDENTITY)).resolves.toEqual({ kind: "no-app" });
  });

  /// Nothing left the canister, so there is nothing to watch for and nothing said about
  /// the app. Reading this as "no app" would send a user whose app is fine to the steps.
  it("keeps a probe that was not sent apart from having no app", async () => {
    probe_notification_app.mockResolvedValue({ Err: { NotReachable: null } });

    await expect(probeApp(IDENTITY)).resolves.toEqual({
      kind: "not-sent",
      reason: "NotReachable",
    });
  });

  it("reports a call that failed as nothing sent", async () => {
    probe_notification_app.mockRejectedValue(new Error("no consensus"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(probeApp(IDENTITY)).resolves.toEqual({
      kind: "not-sent",
      reason: "no consensus",
    });
  });
});
