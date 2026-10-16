import { beforeEach, describe, expect, it, vi } from "vitest";

const readAppKey = vi.fn<() => Promise<unknown>>();
vi.mock("$lib/utils/notifications/notificationAppKey", () => ({
  readAppKey: () => readAppKey(),
}));

const { openable } = await import("$lib/utils/notifications/worker/openTarget");

const LINK = "https://app.example/chats/7?from=ii";

const APP_KEY = { kind: "key", record: { keyPair: {} } };

beforeEach(() => {
  vi.clearAllMocks();
  readAppKey.mockResolvedValue({ kind: "no-key" });
});

describe("what a tapped notification opens", () => {
  // A browser's window is a tab, already carrying the user's session.
  it("opens the link itself in a browser", async () => {
    expect(await openable(LINK)).toBe(LINK);
  });

  // The installed app opens a page of its own, because the scheme that hands a link to
  // Safari is honoured for a page's navigation and not for a worker's window.
  it("routes through the doorway in the installed app", async () => {
    readAppKey.mockResolvedValue(APP_KEY);

    expect(await openable(LINK)).toBe(
      `/ios-icp-alerts/open#${encodeURIComponent(LINK)}`,
    );
  });

  it("leaves anything that is not https alone", async () => {
    readAppKey.mockResolvedValue(APP_KEY);

    expect(await openable("http://app.example/x")).toBe("http://app.example/x");
  });

  // The two wrong answers do not cost the same. Opening the link directly in the app
  // strands the user in the in-app browser view, signed out, with nothing on screen to
  // get them out of it; the doorway costs a browser's user one tap and keeps the link.
  it("routes through the doorway where the key store cannot be read", async () => {
    readAppKey.mockResolvedValue({ kind: "unreadable", reason: "no storage" });

    expect(await openable(LINK)).toBe(
      `/ios-icp-alerts/open#${encodeURIComponent(LINK)}`,
    );
  });
});
