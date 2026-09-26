/**
 * Launch-agent model for LilOS's two background services (AC-1), per the SP1
 * spike (`spikes/21-smappservice`): SMAppService agents declared by plists in
 * `Contents/Library/LaunchAgents/`, each running a `BundleProgram` binary
 * inside `Contents/MacOS/`. launchd owns the processes — `RunAtLoad` starts
 * them at login (reboot survival) and `KeepAlive` restarts them on crash and
 * keeps them up when the app quits.
 */

export interface LaunchAgentSpec {
  /** launchd label, e.g. `com.nuncio.lilos.relay`. Also the plist basename. */
  label: string;
  /** Path *inside the app bundle* to the service binary. */
  bundleProgram: string;
  /** Absolute log paths (launchd opens them for the agent). */
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string>;
}

/** The two services LilOS registers (this slice's contract with launchd). */
export const LILOS_BUNDLE_ID = "com.nuncio.lilos";
export const LILOS_LOG_DIR = "~/Library/Logs/LilOS";

export const RELAY_AGENT: LaunchAgentSpec = {
  label: `${LILOS_BUNDLE_ID}.relay`,
  bundleProgram: "Contents/MacOS/lilos-relay",
  stdoutPath: `${LILOS_LOG_DIR}/relay.stdout.log`,
  stderrPath: `${LILOS_LOG_DIR}/relay.stderr.log`,
};

export const HARNESS_AGENT: LaunchAgentSpec = {
  label: `${LILOS_BUNDLE_ID}.harness`,
  bundleProgram: "Contents/MacOS/lilos-harness",
  stdoutPath: `${LILOS_LOG_DIR}/harness.stdout.log`,
  stderrPath: `${LILOS_LOG_DIR}/harness.stderr.log`,
};

export const LILOS_AGENTS: readonly LaunchAgentSpec[] = [
  RELAY_AGENT,
  HARNESS_AGENT,
];

export function plistFileName(spec: LaunchAgentSpec): string {
  return `${spec.label}.plist`;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render the plist SMAppService registers verbatim from the bundle. */
export function renderLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const env = spec.environment
    ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${Object.entries(
        spec.environment,
      )
        .map(([k, v]) => `\t\t<key>${esc(k)}</key>\n\t\t<string>${esc(v)}</string>`)
        .join("\n")}\n\t</dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${esc(spec.label)}</string>
	<key>BundleProgram</key>
	<string>${esc(spec.bundleProgram)}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
${env}	<key>StandardOutPath</key>
	<string>${esc(spec.stdoutPath)}</string>
	<key>StandardErrorPath</key>
	<string>${esc(spec.stderrPath)}</string>
</dict>
</plist>
`;
}
