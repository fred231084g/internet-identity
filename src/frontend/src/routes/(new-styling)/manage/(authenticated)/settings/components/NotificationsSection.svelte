<script lang="ts">
  import BellIcon from "@lucide/svelte/icons/bell";
  import { invalidateAll } from "$app/navigation";
  import { t } from "$lib/stores/locale.store";
  import { Trans } from "$lib/components/locale";
  import Badge from "$lib/components/ui/Badge.svelte";
  import Toggle from "$lib/components/ui/Toggle.svelte";
  import { handleError } from "$lib/components/utils/error";
  import { toaster } from "$lib/components/utils/toaster";
  import { isCanisterError } from "$lib/utils/utils";
  import type { BrowserInfo } from "$lib/generated/internet_identity_types";
  import { authenticatedStore } from "$lib/stores/authentication.store";
  import { setAppEnabled } from "$lib/utils/notifications/appEnabled";
  import {
    forgetAlreadyInstalled,
    saidAlreadyInstalled,
  } from "$lib/utils/notifications/alreadyInstalled";
  import {
    notificationsNeedInstallHere,
    readBrowserPushState,
    readDeviceState,
  } from "$lib/utils/notifications/notificationState";
  import { failureMessage } from "$lib/utils/notifications/notificationDiagnostics";
  import { openPendingInstallTab } from "$lib/utils/notifications/installUrl";
  import { turnOnWithApp } from "./notificationsSwitch";
  import {
    turnOffInBrowser,
    turnOnInBrowser,
  } from "./browserNotificationsSwitch";

  const {
    identityNumber,
    browsers,
    browserId,
  }: {
    identityNumber: bigint;
    /** From `identity_info`, so this renders its real state on first paint. */
    browsers: BrowserInfo[];
    /** Which of them this browser is. The switch registers a subscription against this
     *  entry and signs the install link with its key, and settings cannot mint one,
     *  so the page keeps this section off until a sign-in has registered one. */
    browserId: number;
  } = $props();

  const titleId = $props.id();

  /** Where notifications arrive is a Home Screen app on iOS and this browser anywhere
   *  else, which changes what the switch reports and what turning it on does. */
  const needsApp = notificationsNeedInstallHere();

  /** Where the install lives, shown on this section where the browser refused the tab
   *  and the user has to follow it themselves. */
  let refusedInstallUrl = $state<string | undefined>(undefined);

  /** What this browser's own entry says about the app it points at. */
  const ownApp = $derived(
    browsers.find((browser) => browser.id === browserId)?.notification_app[0],
  );

  /** What the user told this browser about their own device, for a phone whose app this
   *  browser cannot see. Read here so the switch answers on first paint. */
  let saidInstalled = $state(false);
  $effect(() => {
    if (!needsApp) {
      return;
    }
    void saidAlreadyInstalled(identityNumber).then(
      (said) => {
        saidInstalled = said;
      },
      // The switch answers off, which is what it answered before this ran. Nothing here
      // can act on it, so the reason is logged rather than thrown into a render.
      (error: unknown) => console.error(error),
    );
  });

  /** What this browser holds for itself, which is what the switch reports where
   *  notifications arrive in the browser rather than in an app. */
  let browserDelivers = $state(false);
  $effect(() => {
    if (needsApp) {
      return;
    }
    void (async () => {
      const pushState = await readBrowserPushState();
      const state =
        pushState === undefined
          ? undefined
          : await readDeviceState(identityNumber, pushState);
      browserDelivers = state?.permission === "granted" && state.registered;
    })().catch((error: unknown) => {
      // The switch answers off, which is what it answered before this ran: the read
      // reaches the service worker and the canister, and neither failing is something
      // this render can put in front of the user.
      console.error(error);
    });
  });

  /**
   * What the canister says, which is what the switch shows until a press moves it.
   *
   * On this device's app, delivering means the app has registered and this identity has
   * it switched on. The app's subscription is shared with every other identity pointing
   * at it, so this identity's half of the answer is its own flag and nothing else.
   */
  const live = $derived(
    needsApp
      ? (ownApp?.subscribed === true && ownApp.enabled) || saidInstalled
      : browserDelivers,
  );
  let enabled = $derived(live);

  /** On because the user said this device already has the app, which is the one thing
   *  nothing here can see: the canister knows of no app for this browser. */
  const onTheirWord = $derived(
    needsApp && saidInstalled && ownApp?.subscribed !== true,
  );
  let busy = $state(false);

  /**
   * Takes away what brings notifications here.
   *
   * On this device's app that is this identity's flag on the app, never the app's
   * subscription: the subscription is the app's own and every other identity pointing at
   * it delivers through the same one. Anywhere else it is this browser's registration,
   * and this identity's word that it wants none, which is what keeps the reconcile on
   * the next boot from registering it again. The permission is left alone either way:
   * that is the browser's to give and the user's to take back in its settings.
   */
  const turnOff = async () => {
    if (needsApp) {
      if (ownApp !== undefined) {
        await setAppEnabled({ identityNumber, enabled: false });
      }
      // Their word that the device already had one goes too, so turning the switch back
      // on offers the install again, which is the way out of having said it by mistake.
      await forgetAlreadyInstalled(identityNumber);
      saidInstalled = false;
      return;
    }
    await turnOffInBrowser({
      identityNumber,
      browserId,
      actor: $authenticatedStore.actor,
    });
  };

  /**
   * On this device notifications arrive in a Home Screen app, and this page cannot
   * install one: it opens the page that explains how, in this click's own gesture, which
   * is the only time a browser allows it. An app another identity here already has is
   * pointed at instead, which needs no install at all. Anywhere else this browser
   * receives them, so it asks for the permission and registers.
   *
   * Answers whether notifications are on now. An install that has only been opened is
   * not: what the switch shows is what the canister says, and it says nothing yet.
   */
  const turnOn = async (): Promise<boolean> => {
    if (!needsApp) {
      switch (await turnOnInBrowser(identityNumber)) {
        case "delivering":
          return true;
        case "permission-refused":
          toaster.error({
            title: $t`Notifications are blocked`,
            description: $t`Allow them for this site in your browser settings, then turn this on again.`,
          });
          return false;
      }
    }

    // An app this browser already points at and that is delivering needs nothing but
    // this identity's say-so.
    if (ownApp?.subscribed === true) {
      await setAppEnabled({ identityNumber, enabled: true });
      return true;
    }
    // What is left is the one page that can tell an app that needs opening from a
    // device that needs one, which this page cannot. Its tab is opened before anything
    // is awaited, because a browser allows `window.open` only inside the press itself,
    // and pointed once there is a token to point it at, or closed where the claim made
    // it unnecessary.
    const tab = openPendingInstallTab();
    const outcome = await turnOnWithApp({ identityNumber, ownApp });
    if (outcome.delivering) {
      tab.point(undefined);
      return true;
    }
    tab.point(outcome.installUrl);
    // A tab the browser refused is not a failure: the link goes on the section, and the
    // user follows it themselves.
    refusedInstallUrl = tab.opened ? undefined : outcome.installUrl;
    return false;
  };

  const handleToggle = (event: Event) => {
    if (!(event.currentTarget instanceof HTMLInputElement) || busy) {
      return;
    }
    const wanted = event.currentTarget.checked;
    enabled = wanted;
    refusedInstallUrl = undefined;
    busy = true;
    void (async () => {
      try {
        if (!wanted) {
          await turnOff();
        }
        const outcome = wanted ? await turnOn() : false;
        if (!needsApp) {
          // What this browser delivers is what the press just did. The read that
          // answers on first paint runs once, so leaving it to that would roll a later
          // failure back to whatever was true when the page opened.
          browserDelivers = outcome;
        }
        enabled = outcome;
      } catch (error) {
        enabled = live;
        if (isCanisterError(error)) {
          handleError(error);
          return;
        }
        toaster.error({
          title: $t`Notifications unavailable`,
          description: failureMessage(error),
        });
      } finally {
        busy = false;
        void invalidateAll();
      }
    })();
  };
</script>

<section
  class="border-border-secondary bg-bg-secondary flex flex-row items-start gap-3 rounded-xl border p-4 sm:gap-4 sm:p-5"
>
  <span
    class="border-border-tertiary text-fg-secondary bg-bg-primary flex size-10 shrink-0 items-center justify-center rounded-lg border"
    aria-hidden="true"
  >
    <BellIcon class="size-5" />
  </span>

  <div class="flex min-w-0 flex-1 flex-col gap-1">
    <div
      class="flex min-h-[1.5rem] flex-row flex-wrap items-center gap-x-2 gap-y-1"
    >
      <h3 id={titleId} class="text-text-primary text-base font-semibold">
        {$t`Allow notifications`}
      </h3>
      {#if enabled}
        <Badge color="success" size="sm" dot>
          {$t`On for this device`}
        </Badge>
      {/if}
    </div>
    <p class="text-text-tertiary text-sm">
      {#if needsApp}
        <Trans>
          Get notified on this device when your apps need you. They arrive in
          the app on your Home Screen.
        </Trans>
      {:else}
        <Trans>Get notified in this browser when your apps need you.</Trans>
      {/if}
    </p>
    {#if onTheirWord}
      <p class="text-text-tertiary text-sm">
        <Trans>
          On because you said this device already has the app. Turn this off and
          on again if it does not.
        </Trans>
      </p>
    {/if}
    {#if refusedInstallUrl !== undefined}
      <a
        class="btn btn-secondary btn-sm mt-2 self-start"
        href={refusedInstallUrl}
        target="_blank"
        rel="noreferrer"
      >
        {$t`Set up notifications`}
      </a>
    {/if}
  </div>

  <div class="shrink-0">
    <Toggle
      checked={enabled}
      onchange={handleToggle}
      disabled={busy}
      aria-labelledby={titleId}
    />
  </div>
</section>
