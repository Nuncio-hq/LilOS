import Foundation
import ServiceManagement

// lilos-svc — CLI inside LilOS.app's Contents/MacOS that drives SMAppService
// for the launch-agent plists in Contents/Library/LaunchAgents.
//
//   lilos-svc register    <plistName>
//   lilos-svc unregister  <plistName>
//   lilos-svc status      <plistName>
//   lilos-svc open-settings
//
// register() associates the item with the enclosing app bundle; status reads
// back the persisted BTM registration (.notFound/.notRegistered/.enabled/
// .requiresApproval). Ported from spikes/21-smappservice (SP1).

func statusName(_ status: SMAppService.Status) -> String {
  switch status {
  case .notRegistered: return "notRegistered"
  case .enabled: return "enabled"
  case .requiresApproval: return "requiresApproval"
  case .notFound: return "notFound"
  @unknown default: return "unknown(\(status.rawValue))"
  }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  fputs("usage: lilos-svc <register|unregister|status|open-settings> [plistName]\n", stderr)
  exit(64)
}

if args[1] == "open-settings" {
  SMAppService.openSystemSettingsLoginItems()
  exit(0)
}

guard args.count >= 3 else {
  fputs("usage: lilos-svc \(args[1]) <plistName>\n", stderr)
  exit(64)
}

let service = SMAppService.agent(plistName: args[2])

switch args[1] {
case "register":
  do {
    try service.register()
    print("ok \(args[2]) status=\(statusName(service.status))")
  } catch {
    fputs("register failed for \(args[2]): \(error.localizedDescription)\n", stderr)
    exit(1)
  }
case "unregister":
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
  print("ok \(args[2]) status=\(statusName(service.status))")
case "status":
  print("\(args[2]) status=\(statusName(service.status))")
default:
  fputs("unknown command: \(args[1])\n", stderr)
  exit(64)
}
