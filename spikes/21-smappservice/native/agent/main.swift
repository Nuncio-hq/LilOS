import Foundation

// Dummy background service for issue #21 (SMAppService spike).
// Writes a heartbeat line every 5 seconds to
//   ~/Library/Logs/LilOSSpike/<AGENT_NAME>.log
// and to stdout (which launchd routes to the plist's StandardOutPath).
// AGENT_NAME and SPIKE_VERSION are generated per build in agent_config.swift.

let logDir = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Logs/LilOSSpike", isDirectory: true)
try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
let logURL = logDir.appendingPathComponent("\(AGENT_NAME).log")

func heartbeat() {
  let now = ISO8601DateFormatter().string(from: Date())
  let execPath = CommandLine.arguments[0]
  let uptime = Int(ProcessInfo.processInfo.systemUptime)
  let line = "\(now) | \(AGENT_NAME) | v\(SPIKE_VERSION) | pid=\(ProcessInfo.processInfo.processIdentifier) | exec=\(execPath) | uptime=\(uptime)s\n"
  FileHandle.standardOutput.write(line.data(using: .utf8)!)
  if let h = try? FileHandle(forWritingTo: logURL) {
    h.seekToEndOfFile()
    h.write(line.data(using: .utf8)!)
    try? h.close()
  } else {
    try? line.data(using: .utf8)?.write(to: logURL)
  }
}

heartbeat()
while true {
  Thread.sleep(forTimeInterval: 5)
  heartbeat()
}
