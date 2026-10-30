/**
 * One function per screen, each returning the page's `<main>`. Screens hold no
 * state: they read the snapshot and local state they are given and call the
 * actions. Nothing here shows ZPL or a security code.
 */

import { isEnrollmentCode, RENAME_MAX_LENGTH, type AppSnapshot, type PrinterDevice } from "../shared";
import { h } from "./dom";
import {
  boundPrinterText,
  cleanCodeInput,
  codeErrorCopy,
  ENROLL_ERROR_COPY,
  LOCAL_TEST_COPY,
  RENAME_ERROR_COPY,
  stepLabel,
  TEST_PRINT_ERROR_COPY,
  type LocalState,
  type RenameTarget,
  type ScreenId,
} from "./model";

export type Actions = {
  advance(): void;
  scanAgain(): void;
  selectPrinter(deviceId: string): void;
  setUpPrinter(): void;
  openPrinterSettings(): void;
  submitCode(code: string): void;
  requestTestPrint(): void;
  answerLabel(cameOut: boolean): void;
  /** "Move to Favor Printer": asks for confirmation, changes nothing yet. */
  askMigrateLegacy(): void;
  cancelMigrateLegacy(): void;
  /** Confirmed: turns the old relay off. */
  migrateLegacy(): void;
  /** Saves the typed name. The screen reads the input itself: it is not kept in local state. */
  renameLaptop(name: string): void;
  renamePrinter(name: string): void;
  closeWindow(): void;
};

export const LEGACY_FAILED_COPY = "The old relay could not be turned off. Printing stays off. Ask an admin for help.";

export type ScreenContext = { snapshot: AppSnapshot; local: LocalState; actions: Actions };

const button = (label: string, onclick: () => void, options: { primary?: boolean; disabled?: boolean } = {}) =>
  h("button", { type: "button", class: options.primary ? "button primary" : "button", disabled: options.disabled, onclick }, label);

const frame = (screen: ScreenId, snapshot: AppSnapshot, title: string, ...body: (Node | string | null | false)[]) =>
  h(
    "main",
    { class: "screen", "data-screen": screen },
    h(
      "header",
      { class: "header" },
      stepLabel(snapshot.setupStep) ? h("p", { class: "step" }, stepLabel(snapshot.setupStep) ?? "") : null,
      h("h1", { tabIndex: -1, id: "title" }, title),
    ),
    ...body,
  );

const lead = (text: string) => h("p", { class: "lead" }, text);
const actions = (...children: Node[]) => h("div", { class: "actions" }, ...children);
const note = (text: string, kind: "error" | "info" = "info") =>
  h("p", { class: `note ${kind}`, role: kind === "error" ? "alert" : "status" }, text);

const statusPill = (snapshot: AppSnapshot) =>
  h(
    "p",
    { class: `pill ${snapshot.status.color}` },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("span", null, snapshot.status.headline),
  );

const printerLine = (snapshot: AppSnapshot) => {
  const text = boundPrinterText(snapshot);
  return text ? h("p", { class: "hint", id: "bound-printer" }, `Printer: ${text}`) : null;
};

function lastSeenTime(snapshot: AppSnapshot): string | null {
  const lastSeenAt = snapshot.printerPresence?.lastSeenAt;
  if (snapshot.fiveState !== "Unplugged" || !lastSeenAt) return null;
  const date = new Date(lastSeenAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** One name to edit in RSVP. The typed text stays in the input, so a re-render does not drop it. */
function renameForm(
  id: string,
  label: string,
  current: string | null,
  local: LocalState,
  target: RenameTarget,
  onSave: (name: string) => void,
) {
  const failed = local.renameError?.target === target ? local.renameError : null;
  const input = h("input", {
    id,
    class: "text-input",
    type: "text",
    maxlength: RENAME_MAX_LENGTH,
    value: failed ? failed.name : (current ?? ""),
    "aria-describedby": failed ? `${id}-error` : undefined,
    "aria-invalid": failed ? "true" : "false",
    spellcheck: "false",
  });
  return h(
    "form",
    {
      class: "rename-form",
      onsubmit: (event: SubmitEvent) => {
        event.preventDefault();
        if (!local.busy) onSave(input.value);
      },
    },
    h("label", { for: id, class: "field-label" }, label),
    h("div", { class: "rename-row" }, input, h("button", { type: "submit", class: "button", disabled: local.busy }, "Save")),
    failed ? h("p", { id: `${id}-error`, class: "note error", role: "alert" }, RENAME_ERROR_COPY[failed.reason]) : null,
  );
}

function deviceRow(device: PrinterDevice, selected: boolean, onSelect: () => void) {
  return h(
    "li",
    null,
    h(
      "label",
      { class: selected ? "choice selected" : "choice" },
      h("input", { type: "radio", name: "printer", value: device.id, checked: selected, onchange: onSelect }),
      h("span", { class: "choice-title" }, device.model || "Zebra printer"),
      device.usbSerial ? h("span", { class: "choice-detail" }, `Serial ${device.usbSerial}`) : null,
    ),
  );
}

export function updateStatusText(update: AppSnapshot["update"]): string {
  switch (update.kind) {
    case "idle":
      return "Up to date";
    case "checking":
      return "Checking for updates...";
    case "downloading":
      return "Downloading update...";
    case "ready":
      return "Update ready. Restart to apply.";
    case "error":
      return "Update check failed.";
  }
}

export function channelLabel(channel: AppSnapshot["channel"]): string {
  return channel === "preview" ? "Preview" : "Stable";
}

export function renderScreen(screen: ScreenId, { snapshot, local, actions: a }: ScreenContext): HTMLElement {
  switch (screen) {
    case "welcome":
      return frame(
        screen,
        snapshot,
        "Set up Favor Printer",
        lead("This app lets your Zebra label printer print check-in labels from Favor RSVP. Setup takes about two minutes."),
        h("ol", { class: "plain" }, h("li", null, "Pick your printer"), h("li", null, "Enter the code from an admin"), h("li", null, "Print a test label")),
        actions(button("Get started", a.advance, { primary: true })),
      );

    case "legacy":
      return frame(
        screen,
        snapshot,
        "Replace the old print relay",
        lead("An older print relay is still running on this Mac. If both ran, they could claim the same labels, so Favor Printer stays off until the old one is turned off."),
        h("p", { class: "hint" }, "Nothing is deleted, and no password or code is copied from the old relay."),
        local.migrateError ? note(LEGACY_FAILED_COPY, "error") : null,
        actions(button(local.migrateError ? "Try again" : "Move to Favor Printer", a.askMigrateLegacy, { primary: true, disabled: local.busy })),
      );

    case "legacy-confirm":
      return frame(
        screen,
        snapshot,
        "Turn off the old print relay?",
        lead("Favor Printer will stop the old relay now and keep it from starting when you log in. Labels printed by the old relay stop until you finish setting up here."),
        h("p", { class: "hint" }, "Favor Printer checks that the old relay is gone before it starts printing."),
        actions(
          button(local.busy ? "Turning it off..." : "Turn off old relay", a.migrateLegacy, { primary: true, disabled: local.busy }),
          button("Cancel", a.cancelMigrateLegacy, { disabled: local.busy }),
        ),
      );

    case "printer-none":
      return frame(
        screen,
        snapshot,
        "Plug in your Zebra printer",
        lead(snapshot.platform === "win32"
          ? "Install the official Zebra ZDesigner ZPL driver first, connect the USB Zebra directly to this Windows PC, then choose Look again. Favor Printer will only enroll a printer whose unique hardware USB serial Windows can verify. If the printer is installed but missing here, ask IT to confirm its driver and USB serial."
          : "Use a USB data cable, not a charge-only cable. Plug the printer straight into this Mac and turn it on. If it is not found, unplug it and plug it back in once."),
        local.codeError === "printer_not_found" ? h("p", { class: "note error", role: "alert" }, ENROLL_ERROR_COPY.printer_not_found) : null,
        actions(button("Look again", a.scanAgain, { primary: true, disabled: local.busy })),
      );

    case "printer-several": {
      const printer = snapshot.printer;
      const devices = printer.kind === "found" ? printer.devices : [];
      return frame(
        screen,
        snapshot,
        "Which printer is this?",
        lead("More than one Zebra is connected. Choose the one you want to print check-in labels on."),
        h("ul", { class: "choices" }, ...devices.map((device) => deviceRow(device, false, () => a.selectPrinter(device.id)))),
      );
    }

    case "printer-no-queue":
      return frame(
        screen,
        snapshot,
        "Set up the printer",
        lead(snapshot.platform === "win32"
          ? "The Windows Zebra queue isn't ready. Install or enable the ZDesigner ZPL USB driver in Windows Printers & scanners; Favor Printer never installs drivers or changes system queues."
          : "Your Mac does not have this printer set up yet. Favor Printer can do it for you. macOS may ask for your password."),
        snapshot.platform === "win32"
          ? actions(button("Open Printers & scanners", a.openPrinterSettings, { primary: true }), button("Check again", a.scanAgain, { disabled: local.busy }))
          : actions(button("Set up printer", a.setUpPrinter, { primary: true, disabled: local.busy })),
      );

    case "printer-fallback":
      return frame(
        screen,
        snapshot,
        "Add the printer in System Settings",
        lead(snapshot.platform === "win32" ? "Windows could not verify a ready Zebra ZPL queue. Check the driver and hardware in Settings:" : "macOS did not let Favor Printer set this up. You can add it yourself:"),
        h(
          "ol",
          { class: "plain" },
          h("li", null, snapshot.platform === "win32" ? "Open Windows Settings, then Bluetooth & devices > Printers & scanners." : "Open System Settings, then Printers & Scanners."),
          h("li", null, snapshot.platform === "win32" ? "Install the official Zebra ZDesigner ZPL driver and verify the Zebra USB device is present." : "Click Add Printer, and choose the Zebra from the list."),
          h("li", null, "Come back here and choose Check again."),
        ),
        actions(
          button("Open Printers & Scanners", a.openPrinterSettings, { primary: true }),
          button("Check again", a.scanAgain, { disabled: local.busy }),
        ),
      );

    case "printer-ready": {
      const printer = snapshot.printer;
      const selected = printer.kind === "found" ? printer.devices.find((device) => device.id === printer.selectedId) : null;
      return frame(
        screen,
        snapshot,
        "Printer ready",
        lead(`${selected?.model || "Your Zebra"} is connected and set up.`),
        actions(button("Continue", a.advance, { primary: true })),
      );
    }

    case "code": {
      const error = codeErrorCopy(local);
      const input = h("input", {
        id: "code",
        class: "code-input",
        type: "text",
        inputmode: "numeric",
        autocomplete: "one-time-code",
        maxlength: 6,
        "aria-describedby": error ? "code-error" : "code-help",
        "aria-invalid": error ? "true" : "false",
        placeholder: "000000",
        spellcheck: "false",
        autofocus: true,
        oninput: (event: Event) => {
          const field = event.target as HTMLInputElement;
          field.value = cleanCodeInput(field.value);
          submit.disabled = local.busy || !isEnrollmentCode(field.value);
        },
      });
      const submit = h("button", { type: "submit", class: "button primary", disabled: true }, local.busy ? "Checking..." : "Connect");
      return frame(
        screen,
        snapshot,
        snapshot.status.color === "red" ? "Enter a new code" : "Enter your code",
        lead(snapshot.platform === "win32" ? "In Favor RSVP admin, open Set up printing. Choose the existing campus printer or add it, and authorize any handover from its current host. Enter the issued six-digit code here." : "In Favor RSVP admin, open Set up printing. Pick the existing campus printer, or add it. If another Mac hosts it, choose \"Hand over from <host>\". Then type the code here."),
        h("p", { class: "hint" }, "The six-digit code only works for a short time."),
        h(
          "form",
          {
            class: "code-form",
            onsubmit: (event: SubmitEvent) => {
              event.preventDefault();
              if (isEnrollmentCode(input.value) && !local.busy) a.submitCode(input.value);
            },
          },
          h("label", { for: "code", class: "field-label" }, "Six-digit code"),
          input,
          error ? h("p", { id: "code-error", class: "note error", role: "alert" }, error) : h("p", { id: "code-help", class: "hint" }, "Numbers only."),
          actions(submit),
        ),
      );
    }

    case "connected":
      return frame(
        screen,
        snapshot,
        snapshot.status.color === "green" || snapshot.status.headline === "Ready to print" ? "Connected" : "Connecting...",
        lead(
          snapshot.label
            ? `This ${snapshot.platform === "win32" ? "Windows PC" : "Mac"} is now ${snapshot.label} in Favor RSVP.`
            : `This ${snapshot.platform === "win32" ? "Windows PC" : "Mac"} is now connected to Favor RSVP.`,
        ),
        statusPill(snapshot),
        printerLine(snapshot),
        renameForm("laptop-name", "Laptop name in RSVP", snapshot.label, local, "laptop", a.renameLaptop),
        snapshot.printerName ? renameForm("printer-name", "Printer name in RSVP", snapshot.printerName, local, "printer", a.renamePrinter) : null,
        actions(button("Run local hardware test", a.advance, { primary: true })),
      );

    case "test-print": {
      const progress = local.testPrint;
      return frame(
        screen,
        snapshot,
        progress.kind === "sent" || progress.kind === "no-label" ? "Did a label come out?" : LOCAL_TEST_COPY.title,
        progress.kind === "sent" || progress.kind === "no-label" ? lead(LOCAL_TEST_COPY.confirmLead) : lead(LOCAL_TEST_COPY.lead),
        note(LOCAL_TEST_COPY.cloudHint),
        progress.kind === "failed" ? note(TEST_PRINT_ERROR_COPY[progress.reason], "error") : null,
        progress.kind === "no-label"
          ? note("Check that the label stock is loaded and the printer light is steady, then try again.", "error")
          : null,
        progress.kind === "sent"
          ? actions(button("Yes, a label came out", () => a.answerLabel(true), { primary: true }), button("No label came out", () => a.answerLabel(false)))
          : actions(
              button(progress.kind === "sending" ? "Sending..." : progress.kind === "idle" ? LOCAL_TEST_COPY.start : "Try again", a.requestTestPrint, {
                primary: true,
                disabled: progress.kind === "sending",
              }),
            ),
      );
    }

    case "done":
      return frame(
        screen,
        snapshot,
        "You are all set",
        lead(snapshot.platform === "win32"
          ? "Favor Printer runs in the Windows notification area. Keep this PC awake, signed in and the Zebra USB cable connected during events."
          : "Favor Printer runs from the menu bar. Keep the lid open and the Mac plugged in during events."),
        h("ul", { class: "plain" }, ...snapshot.warnings.map((warning) => h("li", null, warning))),
        actions(button("Finish", a.advance, { primary: true })),
      );

    case "revoked":
      return frame(
        screen,
        snapshot,
        "This laptop was removed",
        statusPill(snapshot),
        lead("Ask an admin for a new code. Printing is off until you enter it."),
        actions(button("Enter a new code", a.advance, { primary: true })),
      );

    case "status": {
      const seenAt = lastSeenTime(snapshot);
      const backlogWarning = snapshot.warnings.find((warning) => warning.startsWith("Print backlog is "));
      return frame(
        screen,
        snapshot,
        "Favor Printer",
        statusPill(snapshot),
        snapshot.status.detail ? lead(snapshot.status.detail) : null,
        snapshot.fiveState && snapshot.recoveryAction
          ? h("p", { class: "recovery-action hint" }, `${snapshot.fiveState}: ${snapshot.recoveryAction}`)
          : null,
        seenAt ? h("p", { class: "hint" }, `Not seen since ${seenAt}`) : null,
        backlogWarning ? note(backlogWarning) : null,
        printerLine(snapshot),
        h(
          "div",
          { class: "status-meta" },
          h("p", { class: "hint" }, `Version ${snapshot.version} (${channelLabel(snapshot.channel)})`),
          h("p", { class: "hint" }, updateStatusText(snapshot.update)),
        ),
        actions(button("Close", a.closeWindow, { primary: true })),
      );
    }
  }
}
