<script lang="ts">
  import { onMount } from "svelte";
  import BellIcon from "@lucide/svelte/icons/bell";
  import BellOffIcon from "@lucide/svelte/icons/bell-off";
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import SmartphoneIcon from "@lucide/svelte/icons/smartphone";
  import SquarePlusIcon from "@lucide/svelte/icons/square-plus";
  import { t } from "$lib/stores/locale.store";
  import { Trans } from "$lib/components/locale";
  import FeaturedIcon from "$lib/components/ui/FeaturedIcon.svelte";
  import AuthPanel from "$lib/components/layout/AuthPanel.svelte";
  import { isStandalone } from "./standalone";
  import {
    decodeLinkToken,
    type FragmentLinkToken,
  } from "$lib/utils/notifications/linkToken";
  import { probeApp } from "$lib/utils/notifications/appStatus";
  import {
    afterAlreadyAdded,
    failed,
    insideTheApp,
    insideTheBrowser,
    type Screen,
    settleFromSettings,
    settleWithTheApp,
  } from "./screen";
  import { openInSafari } from "./openInSafari";
  import { watchForInstall, watchProbe } from "./watchInstall";
  import { NOTIFICATION_APP_NAME } from "./appName";
  import ReinstallSteps from "./ReinstallSteps.svelte";
  import SafariIosSteps from "./installSteps/SafariIosSteps.svelte";
  import IosAppSteps from "./blockedSteps/IosAppSteps.svelte";

  let screen = $state<Screen>({ kind: "working" });
  /** Read on mount, because this page is rendered at build time where there is no
   *  document to ask. */
  let host = $state("");

  /** The buttons every screen ends with, which sit as a column under whatever is above
   *  them. */
  const buttonGroup = "mt-7 flex flex-col gap-2.5";

  /** Leaves for the host in Safari, which is where signing in and turning notifications
   *  on happen. Every screen that cannot finish on its own offers it. */
  const openTheHost = () => openInSafari(`https://${host}`);

  /**
   * The identity this launch's fragment names, where it names one.
   *
   * The three callers all watch or wake this browser's entry, which is named by an
   * identity and by nothing else, so a fragment carrying no token and one that cannot be
   * read leave each of them with nothing to do. Which of the two it was decides a screen,
   * and that is settled in `screen.ts` before any of this runs.
   *
   * `null` rather than `undefined` so that a fourth arm is a compile error: a return type
   * carrying `undefined` lets an unhandled arm fall out of the switch as an identity this
   * page never names.
   */
  const fragmentIdentity = (fragment: FragmentLinkToken): bigint | null => {
    switch (fragment.kind) {
      case "no-token":
      case "unreadable":
        return null;
      case "token":
        return fragment.token.identityNumber;
    }
  };

  /** The whole of what a launch does, which is also the whole of what retrying it is. */
  const launch = async (): Promise<Screen> =>
    isStandalone()
      ? await insideTheApp(window.location.hash, Notification.permission, () =>
          // Keeps a reload from presenting a spent token. A token already spent on this
          // key links the same record again, so replaying it is harmless either way.
          history.replaceState(null, "", window.location.pathname),
        ).catch(failed)
      : await insideTheBrowser(window.location.hash).catch(failed);

  onMount(() => {
    void (async () => {
      host = window.location.host;
      screen = await launch();
    })();
  });

  /** Runs the launch again. Settling from where a failure left off would skip the link
   *  and the anchors the rest of it is settled against. */
  const retryLaunch = async () => {
    screen = { kind: "working" };
    screen = await launch();
  };

  /**
   * Raises the prompt, which only a gesture may do, and goes where the answer leads.
   *
   * All three answers mean something different. `granted` carries on; `denied` cannot be
   * undone from here and becomes the Settings steps; a prompt dismissed without an answer
   * leaves the permission at `default`, so it can be raised again and the user stays
   * where they are with the button still in front of them.
   */
  const askForPermission = async () => {
    const asking = screen;
    screen = { kind: "working" };
    let permission: NotificationPermission;
    try {
      permission = await Notification.requestPermission();
    } catch (error) {
      console.error(error);
      screen = asking;
      return;
    }
    screen = await settleWithTheApp(permission).catch(failed);
  };

  /** Picks up a permission the user changed in Settings, which is the only place a
   *  refusal can be lifted. One still refused leaves them on the steps. */
  const retryFromSettings = async () => {
    if (!isStandalone()) {
      // A tab has no app key, no app record and no push to offer, so settling against a
      // permission here would mint one and show the prompt in a document that cannot
      // deliver anything.
      await retryLaunch();
      return;
    }
    screen = { kind: "working" };
    screen = await settleFromSettings().catch(failed);
  };

  // Only while the steps are up, and only for the identity whose token brought the user
  // here: the tab says so once the app it is telling them to install has registered.
  $effect(() => {
    if (screen.kind !== "install") {
      return;
    }
    const identityNumber = fragmentIdentity(
      decodeLinkToken(window.location.hash),
    );
    if (identityNumber === null) {
      return;
    }
    const replacingApp = screen.replacingApp === true;
    return watchForInstall(
      identityNumber,
      () => {
        screen = { kind: "ready", inTheApp: false };
      },
      { replacingApp },
    );
  });

  /** Whether the app answered the probe, which is as close to "it is there" as anything
   *  gets. Until it does, the screen says the same thing without promising it. */
  let appAnswered = $state(false);

  /**
   * Telling the user about an app we cannot see is worth checking first.
   *
   * The canister wakes it and this watches what happens. Taken off this browser's queue
   * means the app is there; a record that disappears means the push service said the
   * endpoint is gone, which is what a deleted app leaves behind, and the steps are what
   * is owed instead. Neither within a few seconds leaves the screen as it is, with the
   * escape hatch under it.
   *
   * Both screens a tab can settle on need it. `ready` is the one a returning user whose
   * app is gone lands on, because the record it reads still says delivering until
   * something pushes to it, and without this there would be nothing on that screen to
   * get them out of it.
   */
  $effect(() => {
    const watchingForTheApp =
      screen.kind === "open-app" ||
      (screen.kind === "ready" && !screen.inTheApp);
    if (!watchingForTheApp) {
      return;
    }
    const identityNumber = fragmentIdentity(
      decodeLinkToken(window.location.hash),
    );
    if (identityNumber === null) {
      return;
    }
    // Both screens are reachable more than once in one visit, and what the last probe
    // found says nothing about the app at the moment one comes back.
    appAnswered = false;
    let cancelled = false;
    let stopWatching = () => {};
    void probeApp(identityNumber).then((outcome) => {
      // The probe is an update call and the user can leave this screen while it is in
      // flight, at which point the cleanup has already run and has nothing to stop.
      if (cancelled) {
        return;
      }
      switch (outcome.kind) {
        case "no-app":
          // There is no app to open, so this is the wrong screen rather than a probe
          // that went wrong, and the steps are what is owed.
          screen = { kind: "install" };
          return;
        case "not-sent":
          // Nothing left the canister, so there is nothing to watch for and nothing
          // said about the app. The screen stands, with its own way out under it.
          return;
        case "sent":
          stopWatching = watchProbe(identityNumber, {
            onAnswered: () => (appAnswered = true),
            onGone: () => (screen = { kind: "install" }),
          });
          return;
      }
    });
    return () => {
      cancelled = true;
      stopWatching();
    };
  });

  const alreadyAdded = async () => {
    screen = await afterAlreadyAdded(window.location.hash).catch(failed);
  };

  /**
   * Takes the user's word that the app is gone and offers the steps again.
   *
   * The probe is housekeeping rather than the signal: where the record still has an
   * endpoint, waking it is what gets the push service to report it dead and the record
   * cleared. What the watcher behind the steps waits for is the new app, which it reads
   * off the record being used again.
   */
  const startOver = () => {
    const identityNumber = fragmentIdentity(
      decodeLinkToken(window.location.hash),
    );
    if (identityNumber !== null) {
      void probeApp(identityNumber);
    }
    screen = { kind: "install", replacingApp: true };
  };

  /** `window.close()` closes only a tab a script opened, and this one arrives from a
   *  link as often as not, so the screen says what the close could not. */
  const dismiss = () => {
    window.close();
    screen = { kind: "closed" };
  };
</script>

<svelte:head>
  <title>{NOTIFICATION_APP_NAME}</title>
  <link rel="manifest" href="/ios-icp-alerts.webmanifest" />
  <!-- iOS takes the Home Screen icon from here, not from the manifest, so without it the
       tile is a screenshot of the page. 180px is what it asks for. -->
  <link
    rel="apple-touch-icon"
    sizes="180x180"
    href="/ios-icp-alerts-icon-180.png"
  />
  <!-- iOS honours these as well as the manifest: the standalone launch, the Home Screen
       name and the status bar are read from them. -->
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content={NOTIFICATION_APP_NAME} />
  <meta name="apple-mobile-web-app-status-bar-style" content="black" />
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div
  class="grid w-full flex-1 items-center max-sm:items-stretch sm:w-100 sm:max-w-100"
>
  <div class="relative col-start-1 row-start-1 flex min-w-0 flex-col gap-5">
    <AuthPanel class="z-1">
      {#if screen.kind === "working"}
        <div class="flex flex-col items-stretch">
          <div class="skeleton mb-4 h-12 w-12 rounded-lg"></div>
          <div class="skeleton mb-3 h-8 w-3/4 rounded"></div>
          <div class="skeleton h-6 w-full rounded"></div>
        </div>
      {:else if screen.kind === "install"}
        <div class="flex min-w-0 flex-1 flex-col items-stretch justify-end">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <SquarePlusIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          {#if screen.replacingApp === true}
            <h1 class="text-text-primary mb-3 text-2xl font-medium">
              <Trans>Add {NOTIFICATION_APP_NAME} again</Trans>
            </h1>
            <p class="text-text-tertiary mb-5 text-base">
              <Trans>
                Follow these steps to put a new one on your Home Screen:
              </Trans>
            </p>
          {:else}
            <h1 class="text-text-primary mb-3 text-2xl font-medium">
              <Trans>Set up {NOTIFICATION_APP_NAME}</Trans>
            </h1>
            <p class="text-text-tertiary mb-5 text-base">
              <Trans>Follow these steps to get notifications:</Trans>
            </p>
          {/if}
          <SafariIosSteps {host} />

          <div class={buttonGroup}>
            <!-- Not for a user who has just told us the app is gone: taking their word
                 again would record an app nothing can reach and end the tab on a screen
                 saying there is nothing left to do. -->
            {#if screen.replacingApp !== true}
              <button
                class="btn btn-primary btn-xl"
                onclick={() => void alreadyAdded()}
              >
                {$t`I've already added it`}
              </button>
            {/if}
            <button class="btn btn-tertiary btn-xl" onclick={dismiss}>
              {$t`Not now`}
            </button>
          </div>
        </div>
      {:else if screen.kind === "open-app"}
        <div class="flex min-w-0 flex-1 flex-col items-stretch justify-end">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <SmartphoneIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          <h1 class="text-text-primary mb-3 text-2xl font-medium">
            <Trans>Open {NOTIFICATION_APP_NAME}</Trans>
          </h1>
          <p class="text-text-tertiary mb-5 text-base">
            {#if appAnswered}
              <Trans>
                It's on your Home Screen and working. Open it once and
                notifications are on for this identity.
              </Trans>
            {:else}
              <Trans>
                It's on your Home Screen. Open it once and notifications are on
                for this identity.
              </Trans>
            {/if}
          </p>
          <div class={buttonGroup}>
            <button class="btn btn-tertiary btn-xl" onclick={startOver}>
              {$t`I don't have the app any more`}
            </button>
          </div>
        </div>
      {:else if screen.kind === "ask"}
        <div class="flex min-w-0 flex-1 flex-col items-stretch justify-end">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <BellIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          <h1 class="text-text-primary mb-3 text-2xl font-medium">
            {$t`Let your apps notify you`}
          </h1>
          <p class="text-text-tertiary mb-5 text-base">
            <Trans>
              Payments, votes and messages from the apps you use, right on this
              device.
            </Trans>
          </p>
          <div class={buttonGroup}>
            <button
              class="btn btn-primary btn-xl"
              onclick={() => void askForPermission()}
            >
              {$t`Allow notifications`}
            </button>
          </div>
          <p class="text-text-tertiary mt-5 text-sm">
            <Trans>Only apps you allow on {host} can notify you.</Trans>
          </p>
        </div>
      {:else if screen.kind === "blocked"}
        <div class="flex min-w-0 flex-1 flex-col items-stretch justify-end">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <BellOffIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          <h1 class="text-text-primary mb-3 text-2xl font-medium">
            {$t`Notifications are blocked`}
          </h1>
          <p class="text-text-tertiary mb-5 text-base">
            <Trans>Follow these steps to turn them back on:</Trans>
          </p>
          <IosAppSteps appName={NOTIFICATION_APP_NAME} />
          <div class={buttonGroup}>
            <button
              class="btn btn-primary btn-xl"
              onclick={() => void retryFromSettings()}
            >
              {$t`Try again`}
            </button>
          </div>
        </div>
      {:else if screen.kind === "ready"}
        <div class="flex min-w-0 flex-1 flex-col items-stretch justify-end">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <BellIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          <h1 class="text-text-primary mb-3 text-2xl font-medium">
            {$t`You're all set`}
          </h1>
          <p class="text-text-tertiary text-base">
            <Trans>
              Notifications from your apps will show up on this device.
            </Trans>
          </p>
          <!-- The probe behind this screen clears a record whose app is gone, and every
               record that reaches here has an endpoint for it to reach. What it cannot
               do is answer for a browser that is signed out or past the window the
               canister still wakes it in: nothing is sent at all then, and the user
               stays the only party who can see their own Home Screen. Not redundant
               with the probe, and not here in the app, where it would be asking about
               something the user is looking at. -->
          {#if !screen.inTheApp}
            <div class={buttonGroup}>
              <button class="btn btn-tertiary btn-xl" onclick={startOver}>
                {$t`I don't have the app any more`}
              </button>
            </div>
          {/if}
        </div>
      {:else if screen.kind === "unlinked"}
        <div class="flex min-w-0 flex-1 flex-col items-stretch justify-end">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <SmartphoneIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          <h1 class="text-text-primary mb-3 text-2xl font-medium">
            {$t`Set up notifications`}
          </h1>
          <p class="text-text-tertiary mb-5 text-base">
            <Trans>
              Open {host}, sign in, and turn notifications on. It will show you
              how to add the app.
            </Trans>
          </p>
          <div class={buttonGroup}>
            <button class="btn btn-primary btn-xl" onclick={openTheHost}>
              <Trans>Open {host}</Trans>
            </button>
          </div>
        </div>
      {:else if screen.kind === "stale-link"}
        <div class="flex min-w-0 flex-1 flex-col items-stretch justify-end">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <CircleAlertIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          <h1 class="text-text-primary mb-3 text-2xl font-medium">
            {$t`This link didn't work`}
          </h1>
          <p class="text-text-tertiary mb-5 text-base">
            <Trans>
              Keep this app. Open {host}, sign in, and turn notifications on
              again to finish setting it up.
            </Trans>
          </p>
          <div class={buttonGroup}>
            <button class="btn btn-primary btn-xl" onclick={openTheHost}>
              <Trans>Open {host}</Trans>
            </button>
          </div>
        </div>
      {:else if screen.kind === "unusable-key"}
        <div class="flex min-w-0 flex-1 flex-col items-stretch justify-end">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <CircleAlertIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          <h1 class="text-text-primary mb-3 text-2xl font-medium">
            {$t`Add this app again`}
          </h1>
          <p class="text-text-tertiary mb-5 text-base">
            <Trans>
              This app can't be connected to your identity. Adding it again
              gives it what it needs:
            </Trans>
          </p>
          <ReinstallSteps {host} />
          <div class={buttonGroup}>
            <button class="btn btn-primary btn-xl" onclick={openTheHost}>
              <Trans>Open {host}</Trans>
            </button>
          </div>
        </div>
      {:else if screen.kind === "closed"}
        <div class="flex min-w-0 flex-col items-stretch">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <SmartphoneIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          <h1 class="text-text-primary mb-3 text-2xl font-medium">
            {$t`You can close this tab`}
          </h1>
          <p class="text-text-tertiary text-base">
            <Trans
              >Open {host} whenever you want to turn notifications on.</Trans
            >
          </p>
        </div>
      {:else if screen.kind === "orphaned"}
        <div class="flex min-w-0 flex-1 flex-col items-stretch justify-end">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <SmartphoneIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          <h1 class="text-text-primary mb-3 text-2xl font-medium">
            {$t`This app isn't connected`}
          </h1>
          <p class="text-text-tertiary mb-5 text-base">
            <Trans>
              Nothing can arrive here until it's set up again. Follow these
              steps:
            </Trans>
          </p>
          <ReinstallSteps {host} />
          <div class={buttonGroup}>
            <button class="btn btn-primary btn-xl" onclick={openTheHost}>
              <Trans>Open {host}</Trans>
            </button>
          </div>
        </div>
      {:else}
        <div class="flex min-w-0 flex-col items-stretch">
          <FeaturedIcon size="lg" class="mb-4 self-start">
            <CircleAlertIcon class="size-6" aria-hidden="true" />
          </FeaturedIcon>
          <h1 class="text-text-primary mb-3 text-2xl font-medium">
            {$t`Something went wrong`}
          </h1>
          <p class="text-text-tertiary mb-2 text-base">
            <Trans>
              Notifications couldn't be set up on this device. Try again, and if
              it keeps failing, set this up again from {host}.
            </Trans>
          </p>
          <p class="text-text-tertiary text-sm">{screen.reason}</p>
          <div class={buttonGroup}>
            <button
              class="btn btn-primary btn-xl"
              onclick={() => void retryLaunch()}
            >
              {$t`Try again`}
            </button>
            <button class="btn btn-tertiary btn-xl" onclick={openTheHost}>
              <Trans>Open {host}</Trans>
            </button>
          </div>
        </div>
      {/if}
    </AuthPanel>
  </div>
</div>
