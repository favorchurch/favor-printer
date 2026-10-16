# Installing Favor Printer on an iPad

The internal iPad build of Favor Printer is a print relay for a Zebra ZD421 plugged into the iPad by USB-C. It is
development-signed (team `3JJ4492TV8`), installs only on iPads registered with Favor's Apple developer team, and talks
to **production RSVP** (`https://rsvp.favor.church`). It is not on TestFlight or the App Store.

The development profile currently covers **2 devices** and **expires 2027-10-15**.

## Contents

1. [Operator runbook: install on an iPad](#operator-runbook-install-on-an-ipad)
2. [Troubleshooting](#troubleshooting)
3. [Maintainer runbook: ship a build or add an iPad](#maintainer-runbook-ship-a-build-or-add-an-ipad)

## Operator runbook: install on an iPad

Before you start, ask the printer admin to register the iPad. An unregistered iPad cannot install the app.

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

If the printer is currently set up on a Mac, the admin must confirm **Hand over from <host>** when they issue the code.
The Mac must already be on Favor Printer v0.3.0-beta.2 or later.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "Unable to install" | The iPad is not registered, or the network blocked the download. Ask the printer admin to check the registration, then try again on a different network. |
| "Printer seen, driver not running" | Turn the driver off and on in Settings > Favor Printer > Drivers, then replug the printer. |
| "This printer is active on another host" | Ask an RSVP printing admin for a handover code. |
| "Printer moved to another host" | Another host took over this printer, so this iPad stopped printing. If that was not intended, ask an admin for a new handover code. |

## Maintainer runbook: ship a build or add an iPad

Two things are involved: the Apple development profile (which iPads can install) and the build itself (which .ipa they
install). Adding an iPad changes the profile, so it needs a rebuild. A new build alone does not need new iPads.

The build flavor is the `Internal` configuration. Its details, the keep-alive and the commands are in the
"Internal build" section of `ios/README.md` on branch `internal/ipad-keepalive`.

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

Follow "Internal build" in `ios/README.md` on `internal/ipad-keepalive`:

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

### Constraints

- This build plays a silent audio loop to stay alive in the background. That violates App Store guideline 2.5.4, so it
  is not App Store eligible. Never submit it to TestFlight or the App Store.
