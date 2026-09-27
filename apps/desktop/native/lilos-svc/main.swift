import Foundation
import ServiceManagement

// lilos-svc — CLI inside LilOS.app's Contents/MacOS that manages the launch
// agents declared by plists in Contents/Library/LaunchAgents.
//
//   lilos-svc register    <plistName>
//   lilos-svc unregister  <plistName>
//   lilos-svc status      <plistName>
//   lilos-svc spawned     <plistName>   (launchd job state: running/spawn failed/absent)
//   lilos-svc open-settings
//
// Two backends, chosen by the enclosing bundle's signature:
//  - Developer ID (production): SMAppService — the plist registers as a real
//    background item (System Settings approval, managed lifecycle).
//  - ad-hoc ("unsigned (dev)"): ~/Library/LaunchAgents + `launchctl
//    bootstrap`. BTM's launch constraints are keyed to a stable signing
//    identity; ad-hoc builds get a new cdhash per build, so a bundle swap
//    leaves the agent spawn-failing with OS_REASON_CODESIGNING forever.
//    Bootstrapping the same agent by absolute Program path has no constraint
//    and survives swaps — correct semantics for dev builds, which never need
//    the Background Items approval step anyway.
//
// Ported from spikes/21-smappservice (SP1); bootstrap fallback added for #35.

func statusName(_ status: SMAppService.Status) -> String {
  switch status {
  case .notRegistered: return "notRegistered"
  case .enabled: return "enabled"
  case .requiresApproval: return "requiresApproval"
  case .notFound: return "notFound"
  @unknown default: return "unknown(\(status.rawValue))"
  }
}

let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let bundle = exe.deletingLastPathComponent().deletingLastPathComponent()
  .deletingLastPathComponent().path
let uid = getuid()

func run(_ path: String, _ args: String...) -> (Int32, String) {
  let p = Process()
  let pipe = Pipe()
  p.executableURL = URL(fileURLWithPath: path)
  p.arguments = args
  p.standardOutput = pipe
  p.standardError = FileHandle.nullDevice
  do {
    try p.run()
    p.waitUntilExit()
  } catch {
    return (-1, "")
  }
  let out =
    String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  return (p.terminationStatus, out)
}

func isAdHoc() -> Bool {
  let p = Process()
  let pipe = Pipe()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
  p.arguments = ["-dv", bundle]
  p.standardOutput = FileHandle.nullDevice
  p.standardError = pipe
  do {
    try p.run()
    p.waitUntilExit()
  } catch { return false }
  let out =
    String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  return out.contains("adhoc") || out.contains("Signature=adhoc")
}

func label(for plistName: String) -> String {
  plistName.replacingOccurrences(of: ".plist", with: "")
}

func jobPath(_ plistName: String) -> String {
  "gui/\(uid)/\(label(for: plistName))"
}

/// launchctl print job state, or nil when the job is absent.
func jobState(_ plistName: String) -> String? {
  let (code, out) = run("/bin/launchctl", "print", jobPath(plistName))
  guard code == 0 else { return nil }
  var fallback: String?
  for line in out.split(separator: "\n") {
    let t = line.trimmingCharacters(in: .whitespaces)
    if t.hasPrefix("job state = ") { return String(t.dropFirst(12)) }
    if t.hasPrefix("state = ") { fallback = String(t.dropFirst(8)) }
  }
  return fallback
}

/// Wait until launchd no longer reports the job (teardown is asynchronous;
/// re-registering in that window pins a stale launch constraint).
func waitJobGone(_ plistName: String) {
  for _ in 0 ..< 200 where jobState(plistName) != nil { usleep(100_000) }
}

// ------------------------- bootstrap (ad-hoc) backend ----------------------

/// Render the bundled SMAppService plist as a plain user agent plist under
/// ~/Library/LaunchAgents: BundleProgram (bundle-relative) becomes an
/// absolute Program path, which launchd resolves fresh on every spawn.
func bootstrap(_ plistName: String) {
  let bundled = "\(bundle)/Contents/Library/LaunchAgents/\(plistName)"
  guard
    let dict = NSMutableDictionary(contentsOfFile: bundled),
    let rel = dict["BundleProgram"] as? String
  else {
    fputs("register: cannot read bundled plist \(bundled)\n", stderr)
    exit(1)
  }
  dict.removeObject(forKey: "BundleProgram")
  dict["Program"] = "\(bundle)/\(rel)"
  let home = FileManager.default.homeDirectoryForCurrentUser
  let dir = home.appendingPathComponent("Library/LaunchAgents")
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let dest = dir.appendingPathComponent(plistName)
  dict.write(to: dest, atomically: true)
  let spec = jobPath(plistName)
  let (bc, _) = run("/bin/launchctl", "bootstrap", "gui/\(uid)", dest.path)
  if bc != 0 {
    _ = run("/bin/launchctl", "bootout", spec)
    _ = run("/bin/launchctl", "bootstrap", "gui/\(uid)", dest.path)
  }
  print("ok \(plistName) status=enabled")
}

func bootout(_ plistName: String) {
  let spec = jobPath(plistName)
  _ = run("/bin/launchctl", "bootout", spec)
  waitJobGone(plistName)
  let home = FileManager.default.homeDirectoryForCurrentUser
  let dest = home.appendingPathComponent("Library/LaunchAgents/\(plistName)")
  try? FileManager.default.removeItem(at: dest)
}

// ------------------------------- entrypoint --------------------------------

let args = CommandLine.arguments
guard args.count >= 2 else {
  fputs("usage: lilos-svc <register|unregister|status|spawned|open-settings> [plistName]\n", stderr)
  exit(64)
}

if args[1] == "open-settings" {
  if !isAdHoc() { SMAppService.openSystemSettingsLoginItems() }
  exit(0)
}

guard args.count >= 3 else {
  fputs("usage: lilos-svc \(args[1]) <plistName>\n", stderr)
  exit(64)
}

let adhoc = isAdHoc()
let service = SMAppService.agent(plistName: args[2])

switch args[1] {
case "register":
  if adhoc {
    // Purge any stale SMAppService registration for this label so the label
    // doesn't collide with the bootstrapped agent.
    service.unregister { _ in }
    bootstrap(args[2])
    exit(0)
  }
  do {
    try service.register()
    print("ok \(args[2]) status=\(statusName(service.status))")
  } catch {
    fputs("register failed for \(args[2]): \(error.localizedDescription)\n", stderr)
    exit(1)
  }
case "unregister":
  if adhoc { bootout(args[2]) }
  let sema = DispatchSemaphore(value: 0)
  var unregisterError: Error?
  service.unregister { error in
    unregisterError = error
    sema.signal()
  }
  _ = sema.wait(timeout: .now() + 15)
  if let error = unregisterError {
    fputs("unregister failed for \(args[2]): \(error.localizedDescription)\n", stderr)
    exit(1)
  }
  // SMAppService reports done before launchd has torn the job down and
  // dropped its BTM record; a register() in that window pins the job to a
  // stale launch constraint (spawn fails OS_REASON_CODESIGNING). Wait until
  // launchd actually forgets the job before returning.
  waitJobGone(args[2])
  usleep(300_000) // BTM's own record removal trails the job teardown.
  print("ok \(args[2]) status=\(statusName(service.status))")
case "status":
  if adhoc {
    print("\(args[2]) status=\(jobState(args[2]) != nil ? "enabled" : "notRegistered")")
    exit(0)
  }
  print("\(args[2]) status=\(statusName(service.status))")
case "spawned":
  print("\(args[2]) \(jobState(args[2]) ?? "absent")")
default:
  fputs("unknown command: \(args[1])\n", stderr)
  exit(64)
}
