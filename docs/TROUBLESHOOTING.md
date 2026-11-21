# Troubleshooting

For volunteers and the tech team. Start with the menu-bar icon: its colour and the first line of the
menu say what is wrong and what to do.

| Icon | Meaning |
| --- | --- |
| Green | Connected and ready to print. |
| Amber | Needs attention: paused, printer missing, an update is waiting, or a job is unconfirmed. |
| Red | Not working: not enrolled, cannot reach Favor RSVP, or the printer queue is broken. |

## Printer status states and recovery

Favor Printer evaluates relay and printer signals into exactly five states, each with one recovery action:

| State | Meaning | Recovery Action |
| --- | --- | --- |
| Connected | The printer is plugged in and ready to print. | Run a local test print in Favor Printer to verify labels. |
| Unplugged | No Zebra printer is detected on USB. | Plug in the Zebra with its USB cable. |
| Waiting | Favor Printer is starting, restarting, or waiting for Favor RSVP. | Check the internet connection and wait for Favor RSVP to respond. |
| Needs re-enrollment | The laptop was removed, un-enrolled, or its credentials were rejected. | Ask an admin for a new six-digit code in Favor RSVP. |
| In use elsewhere | The Zebra printer is currently in use by another laptop. | Ask an admin to disconnect this printer from the other laptop. |

## Backlog warning

When queued jobs exceed the backlog threshold or stop draining, a warning appears in the menu and operational status:
- **Growing backlog**: Multiple labels are queued and waiting. Check that the printer is online and loaded with label stock.
- **Stuck backlog**: Queued labels have stopped draining. Check the printer connection and USB cable.
- **Recovery**: The backlog warning clears automatically as soon as queued jobs finish printing or drain to the printer.

## Volunteer recovery

Try these in order. Stop when the icon turns green.

1. **Check the printer.** It is on, has labels, the lid is closed and no light is blinking red, and the
   USB cable is plugged straight into the Mac (not through a dock or hub, if you can avoid it).
2. **Rescan.** Open the menu, go to the printer step of setup, and let it scan again. Pick the Zebra if more
   than one device is listed.
3. **Un-pause.** If the menu says printing is paused, resume it.
4. **Allow the printer setup.** If macOS refuses to create the printer, the app shows the steps to
   allow it in **System Settings > Printers & Scanners**. Follow them, then run the printer setup
   again.
5. **Run a test print.** In setup request a test label and answer **Did a label come out?**
   honestly. "Sent" only means the Mac handed the label to the printer. This is a local hardware
   test. It does not prove check-in labels can reach this printer: an RSVP admin runs the cloud test
   from **Set up printing** on `/admin/printing`, which ends on **End-to-end ready**.
6. **Quit and reopen.** Menu > Quit, then open Favor Printer from Applications. Unsent labels are
   kept and are not printed twice.
7. **Enroll again.** If the app says it is not enrolled, ask a Favor RSVP admin to run **Set up printing**
   for this printer and enter the new six-digit code in setup. If the app says you are being throttled,
   wait a minute before trying again. If it says the code and printer do not match (another campus,
   a different Zebra, already connected to another laptop, listed twice), nothing was changed and the
   code still works: tell the admin the exact message so they can fix it in Set up printing. If it says
   the code has expired or was used up, ask for a new one. After enrolling, setup shows the printer and campus this Mac
   now serves; check it is the one you expect.
8. **Still stuck.** Send the tech team the app version (menu footer), the menu text and what you tried.
   Do not send photos of labels.

Things that look like bugs and are not:

- **Labels stop when the lid is closed or the Mac sleeps.** The app warns about lid, sleep and battery.
  Keep the Mac awake and plugged in during check-in. The app never promises printing with the lid closed.
- **An "unconfirmed" label count.** A label was sent to the printer but nothing confirmed it came out.
  Look at the label stock and printer light. The app will not reprint it on its own, to avoid
  duplicates.
- **The app opens but no window appears.** Reopen Favor Printer from Applications. Launching it by hand
  or reopening it from Applications shows the window. When it starts at login on a Mac that is already
  set up, it stays quiet in the menu bar. The menu-bar icon may also be hidden behind the notch: quit other menu-bar
  apps or hold Command and drag icons to make room.
- **"Paired to someone else's laptop" or "No enabled printers".** This Mac is enrolled to a printer that
  another laptop holds, or the printer is disabled. In the window, pair again with a new six-digit
  code. An admin revokes the old laptop in Favor RSVP and creates the code in **Set up printing**.
- **"Damaged" or "cannot be opened" on first launch.** The download is incomplete or is an unsigned
  development build. Delete it and download again from https://rsvp.favor.church/printer.

### For the tech team

- **Update stuck.** The app only moves to a higher version. If a bad release is installed, publish a
  fix-forward release with a higher version ([RELEASING.md](RELEASING.md#rollback)). A volunteer who
  cannot update can quit the app and install the new DMG over the old app in Applications.
- **Check the Mac sees the printer.** `system_profiler SPUSBDataType | grep -i zebra`
- **Check the queue.** `lpstat -p -d` lists queues and their state. A queue stuck as disabled can be
  re-enabled with `cupsenable <queue>` (admin).
- **Check the legacy relay is gone.** See below.

## Legacy migration

Before this app, the check-in relay ran as a launchd agent labelled `church.favor.printrelay`. It must
not run alongside the app: two relays would claim jobs for the same printer.

When the app finds that agent loaded, it offers to migrate. That action stops
the agent (`bootout`) and disables it so it does not return at login. If it fails, the app reports
whether the stop (`bootout_failed`) or the disable (`disable_failed`) failed. Do it by hand in
Terminal, as the volunteer's user:

```sh
launchctl print "gui/$(id -u)/church.favor.printrelay"     # loaded? prints the job if so
launchctl bootout "gui/$(id -u)/church.favor.printrelay"   # stop it
launchctl disable "gui/$(id -u)/church.favor.printrelay"   # keep it from coming back
```

An error from `print` or `bootout` saying the service is not found means it is already gone. If the
agent also has a plist in `~/Library/LaunchAgents/` you can move that file to the Trash once it is
booted out. Then reopen the app: the notice should disappear.

Do not delete the old relay's credentials before the app shows green. They are the way back if the
volunteer's Mac needs the old relay again.

## Uninstall

1. Menu-bar icon > **Quit**.
2. Remove the app from login: **System Settings > General > Login Items & Extensions**, remove
   Favor Printer.
3. Drag **Favor Printer** from Applications to the Trash.
4. Remove its data (enrollment, settings and any unsent spool). Unsent labels are lost; that is fine
   when the Mac is leaving the check-in team.

   ```sh
   rm -rf "$HOME/Library/Application Support/Favor Printer"
   ```

   The folder name is the product name. If it is missing, look in `~/Library/Application Support` for
   a `Favor*` folder.
5. Remove the printer queue the app created: **System Settings > Printers & Scanners**, select the
   Zebra queue and click **-**. Or in Terminal: `lpstat -p` to find the name, then
   `sudo lpadmin -x <queue>`.
6. Remove the legacy relay if it is still there (see above).
7. Ask a Favor RSVP admin to remove this laptop from the printer list so the cloud stops assigning
   labels to it.

### Windows (Preview)

1. Notification-area icon > **Quit**.
2. **Settings > Apps > Installed apps** > **Favor Printer** > **Uninstall**. This removes the app, its
   Start menu shortcut and its open-at-login entry. If the installer set your PowerShell policy, it puts
   back the earlier value. Windows may keep its own Startup apps on/off record for the app; it is
   harmless.
3. Remove its data (enrollment, settings and any unsent spool). Unsent labels are lost. The enrollment
   token is encrypted for this Windows account, but delete it when the PC leaves the check-in team:

   ```powershell
   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Favor Printer"
   Remove-Item -Recurse -Force "$env:APPDATA\Favor Printer"
   ```

   The enrollment token, the paired printer and the spool are kept per PC in `%LOCALAPPDATA%\Favor Printer`.
   Logs, caches and the key that decrypts the token stay in `%APPDATA%\Favor Printer` (logs are in
   `logs\main.log`). Earlier Windows builds kept the token, settings and spool in the `%APPDATA%` folder too; the
   app moves them to the local folder the first time the newer build starts, and removes the old copies the next
   time it starts. Remove both folders.

   Going back to an older Windows build after this move is not supported: it reads `%APPDATA%`, finds no token,
   settings or spool there and shows as not set up. If you pair again on the older build and then update again,
   the newer build keeps the data it already moved and deletes what the older build wrote in `%APPDATA%`, so pair
   once more after updating.

4. Leave the Zebra driver and its queue alone unless IT asks; Favor Printer never created them.
5. Ask a Favor RSVP admin to remove this PC from the printer list so the cloud stops assigning labels
   to it.
