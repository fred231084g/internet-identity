import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignIdentity } from "@icp-sdk/core/agent";

const registeredIdentityNumbers = vi.fn<() => Promise<bigint[]>>();
const browserKeyIdentity =
  vi.fn<(identityNumber: bigint) => Promise<SignIdentity | undefined>>();
type StoredAppKey =
  | { kind: "key"; record: { keyPair: CryptoKeyPair } }
  | { kind: "no-key" }
  | { kind: "unreadable"; reason: string };

const readAppKey = vi.fn<() => Promise<StoredAppKey>>();
const fromKeyPair = vi.fn((keyPair: CryptoKeyPair) =>
  Promise.resolve({ keyPair } as unknown as SignIdentity),
);

vi.mock("$lib/stores/browser-key.store", () => ({
  registeredIdentityNumbers: () => registeredIdentityNumbers(),
  browserKeyIdentity: (identityNumber: bigint) =>
    browserKeyIdentity(identityNumber),
}));
vi.mock("$lib/utils/notifications/notificationAppKey", () => ({
  readAppKey: () => readAppKey(),
}));
vi.mock("$lib/utils/notifications/workerConfig", () => ({
  config: {
    canisterId: "rdmx6-jaaaa-aaaaa-aaadq-cai",
    agentOptions: { host: "http://127.0.0.1:4943" },
  },
}));
const anchorsAnswer = vi.fn<() => Promise<bigint[]>>(() => Promise.resolve([]));
vi.mock("$lib/utils/notifications/notificationAppActor", () => ({
  appKeyActorWith: () =>
    Promise.resolve({ notification_app_anchors: () => anchorsAnswer() }),
}));
vi.mock("@icp-sdk/core/identity", () => ({
  ECDSAKeyIdentity: { fromKeyPair: (pair: CryptoKeyPair) => fromKeyPair(pair) },
}));

const { signingIdentities } =
  await import("$lib/utils/notifications/signingIdentities");

const APP_KEY_PAIR = { app: true } as unknown as CryptoKeyPair;
const BROWSER = BigInt(10_000);
const APP = BigInt(10_001);
/** An identity whose own browser claimed this app, so only the canister names it. */
const CLAIMED = BigInt(10_002);

const holdingTheAppKey: StoredAppKey = {
  kind: "key",
  record: { keyPair: APP_KEY_PAIR },
};

const signsAs = (identityNumber: bigint): SignIdentity =>
  ({ identityNumber }) as unknown as SignIdentity;

beforeEach(() => {
  vi.clearAllMocks();
  registeredIdentityNumbers.mockResolvedValue([]);
  readAppKey.mockResolvedValue({ kind: "no-key" });
  browserKeyIdentity.mockImplementation((identityNumber) =>
    Promise.resolve(signsAs(identityNumber)),
  );
});

describe("signingIdentities", () => {
  it("answers one entry per identity signed in to this browser", async () => {
    registeredIdentityNumbers.mockResolvedValue([BROWSER, APP]);

    expect(await signingIdentities()).toEqual([
      { identityNumber: BROWSER, identity: signsAs(BROWSER) },
      { identityNumber: APP, identity: signsAs(APP) },
    ]);
  });

  // The whole of the iOS path: the Home Screen app has its own storage partition, so the
  // browser key store there is empty and the identities pointing at the app are the only
  // thing the worker can ask the canister as.
  it("answers the identities pointing at the app where nothing has signed in", async () => {
    readAppKey.mockResolvedValue(holdingTheAppKey);
    anchorsAnswer.mockResolvedValueOnce([APP]);

    expect(await signingIdentities()).toEqual([
      { identityNumber: APP, identity: { keyPair: APP_KEY_PAIR } },
    ]);
    expect(fromKeyPair).toHaveBeenCalledWith(APP_KEY_PAIR);
  });

  // A second identity's browser points it at this app without the app running, so the
  // canister is the only party that can name it.
  it("answers every identity the canister says points at the app", async () => {
    readAppKey.mockResolvedValue(holdingTheAppKey);
    anchorsAnswer.mockResolvedValueOnce([APP, CLAIMED]);

    expect(await signingIdentities()).toEqual([
      { identityNumber: APP, identity: { keyPair: APP_KEY_PAIR } },
      {
        identityNumber: CLAIMED,
        identity: { keyPair: APP_KEY_PAIR },
      },
    ]);
  });

  it("answers both where a browser has signed in and an app is pointed at", async () => {
    registeredIdentityNumbers.mockResolvedValue([BROWSER]);
    readAppKey.mockResolvedValue(holdingTheAppKey);
    anchorsAnswer.mockResolvedValueOnce([APP]);

    expect(await signingIdentities()).toHaveLength(2);
  });

  // A key the canister has no record for names no anchor, and every call needs one.
  it("leaves out an app key nothing points at", async () => {
    readAppKey.mockResolvedValue(holdingTheAppKey);

    expect(await signingIdentities()).toEqual([]);
  });

  // A browser that has not completed a sign-in holds a key the canister cannot place.
  it("leaves out an identity whose key is not registered", async () => {
    registeredIdentityNumbers.mockResolvedValue([BROWSER]);
    browserKeyIdentity.mockResolvedValue(undefined);

    expect(await signingIdentities()).toEqual([]);
  });

  // Who points at this app is the canister's to say, so a wake-up that cannot reach it
  // has nothing to sign for rather than a guess. Signing for nobody is the same outcome
  // as an app nothing points at, so the reason has to be said somewhere.
  it("reports anchors that could not be read, rather than answering nothing quietly", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    readAppKey.mockResolvedValue(holdingTheAppKey);
    anchorsAnswer.mockRejectedValueOnce(new Error("offline"));

    expect(await signingIdentities()).toEqual([]);
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0][0])).toContain("offline");
  });

  it("answers what it can where one source throws", async () => {
    registeredIdentityNumbers.mockRejectedValue(new Error("no storage"));
    readAppKey.mockResolvedValue(holdingTheAppKey);
    anchorsAnswer.mockResolvedValueOnce([APP]);

    expect(await signingIdentities()).toHaveLength(1);
  });

  // Signing for nobody would leave the user with the browser's own "updated in the
  // background" notice in place of what arrived, so the store that would not open is
  // reported rather than answered as an app that is not there.
  it("reports a key store that would not open", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    readAppKey.mockResolvedValue({ kind: "unreadable", reason: "no storage" });

    await signingIdentities();

    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0][0])).toContain("no storage");
  });

  // The two key stores are separate, so one refusing to open says nothing about the
  // other and the entries that did answer are still worth having.
  it("still answers the browser entries where the app key cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    registeredIdentityNumbers.mockResolvedValue([BROWSER]);
    readAppKey.mockResolvedValue({ kind: "unreadable", reason: "no storage" });

    expect(await signingIdentities()).toEqual([
      { identityNumber: BROWSER, identity: signsAs(BROWSER) },
    ]);
  });
});
