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
const appAnchors = vi.fn<() => Promise<bigint[]>>();
const registerForAnyAnchor = vi.fn<(anchors: bigint[]) => Promise<boolean>>();
const setNotificationAppEnabled =
  vi.fn<
    (request: { anchor_number: bigint; enabled: boolean }) => Promise<unknown>
  >();
const linkWithToken =
  vi.fn<() => Promise<{ status: string; reason?: string }>>();
type Fragment =
  | { kind: "token"; token: { identityNumber: bigint } }
  | { kind: "no-token" }
  | { kind: "unreadable"; reason: string };

const decodeLinkToken = vi.fn<() => Fragment>();
const recordAlreadyInstalled = vi.fn<(n: bigint) => Promise<void>>();

vi.mock("$lib/utils/notifications/appStatus", () => ({
  browserAppStatus: () => browserAppStatus(),
  appAnchors: () => appAnchors(),
}));
vi.mock("$lib/utils/notifications/linkToken", () => ({
  decodeLinkToken: () => decodeLinkToken(),
}));
vi.mock("$lib/utils/notifications/notificationAppKey", () => ({
  ensureAppKey: () => Promise.resolve({ keyPair: {} }),
}));
vi.mock("$lib/utils/notifications/alreadyInstalled", () => ({
  recordAlreadyInstalled: (identityNumber: bigint) =>
    recordAlreadyInstalled(identityNumber),
}));
vi.mock("$lib/utils/notifications/subscribeDevice", () => ({
  registerForAnyAnchor: (anchors: bigint[]) => registerForAnyAnchor(anchors),
}));
vi.mock("$lib/utils/notifications/browserActor", () => ({
  browserKeyActor: () =>
    Promise.resolve({
      set_notification_app_enabled: setNotificationAppEnabled,
    }),
}));
vi.mock("./appKeyActor", () => ({
  appKeyActor: () => Promise.resolve({}),
}));
vi.mock("./link", () => ({
  linkWithToken: () => linkWithToken(),
}));

const {
  afterAlreadyAdded,
  insideTheApp,
  insideTheBrowser,
  settleFromSettings,
} = await import("./screen");

const IDENTITY = BigInt(10_000);
const HASH = "#token";

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

/** Nothing in these tests clears the URL, so the callback records rather than acts. */
const spent = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  decodeLinkToken.mockReturnValue({
    kind: "token",
    token: { identityNumber: IDENTITY },
  });
  browserAppStatus.mockResolvedValue({ kind: "no-app" });
  appAnchors.mockResolvedValue([IDENTITY]);
  linkWithToken.mockResolvedValue({ status: "linked" });
  registerForAnyAnchor.mockResolvedValue(true);
  setNotificationAppEnabled.mockResolvedValue({ Ok: null });
  recordAlreadyInstalled.mockResolvedValue(undefined);
});

/** What the app document holds, which is where `Notification.permission` is defined. */
const permissionIs = (permission: NotificationPermission): void => {
  vi.stubGlobal("Notification", { permission });
};

/** A browser that can take a subscription but cannot be asked what it holds, which is
 *  the one thing a reader of the push state has no value to answer with. */
const pushStateUnreadable = (): void => {
  vi.stubGlobal("PushManager", class {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: () => Promise.reject(new Error("storage is closed")),
    },
  });
};

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("what a browser tab shows", () => {
  /// The steps end in an app that nothing can link, so the user would add an icon and
  /// then be told to delete it again.
  it("sends a tab with no link token back to where tokens are handed out", async () => {
    decodeLinkToken.mockReturnValue({ kind: "no-token" });

    await expect(insideTheBrowser(HASH)).resolves.toEqual({
      kind: "unlinked",
    });
  });

  /**
   * A damaged install link is not a tab that arrived without one: there is an identity
   * on the other end of it and the host is where a fresh link comes from. Nothing names
   * an identity to ask the canister about, so nothing is asked.
   */
  it("sends a tab whose link cannot be read back to the host", async () => {
    decodeLinkToken.mockReturnValue({
      kind: "unreadable",
      reason: "the token is missing a field",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(insideTheBrowser(HASH)).resolves.toEqual({
      kind: "unlinked",
    });
    expect(browserAppStatus).not.toHaveBeenCalled();
  });

  it("offers the install where this browser points at no app", async () => {
    await expect(insideTheBrowser(HASH)).resolves.toEqual({ kind: "install" });
  });

  /// Three canister-visible states, three screens. Being told to go and open an app that
  /// is already delivering is being told to do something that is already done.
  it("says there is nothing left to do where the app delivers", async () => {
    browserAppStatus.mockResolvedValue(reporting({}));

    await expect(insideTheBrowser(HASH)).resolves.toEqual({
      kind: "ready",
      inTheApp: false,
    });
  });

  /**
   * A user whose app is gone reads as delivering here, because the record says so until
   * something pushes to it, and this is the screen they land on. Saying which document
   * it is is what lets that screen carry a way out: without it the tab is terminal, and
   * the one case the whole install flow exists to serve has nowhere to go.
   */
  it("says the delivering screen is a tab, so it can carry the way out", async () => {
    browserAppStatus.mockResolvedValue(reporting({}));

    const screen = await insideTheBrowser(HASH);

    expect(screen).toHaveProperty("inTheApp", false);
  });

  it("points at the app where it is there but not subscribed", async () => {
    browserAppStatus.mockResolvedValue(reporting({ subscribed: false }));

    await expect(insideTheBrowser(HASH)).resolves.toEqual({ kind: "open-app" });
  });

  /**
   * The token the user arrived with is minted by pressing turn notifications on, so
   * the flag is what they came to flip, and nothing else on this page can flip it: a
   * replayed link does not re-enable, registering does not touch the flag, and the
   * probe answers not-reachable while it is off. Leaving it would send them round the
   * open-app screen and back to the steps for a second icon.
   */
  it("turns the app back on where this identity has it switched off", async () => {
    browserAppStatus.mockResolvedValue(reporting({ enabled: false }));

    await expect(insideTheBrowser(HASH)).resolves.toEqual({
      kind: "ready",
      inTheApp: false,
    });
    expect(setNotificationAppEnabled).toHaveBeenCalledWith({
      anchor_number: IDENTITY,
      enabled: true,
    });
  });

  /// The flag is already where the user wants it, and the call is an update: making it
  /// anyway buys a round trip and a write for nothing.
  it("leaves an app that is already on alone", async () => {
    browserAppStatus.mockResolvedValue(reporting({}));

    await insideTheBrowser(HASH);

    expect(setNotificationAppEnabled).not.toHaveBeenCalled();
  });

  /**
   * The write is the one thing on this path that is not a read, and nothing else in the
   * launch reads what it writes. An app that is there and switched off is what the
   * open-app screen says, so a failure here leaves the user on the screen that fits
   * rather than on one offering to run the whole launch again.
   */
  it("leaves the user at the app where turning it back on failed", async () => {
    browserAppStatus.mockResolvedValue(reporting({ enabled: false }));
    setNotificationAppEnabled.mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(insideTheBrowser(HASH)).resolves.toEqual({
      kind: "open-app",
    });
  });

  /// Switching the reference on says nothing about the app having registered for push,
  /// which is the other half of delivering and the one the user's finger answers.
  it("points at an app switched back on that has never registered", async () => {
    browserAppStatus.mockResolvedValue(
      reporting({ enabled: false, subscribed: false }),
    );

    await expect(insideTheBrowser(HASH)).resolves.toEqual({ kind: "open-app" });
    expect(setNotificationAppEnabled).toHaveBeenCalledOnce();
  });

  /// A query that never happened is no reason to walk someone who already has the app
  /// through adding a second one.
  it("does not offer the install on a query that could not be made", async () => {
    browserAppStatus.mockResolvedValue({
      kind: "unanswered",
      reason: "offline",
    });

    await expect(insideTheBrowser(HASH)).resolves.toEqual({
      kind: "failed",
      reason: "offline",
    });
  });
});

describe("what the installed app shows", () => {
  /**
   * The one that matters most. iOS captures the URL at install, fragment and all, and
   * replays it at every launch; the token inside it is good for half an hour. So from
   * half an hour after the install, every single launch presents an expired token, and
   * a launch that stopped there would never reach the registering that keeps this app's
   * push endpoint current.
   */
  it("carries on through a token the canister has stopped accepting", async () => {
    linkWithToken.mockResolvedValue({
      status: "token-refused",
      reason: "LinkTokenExpired",
    });

    await expect(insideTheApp(HASH, "granted", spent)).resolves.toEqual({
      kind: "ready",
      inTheApp: true,
    });
    expect(registerForAnyAnchor).toHaveBeenCalledOnce();
  });

  /// The app is the document the user is looking at, so offering to tell us it is gone
  /// would be asking about something in front of them.
  it("says the delivering screen is the app, which carries no way out", async () => {
    const screen = await insideTheApp(HASH, "granted", spent);

    expect(screen).toHaveProperty("inTheApp", true);
  });

  /// A refused token with nothing linked is a fresh token away from working, so telling
  /// the user to delete the app and add it back would be asking for the wrong thing.
  it("asks for a fresh token where the refused one left nothing linked", async () => {
    linkWithToken.mockResolvedValue({
      status: "token-refused",
      reason: "LinkTokenExpired",
    });
    appAnchors.mockResolvedValue([]);

    await expect(insideTheApp(HASH, "granted", spent)).resolves.toEqual({
      kind: "stale-link",
    });
  });

  /**
   * A key the canister will not link is not a token the user can replace: this app mints
   * one key for the storage partition it lives in and has no way to mint another, so the
   * steps for a fresh app are what is owed rather than a fresh token or a retry.
   */
  it("asks for a fresh app where the canister refused this app's key", async () => {
    linkWithToken.mockResolvedValue({
      status: "key-refused",
      reason: "KeyAlreadyInUse",
    });

    await expect(insideTheApp(HASH, "granted", spent)).resolves.toEqual({
      kind: "unusable-key",
    });
    expect(registerForAnyAnchor).not.toHaveBeenCalled();
  });

  /**
   * The Home Screen entry replays the URL it was added with at every launch, so a
   * fragment that cannot be read is replayed for as long as the app exists. Stopping
   * there would end every launch of an app that is already delivering, including the
   * registering that keeps its push endpoint current.
   */
  it("carries on through a link it cannot read", async () => {
    decodeLinkToken.mockReturnValue({
      kind: "unreadable",
      reason: "the signature is 32 bytes, not 64",
    });

    await expect(insideTheApp(HASH, "granted", spent)).resolves.toEqual({
      kind: "ready",
      inTheApp: true,
    });
    expect(registerForAnyAnchor).toHaveBeenCalledOnce();
  });

  /**
   * An app with nothing linked and a link it cannot read is one install short of
   * working, and a browser is waiting at the other end of that link. Telling the user to
   * delete the app, which is what a launch carrying no token at all is owed, would be
   * asking for the wrong thing.
   */
  it("asks for a fresh link where the unreadable one left nothing linked", async () => {
    decodeLinkToken.mockReturnValue({
      kind: "unreadable",
      reason: "the token is missing a field",
    });
    appAnchors.mockResolvedValue([]);

    await expect(insideTheApp(HASH, "granted", spent)).resolves.toEqual({
      kind: "stale-link",
    });
  });

  /// Nothing to register for and nothing to ask a permission for: what is registered is
  /// signed as the app and named for an anchor it serves.
  it("says the app is connected to nothing where it serves no identity", async () => {
    decodeLinkToken.mockReturnValue({ kind: "no-token" });
    appAnchors.mockResolvedValue([]);

    await expect(insideTheApp(HASH, "granted", spent)).resolves.toEqual({
      kind: "orphaned",
    });
  });

  /// Reaching the canister at all is the one failure a launch cannot carry on through.
  it("stops where the link call itself failed", async () => {
    linkWithToken.mockResolvedValue({ status: "failed", reason: "offline" });

    await expect(insideTheApp(HASH, "granted", spent)).resolves.toEqual({
      kind: "failed",
      reason: "offline",
    });
  });

  it("drops a token the canister took, so a reload does not present it again", async () => {
    await insideTheApp(HASH, "granted", spent);

    expect(spent).toHaveBeenCalledOnce();
  });

  it("leaves a refused token where it is", async () => {
    linkWithToken.mockResolvedValue({
      status: "token-refused",
      reason: "LinkTokenExpired",
    });

    await insideTheApp(HASH, "granted", spent);

    expect(spent).not.toHaveBeenCalled();
  });

  it("asks for the permission where it has not been answered", async () => {
    await expect(insideTheApp(HASH, "default", spent)).resolves.toEqual({
      kind: "ask",
    });
  });

  it("shows the unblock steps where the permission was refused", async () => {
    await expect(insideTheApp(HASH, "denied", spent)).resolves.toEqual({
      kind: "blocked",
    });
  });

  /// An orphaned app has no anchor to name, and registering names one: settling against
  /// an empty list would call the canister with nothing and fail every retry.
  it("registers nothing where the app serves no identity", async () => {
    appAnchors.mockResolvedValue([]);

    await insideTheApp(HASH, "granted", spent);

    expect(registerForAnyAnchor).not.toHaveBeenCalled();
  });

  /// The push service hands out a new endpoint whenever it likes, and opening the app is
  /// the only moment anything can write the new one.
  it("registers on an ordinary launch that links nothing", async () => {
    decodeLinkToken.mockReturnValue({ kind: "no-token" });

    await expect(insideTheApp(HASH, "granted", spent)).resolves.toEqual({
      kind: "ready",
      inTheApp: true,
    });
    expect(registerForAnyAnchor).toHaveBeenCalledOnce();
  });

  /**
   * The list is what the app serves, not what reaches it: an identity that switched
   * this app off and one whose browser holds no session are both in it and both refuse
   * the call. Offering the canister one of them and stopping there would let a single
   * dead reference end every launch of an app that is working for the others.
   */
  it("offers the canister every identity the app serves", async () => {
    const other = BigInt(20_000);
    appAnchors.mockResolvedValue([IDENTITY, other]);

    await insideTheApp(HASH, "granted", spent);

    expect(registerForAnyAnchor).toHaveBeenCalledWith([IDENTITY, other]);
  });

  /**
   * The record says delivering while nothing is delivered: an identity in the list is
   * not an identity that accepted, so being told it is all set would leave the user
   * with a screen that is wrong and no way off it.
   */
  it("sends the user to the host where no identity accepted the registration", async () => {
    registerForAnyAnchor.mockResolvedValue(false);

    await expect(insideTheApp(HASH, "granted", spent)).resolves.toEqual({
      kind: "unlinked",
    });
  });
});

describe("coming back from iOS Settings", () => {
  it("carries on where the permission has been granted", async () => {
    permissionIs("granted");

    await expect(settleFromSettings()).resolves.toEqual({
      kind: "ready",
      inTheApp: true,
    });
  });

  /**
   * The unblock steps are what a refusal is owed and nothing else. Settings is the one
   * place a refusal can be lifted, so a user arriving here has often just lifted it,
   * and a browser that cannot say what it is subscribed with has said nothing about
   * the permission.
   */
  it("carries on where the permission is granted and the push state is unreadable", async () => {
    permissionIs("granted");
    pushStateUnreadable();

    await expect(settleFromSettings()).resolves.toEqual({
      kind: "ready",
      inTheApp: true,
    });
  });

  it("shows the unblock steps where the permission is still refused", async () => {
    permissionIs("denied");

    await expect(settleFromSettings()).resolves.toEqual({ kind: "blocked" });
  });
});

describe("saying the app is already there", () => {
  /// So this browser stops offering an install for an app the user can see and it
  /// cannot: the answer is kept per identity, in the browser that would keep asking.
  it("records the answer against the identity the token names", async () => {
    await afterAlreadyAdded(HASH);

    expect(recordAlreadyInstalled).toHaveBeenCalledWith(IDENTITY);
  });

  /**
   * Nothing in this browser can reach the app being described: the canister records
   * which browser points at one, so the second browser on a phone finds nothing however
   * often it looks. A screen that goes looking answers no-app and lands the user back
   * on the steps for a second icon, which is the one thing this button exists to avoid.
   */
  it("ends the tab rather than promising a link it cannot make", async () => {
    await expect(afterAlreadyAdded(HASH)).resolves.toEqual({ kind: "closed" });
  });

  /// Nothing names an identity to record it against, and the screen is the same: what
  /// the user was told is about a device, not about a link.
  it.each([
    { kind: "no-token" } as const,
    { kind: "unreadable", reason: "the token is missing a field" } as const,
  ])(
    "ends the tab where $kind leaves nothing to record against",
    async (fragment) => {
      decodeLinkToken.mockReturnValue(fragment);

      await expect(afterAlreadyAdded(HASH)).resolves.toEqual({
        kind: "closed",
      });
      expect(recordAlreadyInstalled).not.toHaveBeenCalled();
    },
  );
});
