# Troubleshooting

For volunteers and the tech team. Start with the menu-bar icon: its colour and the first line of the
menu say what is wrong and what to do.

| Icon | Meaning |
| --- | --- |
| Green | Connected and ready to print. |
| Amber | Needs attention: paused, printer missing, an update is waiting, or a job is unconfirmed. |
| Red | Not working: not enrolled, cannot reach Favor RSVP, or the printer queue is broken. |

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
   honestly. "Sent" only means the Mac handed the label to the printer.
6. **Quit and reopen.** Menu > Quit, then open Favor Printer from Applications. Unsent labels are
   kept and are not printed twice.
7. **Enroll again.** If the app says it is not enrolled, ask a Favor RSVP admin for a new six-digit
   code and enter it in setup. If the app says you are being throttled, wait a minute before trying again.
8. **Still stuck.** Send the tech team the app version (menu footer), the menu text and what you tried.
   Do not send photos of labels.

Things that look like bugs and are not:

- **Labels stop when the lid is closed or the Mac sleeps.** The app warns about lid, sleep and battery.
  Keep the Mac awake and plugged in during check-in. The app never promises printing with the lid closed.
- **An "unconfirmed" label count.** A label was sent to the printer but nothing confirmed it came out.
  Look at the label stock and printer light. The app will not reprint it on its own, to avoid
  duplicates.
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
