/** Identity and release constants shared by main, preload, renderer and the build checks. */

export const APP_ID = "church.favor.printer";
export const PRODUCT_NAME = "Favor Printer";

/** GitHub Releases of this repository are the download and auto-update source. */
export const RELEASE_OWNER = "favorchurch";
export const RELEASE_REPO = "favor-printer";

/** The pre-app launchd relay that this app replaces. See the legacy cutover in the plan. */
export const LEGACY_LAUNCH_AGENT_LABEL = "church.favor.printrelay";

export const UPDATE_CHANNELS = ["stable", "preview"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** Enrollment codes are six digits, entered by the volunteer. */
export const ENROLLMENT_CODE_PATTERN = /^\d{6}$/;

export function isEnrollmentCode(value: unknown): value is string {
  return typeof value === "string" && value.length === 6 && ENROLLMENT_CODE_PATTERN.test(value);
}

/** The same pattern the RSVP server requires of `usbSerial` (parseEnrollInput). */
export const USB_SERIAL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function isUsableUsbSerial(value: unknown): value is string {
  return typeof value === "string" && USB_SERIAL_PATTERN.test(value);
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return typeof value === "string" && (UPDATE_CHANNELS as readonly string[]).includes(value);
}
