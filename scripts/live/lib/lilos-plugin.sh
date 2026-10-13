#!/usr/bin/env bash
# Shared plugin connect for live legs (issue #642), sourced — never executed.
#
# The #548/#549 legs install the bundled `lilos` plugin inline, exactly the
# way apps/harness/src/connect.ts does on a real install. Legs whose legs
# never did ran their scratch HERMES_HOME without it — the session's
# ensureLilosBackend then logged `engine activation returned but 'lilos' is
# still not loaded`, and any leg exercising lilos_* tools silently ran
# without them.
#
# Call AFTER HOME/HERMES_HOME are exported and the provider config exists
# (the first `hermes` call absorbs the scratch-home first-run provisioning
# the same way `hermes serve` boot does):
#
#   . scripts/live/lib/lilos-plugin.sh
#   lilos_connect_plugin            # connect the built-in `default` profile
#   lilos_clone_profile ada         # a named profile, cloned pre-connected
#
# `lilos_connect_plugin` is the connect.ts `connect()` sequence verbatim:
# plugin dir under the profile home, `plugins enable`, tool search off
# (lilos_* must be offered, not searched for — #411), Hermes' own `browser`
# toolset suppressed at the offer (#549). `default`'s profile home IS
# $HERMES_HOME itself — the same layout connect.ts's profileHome() uses.
lilos_connect_plugin() {
  mkdir -p "$HERMES_HOME/plugins"
  cp -R "$LILOS_REPO_ROOT/packages/engine-hermes/plugin/lilos" \
    "$HERMES_HOME/plugins/lilos" || {
      echo "LIVE_CONNECT_FAILED: could not copy the bundled lilos plugin"
      exit 1
    }
  hermes -p default plugins enable lilos || {
    echo "LIVE_CONNECT_FAILED: plugins enable lilos"
    exit 1
  }
  hermes -p default config set tools.tool_search.enabled off || {
    echo "LIVE_CONNECT_FAILED: config set tools.tool_search.enabled off"
    exit 1
  }
  hermes -p default config set agent.disabled_toolsets '["browser"]' || {
    echo "LIVE_CONNECT_FAILED: config set agent.disabled_toolsets"
    exit 1
  }
}

# A named profile created the way an employee's profile is hired: cloned
# from `default` once it is connected, so the clone lands with providers,
# `plugins.enabled`, the installed plugin files, and the connect-time
# toolset config already in place — `profiles.create` carries them all.
# The leg's session then finds the profile (ensureAgent lists it) instead
# of creating a bare one without the plugin.
lilos_clone_profile() {
  hermes profile create "$1" --clone-from default --no-alias || {
    echo "LIVE_CONNECT_FAILED: profile create $1"
    exit 1
  }
}
