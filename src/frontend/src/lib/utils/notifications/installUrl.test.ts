import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The key this browser signs a token with, which is the one thing a browser no sign-in
// has registered does not have.
vi.mock("$lib/stores/browser-key.store", () => ({
  signNotificationAppLink: vi.fn(),
}));

import { signNotificationAppLink } from "$lib/stores/browser-key.store";
import {
  openInstallTab,
  openPendingInstallTab,
  signedInstallUrl,
} from "./installUrl";

const IDENTITY = BigInt(10_000);
const sign = vi.mocked(signNotificationAppLink);

/** The tab `window.open` hands back, with the two things this unit does to one. */
const tab = () => ({ close: vi.fn(), location: { href: "" } });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Lets the `then` the unit attached run before the assertions. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("openInstallTab", () => {
  it("points the tab it opened at a URL that arrives late", async () => {
    const opened = tab();
    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);

    expect(openInstallTab(Promise.resolve("/ios-icp-alerts#token"))).toBe(true);
    await settled();

    expect(opened.location.href).toBe("/ios-icp-alerts#token");
    expect(opened.close).not.toHaveBeenCalled();
  });

  it("closes the tab where there is no URL to send it to", async () => {
    const opened = tab();
    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);

    openInstallTab(Promise.resolve(undefined));
    await settled();

    expect(opened.close).toHaveBeenCalledOnce();
  });

  /**
   * Signing reaches storage and WebCrypto, either of which can refuse. The caller has
   * a boolean and nothing to await, so a rejection with nothing listening leaves a
   * blank tab open for as long as the user keeps it and says nothing about why.
   */
  it("closes the tab and reports the reason where the URL never arrives", async () => {
    const opened = tab();
    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);
    const refused = new Error("storage is closed");

    openInstallTab(Promise.reject(refused));
    await settled();

    expect(opened.close).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(refused);
  });

  /** A blocked pop-up is answered by showing the link, so the caller has to be able to
   *  tell that apart from a tab that opened. */
  it("reports a tab the browser refused to open", () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    expect(openInstallTab(Promise.resolve("/ios-icp-alerts#token"))).toBe(
      false,
    );
  });
});

describe("signedInstallUrl", () => {
  beforeEach(() => {
    sign.mockReset();
  });

  it("points at the app's own path, with the token in the fragment", async () => {
    sign.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const url = await signedInstallUrl(IDENTITY);

    expect(url).toMatch(/^\/ios-icp-alerts#/);
    expect(url).toContain("anchor=10000");
  });

  /** A browser no sign-in has registered has no key to sign with, which is nowhere to
   *  send the user rather than a failure to report. */
  it("has nowhere to send a browser with no key", async () => {
    sign.mockResolvedValue(undefined);

    await expect(signedInstallUrl(IDENTITY)).resolves.toBeUndefined();
  });

  /** A key store that cannot be read reads the same way on screen as a browser with no
   *  key at all, and a rejection would strand the blank tab the press opened. */
  it("reports the reason and sends them nowhere where the key store is shut", async () => {
    const reason = new Error("the key store is shut");
    sign.mockRejectedValue(reason);

    await expect(signedInstallUrl(IDENTITY)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(reason);
  });
});

describe("openPendingInstallTab", () => {
  it("opens the tab before it has anywhere to point it", () => {
    const opened = tab();
    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);

    expect(openPendingInstallTab().opened).toBe(true);
    expect(opened.location.href).toBe("");
  });

  it("points the tab where the press says, once it knows", async () => {
    const opened = tab();
    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);

    openPendingInstallTab().point("/ios-icp-alerts#token");
    await settled();

    expect(opened.location.href).toBe("/ios-icp-alerts#token");
  });

  it("closes the tab where the press had nothing to point it at", async () => {
    const opened = tab();
    vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);

    openPendingInstallTab().point(undefined);
    await settled();

    expect(opened.close).toHaveBeenCalledOnce();
  });

  /** A blocked pop-up is answered by showing the link on the screen behind it, so the
   *  press has to hear about it before it knows where the install lives. */
  it("reports a refused tab to the press that opened it", () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    expect(openPendingInstallTab().opened).toBe(false);
  });
});
