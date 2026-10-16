import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type App = {
  subscribed: boolean;
  enabled: boolean;
  last_seen_ns: bigint;
  pending_probe: [] | [bigint];
};

type Status =
  | { kind: "app"; app: App }
  | { kind: "no-app" }
  | { kind: "unanswered"; reason: string };

const browserAppStatus = vi.fn<() => Promise<Status>>();

vi.mock("$lib/utils/notifications/appStatus", () => ({
  browserAppStatus: () => browserAppStatus(),
}));

const { watchForInstall, watchProbe } = await import("./watchInstall");

const reporting = (app: Partial<App>): Status => ({
  kind: "app",
  app: {
    subscribed: true,
    enabled: true,
    last_seen_ns: BigInt(100),
    pending_probe: [],
    ...app,
  },
});

const delivering = reporting({});
const noApp: Status = { kind: "no-app" };
const unanswered: Status = { kind: "unanswered", reason: "network" };

const IDENTITY = BigInt(10_000);

/** Long enough to carry any number of polls, which are three seconds apart. */
const A_WHILE_MS = 30_000;

beforeEach(() => {
  vi.useFakeTimers();
  browserAppStatus.mockResolvedValue(noApp);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchForInstall", () => {
  it("says so once the app delivers", async () => {
    const onDelivering = vi.fn();
    browserAppStatus.mockResolvedValue(delivering);

    watchForInstall(IDENTITY, onDelivering);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(onDelivering).toHaveBeenCalledOnce();
  });

  /// Pointing at the app is not delivering through it: the record exists from the app's
  /// first open, and the permission may still be unanswered.
  it("keeps asking while the app is linked but not registered", async () => {
    const onDelivering = vi.fn();
    browserAppStatus.mockResolvedValue(reporting({ subscribed: false }));

    watchForInstall(IDENTITY, onDelivering);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(browserAppStatus.mock.calls.length).toBeGreaterThan(1);
    expect(onDelivering).not.toHaveBeenCalled();
  });

  it("asks nothing more once it is stopped", async () => {
    const onDelivering = vi.fn();

    const stop = watchForInstall(IDENTITY, onDelivering);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);
    const asked = browserAppStatus.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(browserAppStatus).toHaveBeenCalledTimes(asked);
  });

  /// The answer can arrive after the caller has moved on, and what the callback does to
  /// the screen cannot be undone.
  it("does not call back for an answer that arrives after it stopped", async () => {
    const onDelivering = vi.fn();
    let answer = (_status: Status) => undefined as void;
    browserAppStatus.mockImplementation(
      () =>
        new Promise<Status>((resolve) => {
          answer = resolve;
        }),
    );

    const stop = watchForInstall(IDENTITY, onDelivering);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);
    stop();
    answer(delivering);
    await vi.advanceTimersByTimeAsync(0);

    expect(onDelivering).not.toHaveBeenCalled();
  });

  /// A reference the identity turned off is skipped when the canister picks who to
  /// deliver to, so the app it points at would never be heard from.
  it("keeps asking while the app is subscribed but turned off", async () => {
    const onDelivering = vi.fn();
    browserAppStatus.mockResolvedValue(reporting({ enabled: false }));

    watchForInstall(IDENTITY, onDelivering);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(onDelivering).not.toHaveBeenCalled();
  });

  /// The record of an app the user deleted stays subscribed and enabled, so it answers
  /// for the app they have just been asked to add.
  it("does not take the record of a replaced app for the new one", async () => {
    const onDelivering = vi.fn();
    browserAppStatus.mockResolvedValue(delivering);

    watchForInstall(IDENTITY, onDelivering, { replacingApp: true });
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(onDelivering).not.toHaveBeenCalled();
  });

  it("says so once a replaced app is gone and a new one delivers", async () => {
    const onDelivering = vi.fn();
    browserAppStatus.mockResolvedValue(noApp);

    watchForInstall(IDENTITY, onDelivering, { replacingApp: true });
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);
    browserAppStatus.mockResolvedValue(delivering);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(onDelivering).toHaveBeenCalledOnce();
  });

  /// A record with no endpoint registered has nothing to push to, so nothing can ever
  /// bounce it away. Waiting for it to disappear would leave the user on the steps for
  /// good, including after they have added an app that works.
  it("says so once the replaced record is used again, without it going away", async () => {
    const onDelivering = vi.fn();
    browserAppStatus.mockResolvedValue(
      reporting({ last_seen_ns: BigInt(100) }),
    );

    watchForInstall(IDENTITY, onDelivering, { replacingApp: true });
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);
    expect(onDelivering).not.toHaveBeenCalled();

    browserAppStatus.mockResolvedValue(
      reporting({ last_seen_ns: BigInt(101) }),
    );
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(onDelivering).toHaveBeenCalledOnce();
  });

  /// Being heard from is not the same as being able to deliver: the new app calls when
  /// it is opened, and the permission may still be unanswered at that point.
  it("keeps asking for a replaced app heard from but not registered", async () => {
    const onDelivering = vi.fn();
    browserAppStatus.mockResolvedValue(
      reporting({ last_seen_ns: BigInt(100) }),
    );

    watchForInstall(IDENTITY, onDelivering, { replacingApp: true });
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);
    browserAppStatus.mockResolvedValue(
      reporting({ last_seen_ns: BigInt(101), subscribed: false }),
    );
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(onDelivering).not.toHaveBeenCalled();
  });

  /// A query that could not be made is not the record going away, and reading it as one
  /// would let a flaky network stand in for the app the user deleted.
  it("does not take an unanswered query for the replaced app going away", async () => {
    const onDelivering = vi.fn();
    browserAppStatus.mockResolvedValue(unanswered);

    watchForInstall(IDENTITY, onDelivering, { replacingApp: true });
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);
    browserAppStatus.mockResolvedValue(delivering);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(onDelivering).not.toHaveBeenCalled();
  });
});

describe("watchProbe", () => {
  const waiting = reporting({ pending_probe: [BigInt(1)] });

  const callbacks = () => ({ onAnswered: vi.fn(), onGone: vi.fn() });

  it("says the app answered once this browser's queue is empty", async () => {
    const handlers = callbacks();
    browserAppStatus.mockResolvedValue(delivering);

    watchProbe(IDENTITY, handlers);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(handlers.onAnswered).toHaveBeenCalledOnce();
    expect(handlers.onGone).not.toHaveBeenCalled();
  });

  /// `pending_probe` names the oldest thing queued for this browser rather than the
  /// probe that was just sent, so something else waiting is no evidence either way.
  it("keeps asking while anything is still queued", async () => {
    const handlers = callbacks();
    browserAppStatus.mockResolvedValue(waiting);

    watchProbe(IDENTITY, handlers);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(browserAppStatus.mock.calls.length).toBeGreaterThan(1);
    expect(handlers.onAnswered).not.toHaveBeenCalled();
  });

  /// The push service reporting the endpoint dead takes the record with it, which is
  /// what an app the user deleted leaves behind.
  it("says the app is gone once its record is", async () => {
    const handlers = callbacks();
    browserAppStatus.mockResolvedValue(noApp);

    watchProbe(IDENTITY, handlers);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(handlers.onGone).toHaveBeenCalledOnce();
    expect(handlers.onAnswered).not.toHaveBeenCalled();
  });

  it("asks nothing more once it is stopped", async () => {
    const handlers = callbacks();
    browserAppStatus.mockResolvedValue(waiting);

    const stop = watchProbe(IDENTITY, handlers);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);
    const asked = browserAppStatus.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(browserAppStatus).toHaveBeenCalledTimes(asked);
  });

  /// The answer can arrive after the caller has moved on, and what the callbacks do to
  /// the screen cannot be undone.
  it("does not call back for an answer that arrives after it stopped", async () => {
    const handlers = callbacks();
    let answer = (_status: Status) => undefined as void;
    browserAppStatus.mockImplementation(
      () =>
        new Promise<Status>((resolve) => {
          answer = resolve;
        }),
    );

    const stop = watchProbe(IDENTITY, handlers);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);
    stop();
    answer(delivering);
    await vi.advanceTimersByTimeAsync(0);

    expect(handlers.onAnswered).not.toHaveBeenCalled();
  });

  /// Telling a user to reinstall an app that is working is the worse of the two wrong
  /// answers, and a query that never happened supports neither.
  it("concludes nothing from an unanswered query", async () => {
    const handlers = callbacks();
    browserAppStatus.mockResolvedValue(unanswered);

    watchProbe(IDENTITY, handlers);
    await vi.advanceTimersByTimeAsync(A_WHILE_MS);

    expect(browserAppStatus.mock.calls.length).toBeGreaterThan(1);
    expect(handlers.onGone).not.toHaveBeenCalled();
    expect(handlers.onAnswered).not.toHaveBeenCalled();
  });
});
