import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openInstallTab } from "./installUrl";

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
