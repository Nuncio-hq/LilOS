# LilOS mobile (iOS)

The real iPhone app: `ui-native` screens over `client-runtime`, talking to the
relay on the paired Mac. See `AGENTS.md` for the repo rules.

Run it on a simulator: `bun install` at the root, then in this directory
`bunx expo run:ios` (builds the dev client once — needs Xcode + CocoaPods).

## Ship a TestFlight build

From the **repo root**:

```sh
bun run mobile:release
```

That's it — `scripts/release/testflight.sh` does the rest: it asks App Store
Connect for the newest uploaded build of `com.nuncio.lilos.mobile`, bumps it
(so no two uploads ever share a build number — nothing to edit by hand),
prebuilds the iOS project, archives, exports an `.ipa` and uploads it.

What it needs on your Mac:

- **Xcode 26.x** on team `R8GJL3N9WX` — preflight refuses iOS 27+ SDKs: those
  archives crash on launch until UIScene lifecycle adoption lands (#275). On a
  multi-Xcode Mac, point the script at 26.x with
  `DEVELOPER_DIR=/Applications/Xcode-26.x.app/Contents/Developer` (or
  `sudo xcode-select -s`). No Apple ID sign-in needed: the script passes the
  ASC API key to xcodebuild (`-authenticationKeyPath`/`ID`/`IssuerID` +
  `-allowProvisioningUpdates`). An Apple ID signed in works too.
- **CocoaPods** for `expo prebuild` — auto-installed via
  `brew install cocoapods` when `pod` is missing (needs brew).
- The **ASC API key** in env: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`
  (the org secret — same key the desktop notarization uses). The script writes
  the `.p8` to a chmod-600 temp file for xcodebuild/`altool` and deletes it
  after.

On a bare machine, `--dry-run` lists every missing prerequisite with the exact
remedy (bun, clone, `bun install`, Xcode, pods, ASC key).

Useful flags/env: `--dry-run` (preflight + build-number check only),
`--skip-upload` or `LILOS_SKIP_UPLOAD=1` (build + export, no upload),
`LILOS_BUILD_NUMBER=N` (skip the ASC lookup), `LILOS_XCARGS="..."` (extra
`xcodebuild` args, e.g. manual signing).

The build lands in **App Store Connect → LilOS → TestFlight → Internal
Testing**. Processing takes ~5–30 minutes after upload; Oscar's iPhone (an
internal tester) gets it automatically.

### Optional: tag a release instead

Pushing a `mobile-v*` tag runs `.github/workflows/mobile-release.yml`, the EAS
cloud path (`eas build --auto-submit`). That variant needs an Expo account —
a one-time `needs-human` step for Oscar:

1. `bunx eas-cli login` (any Expo account), then `cd apps/mobile &&
   bunx eas-cli init` to mint the EAS project id.
2. `bunx eas-cli whoami` → create an access token at
   https://expo.dev/settings/access-tokens and save it as the repo secret
   `EXPO_TOKEN`.
3. `git tag mobile-v0.1.0-<n> && git push --tags`.
