# Updates

How Favor Printer finds and installs updates on the Mac and the iPad, what operators see, how a maintainer controls
rollout, and the exact release-metadata contract the iPad reads. For cutting a release see [RELEASING.md](RELEASING.md).
For installing the iPad app see [IPAD-INSTALL.md](IPAD-INSTALL.md).

## Operator instructions

### Mac

- **Version and channel.** Open the status window. The subtitle reads `Version x.y.z (Stable)` or `(Preview)`.
  The tray menu shows `Favor Printer x.y.z` and an **Update channel** submenu.
- **Update status.** The status window shows one update line and, once a check has reached the update feed, a
  `Last checked` line. The tray menu shows the same state.
  - `Update available: vX` means a newer release was found and is downloading.
  - `Update ready: vX. It installs when you quit.` means the download finished. Quit Favor Printer from the tray
    (**Quit Favor Printer**) and the update installs, then open the app again.
  - `Update check failed.` (tray: `Update check failed. Try again`) means the feed could not be read. Printing is
    not affected. Choose **Check for updates** in the tray to retry.
- **What quitting does.** Quitting is the only thing that installs a downloaded update. The app never restarts on its
  own while labels may be printing. Quit between services, not during check-in.

### iPad

The iPad app checks for updates itself. When a newer build is released for the way this iPad was installed, the status
screen shows an **Update available** card with the latest version and build, and one button. The app never opens the
button's target on its own. It opens only when you tap.

| Installed through                                                | Button                   | What happens                                                                      |
| ---------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| OTA (**Install on iPad** on <https://rsvp.favor.church/printer>) | **Open install page**    | Opens the OTA install link. iOS asks to install over the current app.             |
| TestFlight                                                       | **Update in TestFlight** | Opens TestFlight, which owns updates for TestFlight builds. Tap **Update** there. |

The status screen's **Version** row shows the installed version and build.

**TestFlight builds expire 90 days after upload.** An expired build stops launching. If the card does not appear and the
app is close to 90 days old, open TestFlight and check for a newer build, or ask a maintainer to upload one. The OTA
build does not expire this way. Its development profile expires **2027-10-15** (see
[IPAD-INSTALL.md](IPAD-INSTALL.md#7-profile-expiry-and-renewal)).

No card is shown when the app is up to date, when it is a development build, or when the update check cannot be trusted
(see [How the iPad decides](#how-the-ipad-decides)). A missing card is never an error. Printing is not affected.

## Rollout and revocation

- **Mac.** The update feed is the releases on `favorchurch/favor-printer`. Only a **published** release is offered, and
  only after the release owner approved publishing (see [Publishing the draft](RELEASING.md#publishing-the-draft)).
  Drafts and prereleases are never announced to Mac volunteers. The iPad internal builds are prereleases for this
  reason.
- **iPad.** Only a metadata file with `"released": true` can show a prompt. The app announces an update only for a
  build that is already published and installable. Set `released` to `false` to stop prompts.
- **Revocation stops prompts. It never downgrades.** Pulling a release (Mac: unpublish or supersede it, iPad:
  `"released": false`) means no device is told to update to it. Devices that already installed it keep running it. To
  move them off a bad build, ship a **higher** version and build number (see [Rollback](RELEASING.md#rollback)).

## Release metadata contract (iPad)

The iPad reads one JSON document over HTTPS from `UPDATE_METADATA_URL`, which is
`https://rsvp.favor.church/downloads/ipad/update.json` for the Internal, TestFlight and Release configurations
(`ios/Config/*.xcconfig`). If the URL is absent, not HTTPS, carries credentials, or is not the production host in a
Release build, the check stays off.

```json
{
  "schemaVersion": 1,
  "bundleId": "church.favor.printer.ios",
  "channel": "ota",
  "version": "0.3.0",
  "build": "412",
  "released": true,
  "installURL": "itms-services://?action=download-manifest&url=https://rsvp.favor.church/downloads/ipad/manifest.plist"
}
```

| Field           | Type              | Rule                                                                                                                                                                         |
| --------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | integer           | Must be `1`. Any other value fails the check closed (no prompt).                                                                                                             |
| `bundleId`      | string            | Must equal the app's bundle ID, `church.favor.printer.ios`. A different value means no prompt.                                                                               |
| `channel`       | string            | `ota` or `testflight`. Must match how the iPad was installed. A mismatch means no prompt. The file holds one channel, so it announces updates to one install type at a time. |
| `version`       | string            | Display text, 1 to 32 characters of ASCII letters, digits, `.`, `-`, `+`.                                                                                                    |
| `build`         | string or integer | Digits only, at most 9. Compared as a number, so `10` is newer than `9`. `1.2` or `-3` is unreadable and fails closed.                                                       |
| `released`      | boolean           | `true` only once the artifact is published and installable. `false` means no prompt.                                                                                         |
| `installURL`    | string            | OTA only. Required for `ota`, ignored for `testflight`. See below.                                                                                                           |

`installURL` must be `itms-services://?action=download-manifest&url=<manifest>` with exactly one `action` and one
`url`. The manifest URL must be HTTPS, carry no credentials, and be on the same host as the metadata file. Anything
else means no prompt.

The document must be at most 64 KiB and the response status must be 200.

### How the iPad decides

The app prompts only when every check passes, in this order: the install is OTA or TestFlight, the installed build
number is readable, the response is 200 and small enough, `schemaVersion` is `1`, the fields decode,
`bundleId` and `channel` match, `released` is `true`, `build` is **greater than** the installed build, and for OTA
the `installURL` is valid. Any failure means no prompt. A network error, a non-200 status, a malformed body or an
unknown schema is a failed check, which retries later: after the app returns to the foreground at most every 15
minutes, every 6 hours while it stays open, and backing off up to 6 hours after repeated failures.

The metadata never installs anything by itself, and a TestFlight build is never pointed at an OTA link.

### Changing the contract

Any change to the fields above needs a new `schemaVersion`. Old apps fail closed on a version they do not know, so
publish the new schema only after the app that reads it is out. The decoder is `ios/FavorPrinter/Update/UpdateCheck.swift`.

## What install on quit does

An update installs only when the app quits, and only after the relay has stopped on its own:

- **Relay stops cleanly, no label in flight.** The update installs as the app quits.
- **A label is being printed.** The app waits for that label to finish, then installs.
- **The relay does not stop in time and has to be ended.** It may have been cut off while reconciling its spool, so
  the app quits **without installing**. The downloaded update stays ready and installs on the next clean quit, so the
  `Update ready` line can still show after a restart. Queued labels are not lost and resume from the spool on the next
  start.

The app does not inspect the spool itself. Quit between services, and if a quit did not install, quit again once the
status window shows no labels waiting or marked `to check`.
