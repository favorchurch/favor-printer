/**
 * The tray menu. `buildMenuTemplate` is a pure function of the snapshot, so the
 * menu is tested as data. It shows counts and states only: never a name, a
 * label's content or a security code.
 */

import type { AppSnapshot, StatusColor, UpdateChannel } from "../../shared";

export type MenuItemTemplate = {
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "radio";
  enabled?: boolean;
  checked?: boolean;
  click?: () => void;
  submenu?: MenuItemTemplate[];
};

export type TrayActions = {
  pause(): void;
  resume(): void;
  testPrint(): void;
  openSetup(): void;
  reenroll(): void;
  /** Opens the setup window at the offer to move off the old relay. The confirmation is asked there. */
  migrateLegacy(): void;
  setOpenAtLogin(enabled: boolean): void;
  checkForUpdates(): void;
  setChannel(channel: UpdateChannel): void;
  quit(): void;
};

const separator: MenuItemTemplate = { type: "separator" };
const info = (label: string): MenuItemTemplate => ({ label, enabled: false });

export function jobCountsLabel(jobs: AppSnapshot["recentJobs"]): string {
  const parts = [`${jobs.sent} sent`, `${jobs.failed} failed`];
  if (jobs.ambiguous > 0) parts.push(`${jobs.ambiguous} to check`);
  return `Labels this session: ${parts.join(", ")}`;
}

export function updateItem(snapshot: AppSnapshot, actions: TrayActions): MenuItemTemplate {
  switch (snapshot.update.kind) {
    case "checking":
      return info("Checking for updates...");
    case "downloading":
      return info("Downloading an update...");
    case "ready":
      return info(
        snapshot.update.version
          ? `Update ${snapshot.update.version} ready. It installs when you quit.`
          : "An update is ready. It installs when you quit.",
      );
    case "error":
      return { label: "Update check failed. Try again", click: actions.checkForUpdates };
    case "idle":
      return { label: "Check for updates", click: actions.checkForUpdates };
  }
}

export function buildMenuTemplate(snapshot: AppSnapshot, actions: TrayActions): MenuItemTemplate[] {
  const revoked = snapshot.status.color === "red";
  const canPrint = snapshot.enrolled && !revoked && !snapshot.legacyRelayLoaded;

  const items: MenuItemTemplate[] = [info(snapshot.status.headline)];
  if (snapshot.status.detail) items.push(info(snapshot.status.detail));
  if (snapshot.label) items.push(info(`This laptop: ${snapshot.label}`));
  items.push(separator, info(jobCountsLabel(snapshot.recentJobs)), separator);

  if (snapshot.legacyRelayLoaded) {
    items.push({ label: "Move to Favor Printer...", click: actions.migrateLegacy });
  } else if (revoked) {
    items.push({ label: "Enter a new code...", click: actions.reenroll });
  } else if (!snapshot.enrolled || snapshot.setupStep !== null) {
    items.push({ label: snapshot.enrolled ? "Finish setup..." : "Set up Favor Printer...", click: actions.openSetup });
  }

  items.push(
    snapshot.paused
      ? { label: "Resume printing", enabled: canPrint, click: actions.resume }
      : { label: "Pause printing", enabled: canPrint, click: actions.pause },
    { label: "Test print...", enabled: canPrint, click: actions.testPrint },
    { label: "Keep printing", submenu: snapshot.warnings.map(info) },
    separator,
    {
      label: "Open at login",
      type: "checkbox",
      checked: snapshot.openAtLogin,
      click: () => actions.setOpenAtLogin(!snapshot.openAtLogin),
    },
    updateItem(snapshot, actions),
    {
      label: "Update channel",
      submenu: (["stable", "preview"] as const).map((channel) => ({
        label: channel === "stable" ? "Stable" : "Preview",
        type: "radio" as const,
        checked: snapshot.channel === channel,
        click: () => actions.setChannel(channel),
      })),
    },
    separator,
    info(`Favor Printer ${snapshot.version}`),
    { label: "Quit Favor Printer", click: actions.quit },
  );
  return items;
}

export function trayTooltip(snapshot: AppSnapshot): string {
  return `Favor Printer: ${snapshot.status.headline}`;
}

export type TrayLike<Image> = {
  setImage(image: Image): void;
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
};

/** Keeps the tray's icon, tooltip and menu in step with the snapshot. */
export function createTrayView<Image>(deps: {
  tray: TrayLike<Image>;
  icons: Record<StatusColor, Image>;
  buildMenu(template: MenuItemTemplate[]): unknown;
  actions: TrayActions;
}): { render(snapshot: AppSnapshot): void } {
  let lastKey = "";
  return {
    render(snapshot) {
      const template = buildMenuTemplate(snapshot, deps.actions);
      // Rebuilding the menu while it is open closes it, so skip identical renders.
      const key = JSON.stringify([snapshot.status.color, trayTooltip(snapshot), template]);
      if (key === lastKey) return;
      lastKey = key;
      deps.tray.setImage(deps.icons[snapshot.status.color]);
      deps.tray.setToolTip(trayTooltip(snapshot));
      deps.tray.setContextMenu(deps.buildMenu(template));
    },
  };
}
