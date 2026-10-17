# Installing Favor Printer on an iPad

The internal iPad build of Favor Printer is a print relay for a Zebra ZD421 plugged into the iPad by USB-C. It talks to
**production RSVP** (`https://rsvp.favor.church`) and is not on the App Store. There are two ways to install it:

| | TestFlight | OTA (over the air) |
| --- | --- | --- |
| Use it when | The iPad belongs to someone with an App Store Connect user on Favor's team | The iPad is registered with Favor's Apple developer team and its owner has no Apple account on the team |
| Needs | An invite from a maintainer, the TestFlight app, the owner's Apple ID | The iPad's UDID registered, then a link from RSVP |
| Signing | App Store distribution, builds expire after 90 days | Development profile (team `3JJ4492TV8`), covers **2 devices**, **expires 2027-10-15** |

Pick one per iPad. Both use the same bundle ID, so installing one over the other replaces it (see
[Constraints](#constraints)).

## Contents

1. [Operator runbook: install with TestFlight](#operator-runbook-install-with-testflight)
2. [Operator runbook: install on an iPad (OTA)](#operator-runbook-install-on-an-ipad-ota)
3. [Troubleshooting](#troubleshooting)
4. [Maintainer runbook: ship a build or add an iPad](#maintainer-runbook-ship-a-build-or-add-an-ipad)
5. [Maintainer runbook: TestFlight](#maintainer-runbook-testflight)

## Operator runbook: install with TestFlight

Use this when the iPad's owner has an App Store Connect user on Favor's team. A maintainer must add them as an
internal tester first, and the iPad must be signed in to the Apple ID of that user.

1. **Accept the invite.** Open the TestFlight invitation email on the iPad and tap **View in TestFlight** (or **Accept**).
2. **Install TestFlight.** If the iPad does not have TestFlight, the invite opens the App Store page for it. Install
   it, then reopen the invite.
3. **Install Favor Printer.** In TestFlight, tap **Install** next to Favor Printer.
4. Continue with steps 3 to 7 of the OTA runbook below: turn the driver on, replug the Zebra, check the app, enroll
   with a one-time code and leave **Keep running in background** on. There is no "trust the developer" step.

If the iPad already has an OTA build, see [Constraints](#constraints) before installing from TestFlight.

## Operator runbook: install on an iPad (OTA)

Use this for registered iPads whose owner does not need an Apple account. Before you start, ask the printer admin to
register the iPad. An unregistered iPad cannot install the app.

The install link is the **Install on iPad** button on <https://rsvp.favor.church/printer> (also in the admin printing
panel).

1. **Install.** Open <https://rsvp.favor.church/printer> in Safari on the iPad, then tap **Install on iPad**.
2. **Trust the developer.** If the iPad asks, go to Settings > General > VPN & Device Management and trust the
   developer.
3. **Turn the driver on.** Go to Settings > Favor Printer > Drivers and turn the driver on.
4. **Plug in the Zebra.** Connect the Zebra ZD421 with USB-C, then unplug it and plug it back in.
5. **Check the app.** Open Favor Printer. It should show **Printer attached** with the driver running.
6. **Enter your code.** Enroll with a one-time code from an RSVP printing admin.
7. **Keep it running.** Leave **Keep running in background** on. The app only prints in the background while it is on.

The app walks through steps 3 to 7 itself. On first launch it opens a **Setup guide** that shows each step's state and
what to do next: driver, cable, enrollment, Guided Access and Auto-Lock, and background printing. Follow the in-app guide
for the iPad steps. Tap **Setup guide** on the status screen to reopen it. The steps above stay as the written reference.
Simulator screenshots of the guide are in [docs/verification/ipad-ux](verification/ipad-ux/README.md).

If the printer is currently set up on a Mac, the admin must confirm **Hand over from <host>** when they issue the code.
The Mac must already be on Favor Printer v0.3.0-beta.2 or later.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "Unable to install" | The iPad is not registered, or the network blocked the download. Ask the printer admin to check the registration, then try again on a different network. |
| No TestFlight invite email, or TestFlight does not list Favor Printer | The owner is not an internal tester yet, or the iPad is signed in to a different Apple ID. Ask a maintainer to check the tester list. |
| TestFlight shows the build as expired | TestFlight builds last 90 days. Ask a maintainer for a newer build, then update in TestFlight. |
| "Printer seen, driver not running" | Turn the driver off and on in Settings > Favor Printer > Drivers, then replug the printer. |
| "This printer is active on another host" | Ask an RSVP printing admin for a handover code. |
| "Printer moved to another host" | Another host took over this printer, so this iPad stopped printing. If that was not intended, ask an admin for a new handover code. |

## Maintainer runbook: ship a build or add an iPad

Two things are involved: the Apple development profile (which iPads can install) and the build itself (which .ipa they
install). Adding an iPad changes the profile, so it needs a rebuild. A new build alone does not need new iPads.

The build flavor is the `Internal` configuration. Its details, the keep-alive and the commands are in the
"Internal build" section of `ios/README.md` on `main`. For the TestFlight channel see
[Maintainer runbook: TestFlight](#maintainer-runbook-testflight).

### 1. Get the UDID

Any of these:

- Finder: connect the iPad to a Mac, select it in the sidebar, then click the line under its name until the UDID shows.
  Right-click to copy.
- Apple Configurator: select the iPad and copy the UDID from its details.
- Connect the iPad to the build Mac and list it with `xcrun devicectl list devices`.

### 2. Register it

Either:

- Build with `-allowProvisioningDeviceRegistration` while the iPad is connected to the build Mac, or
- Add the UDID in the Apple developer portal (Certificates, Identifiers & Profiles > Devices).

Registered devices are added to the automatic development profile on the next build with `-allowProvisioningUpdates`.

### 3. Rebuild and export the Internal build

Follow "Internal build" in `ios/README.md` on `main`:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
cd ios && xcodegen generate
xcodebuild -project FavorPrinter.xcodeproj -scheme FavorPrinter -configuration Internal \
  -destination 'generic/platform=iOS' -archivePath /tmp/fp-internal/FavorPrinter.xcarchive \
  -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath /tmp/fp-internal/FavorPrinter.xcarchive \
  -exportOptionsPlist Config/ExportOptions.plist -exportPath /tmp/fp-internal/export -allowProvisioningUpdates
```

The result is `/tmp/fp-internal/export/FavorPrinter.ipa`. Rename it to `FavorPrinter-iPad-internal.ipa`, the asset name
the manifest expects.

### 4. Publish a GitHub prerelease

Create a **prerelease** in `favorchurch/favor-printer` tagged `ipad-internal-<sha>`, where `<sha>` is the short commit
the build came from, and attach the .ipa. Do not make it a normal release: the Mac app's update feed reads normal
releases only, and this build must never reach Mac volunteers.

```sh
gh release create ipad-internal-<sha> FavorPrinter-iPad-internal.ipa \
  --repo favorchurch/favor-printer --prerelease --target <sha> \
  --title "iPad internal <sha>" --notes "Internal iPad build. Development-signed, registered iPads only."
```

### 5. Update RSVP

In `rsvp.favor.church`, edit `src/lib/printer/ipadRelease.ts` and change only `IPAD_IPA_URL` (to the new asset URL,
`https://github.com/favorchurch/favor-printer/releases/download/ipad-internal-<sha>/FavorPrinter-iPad-internal.ipa`)
and `IPAD_VERSION`. Open a PR. **Merging deploys to production**, so merge only when the asset is already published and
downloads.

The current build is `ipad-internal-c9c07ac`.

### 6. Verify

After the deploy:

```sh
curl -sI https://rsvp.favor.church/downloads/ipad/manifest.plist | head -1   # expect 200
curl -s https://rsvp.favor.church/downloads/ipad/manifest.plist | grep -A1 software-package
curl -sIL <IPA URL> | grep -E '^HTTP|content-length'                          # expect 200 and a non-trivial size
```

Then install on a registered iPad from the /printer page and run the operator steps above.

### 7. Profile expiry and renewal

The development profile expires **2027-10-15**. After that date the app stops launching and new installs fail. Before
then:

1. Rebuild and export the Internal build with `-allowProvisioningUpdates`, which renews the automatic profile (or
   regenerate it in the developer portal).
2. Check that every iPad's UDID is still registered. Registered devices count against the team's yearly device limit and
   are only removed at membership renewal.
3. Publish and update RSVP as in steps 4 to 6, then reinstall on each iPad.

## Maintainer runbook: TestFlight

The TestFlight channel ships the `TestFlight` configuration, the Internal build signed for App Store Connect. The
prerequisites (Apple's DriverKit USB entitlement approval on the distribution profile, the App Store Connect app
record, the distribution certificate and the API key), the build number rule and the exact commands are in the
"TestFlight build" section of `ios/README.md` on `main`. Do not copy the commands here.

1. **Archive and export.** Archive the `TestFlight` configuration from a clean, full checkout of a merged `main`
   commit (the build number comes from the commit count) and export it with `Config/ExportOptions-TestFlight.plist`,
   as `ios/README.md` describes.
2. **Upload.** Upload the exported `.ipa` with `altool` or Transporter, as `ios/README.md` describes. Wait for App
   Store Connect to finish processing it.
3. **Export compliance.** The build declares `ITSAppUsesNonExemptEncryption` false (HTTPS only), so App Store Connect
   should not ask. If it does, check that the declaration shipped in the `Info.plist` before answering the prompt.
4. **Add internal testers.** In App Store Connect, go to the app > TestFlight > Internal Testing and add the build to
   an internal group. Testers must be App Store Connect users on the team. Do not create an external group and do not
   add the build to one.
5. **Invite.** Testers get the invitation email. Send them the TestFlight operator runbook above.
6. **Build expiry.** Every TestFlight build expires **90 days** after upload and then stops launching. Upload a newer
   build before then, and tell testers to update in TestFlight. Unlike the OTA profile, no iPad registration is needed.

### Constraints

- The keep-alive build plays a silent audio loop to stay alive in the background. That violates App Store guideline
  2.5.4, so it may go to **internal TestFlight only**. Never add it to external testers and never submit it for App
  Store review.
- OTA and TestFlight builds share bundle ID `church.favor.printer.ios`. Installing a TestFlight build over an OTA build
  (or the reverse) replaces it, and the iPad keeps one copy. After switching, open Favor Printer and confirm on the
  status screen that the iPad is still enrolled. If it is not, enroll again with a one-time code from an RSVP
  printing admin.
