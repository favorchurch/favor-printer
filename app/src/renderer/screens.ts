/**
 * One function per screen, each returning the page's `<main>`. Screens hold no
 * state: they read the snapshot and local state they are given and call the
 * actions. Nothing here shows a name, ZPL or a security code.
 */

import type { AppSnapshot, PrinterDevice } from "../shared";
import { isEnrollmentCode } from "../shared";
import { h } from "./dom";
import {
  cleanCodeInput,
  ENROLL_ERROR_COPY,
  stepLabel,
  TEST_PRINT_ERROR_COPY,
  type LocalState,
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
      return "Downloading an update...";
    case "ready":
      return update.version
        ? `Update ${update.version} ready. It installs when you quit.`
        : "An update is ready. It installs when you quit.";
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
        lead("Connect the printer to this Mac with its USB cable and turn it on. It can take a few seconds to show up."),
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
        lead("Your Mac does not have this printer set up yet. Favor Printer can do it for you. macOS may ask for your password."),
        actions(button("Set up printer", a.setUpPrinter, { primary: true, disabled: local.busy })),
      );

    case "printer-fallback":
      return frame(
        screen,
        snapshot,
        "Add the printer in System Settings",
        lead("macOS did not let Favor Printer set this up. You can add it yourself:"),
        h(
          "ol",
          { class: "plain" },
          h("li", null, "Open System Settings, then Printers & Scanners."),
          h("li", null, "Click Add Printer, and choose the Zebra from the list."),
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
      const error = local.codeError;
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
        lead("Ask an admin for a six-digit code from Favor RSVP. It only works for a short time."),
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
          error ? h("p", { id: "code-error", class: "note error", role: "alert" }, ENROLL_ERROR_COPY[error]) : h("p", { id: "code-help", class: "hint" }, "Numbers only."),
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
            ? `This Mac is now ${snapshot.label} in Favor RSVP.`
            : "This Mac is now connected to Favor RSVP.",
        ),
        statusPill(snapshot),
        actions(button("Print a test label", a.advance, { primary: true })),
      );

    case "test-print": {
      const progress = local.testPrint;
      return frame(
        screen,
        snapshot,
        progress.kind === "sent" || progress.kind === "no-label" ? "Did a label come out?" : "Print a test label",
        progress.kind === "sent" || progress.kind === "no-label"
          ? lead(
              "Favor Printer sent the label to the printer. That does not prove a label printed, so check the printer.",
            )
          : lead("Favor Printer will send one test label to your Zebra."),
        progress.kind === "failed" ? note(TEST_PRINT_ERROR_COPY[progress.reason], "error") : null,
        progress.kind === "no-label"
          ? note("Check that the label stock is loaded and the printer light is steady, then try again.", "error")
          : null,
        progress.kind === "sent"
          ? actions(button("Yes, a label came out", () => a.answerLabel(true), { primary: true }), button("No label came out", () => a.answerLabel(false)))
          : actions(
              button(progress.kind === "sending" ? "Sending..." : progress.kind === "idle" ? "Print test label" : "Try again", a.requestTestPrint, {
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
        lead("Favor Printer runs from the menu bar. Keep the lid open and the Mac plugged in during events."),
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

    case "status":
      return frame(
        screen,
        snapshot,
        "Favor Printer",
        statusPill(snapshot),
        snapshot.status.detail ? lead(snapshot.status.detail) : null,
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
