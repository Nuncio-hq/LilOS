# Spike #21 — relay + harness as macOS launch agents in an Electron app

Throwaway sample. Answers: *can a signed Electron LilOS.app register two
launch agents with `SMAppService`, have them survive app quit and reboot, and
update them with the app?*

## Layout

- `src/` — Electron app (window lists both services, status, heartbeat tail,
  Register/Unregister buttons, "Open Login Items Settings").
- `native/agent/main.swift` — dummy service binary; heartbeat every 5 s to
  `~/Library/Logs/LilOSSpike/lilos-<name>.log` (name + version baked in at
  build time via a generated `*_config.swift`).
- `native/helper/main.swift` — `smappservice-helper` CLI inside
  `Contents/MacOS/` wrapping `SMAppService.agent(plistName:)`:
  `register|unregister|status|open-settings`.
- `launchagents/*.plist` — `BundleProgram` + `KeepAlive` + `RunAtLoad`, placed
  in `Contents/Library/LaunchAgents/`.
- `scripts/build.sh [version] [identity]` — compiles helpers, assembles
  `dist/LilOSSpike.app` from the stock Electron bundle, signs (`-` = ad-hoc,
  or a Developer ID identity name).
- `scripts/check.sh` — prints launchctl state + heartbeat tails.

## Build & run

```bash
npm install                       # fetches Electron binary
scripts/build.sh 1 -              # v1, ad-hoc signed
sudo cp -R dist/LilOSSpike.app /Applications/
open /Applications/LilOSSpike.app # click Register in the window (or call
                                  # smappservice-helper register <plist>)
scripts/check.sh
```

Update test: `scripts/build.sh 2 -`, replace `/Applications/LilOSSpike.app`,
relaunch, then `unregister` + `register` each label (see findings — plain
re-register leaves a stale bundle pin).

## Signing

This VM has **no usable signing identity** (`security find-identity -v` = 0).
The ASC account holds a `Developer ID Application` cert (team R8GJL3N9VX) but
its private key is not on this VM, and `asc certificates create
DEVELOPER_ID_APPLICATION` is rejected (needs Account Holder role). So this
run is **ad-hoc signed** (`codesign --force --deep --sign -`): SMAppService
registration, the Login Items UI, quit/reboot survival and the update flow all
work identically locally; what ad-hoc does NOT prove is Gatekeeper acceptance
on a fresh machine + notarization. To close that gap: export the existing
Developer ID cert + key (.p12) from the Mac that created it, then
`scripts/build.sh 1 "Developer ID Application: Nghia Le (R8GJL3N9VX)"` and
`xcrun notarytool submit ... --key-id $ASC_KEY_ID --issuer $ASC_ISSUER_ID
--key <p8 file>`.

## Run on Oscar's MDM Mac (Hermes agent)

```bash
git clone https://github.com/Nuncio-hq/LilOS.git && cd LilOS
git checkout spike/21-smappservice && cd spikes/21-smappservice
npm install && scripts/build.sh 1 "Developer ID Application: Nghia Le (R8GJL3N9VX)"
sudo cp -R dist/LilOSSpike.app /Applications/ && open /Applications/LilOSSpike.app
scripts/check.sh            # both agents state=running
# quit app, re-run check.sh — still running
sudo reboot                 # after login: check.sh again
scripts/build.sh 2 ...      # rebuild v2, replace app, relaunch,
                            # unregister+register, verify v2 in check.sh
```
MDM watch-items: `com.apple.servicemanagement` profile may block or
pre-approve background items; check System Settings → General → Login Items &
Extensions and `profiles show -type configuration` for
`com.apple.TCC.configuration-profile-policy` / ServiceManagement rules.
