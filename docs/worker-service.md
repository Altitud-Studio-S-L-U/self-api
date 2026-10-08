# Operate a persistent worker

Keepseam Client `0.0.0` is a private package with the existing `plumber` package and command names. The foreground `worker-service` runner observes registered subscriptions continuously. The operating system starts it at boot and restarts it after a process failure: systemd on Linux, launchd on macOS, and Windows Service Control Manager through WinSW on Windows. Importing the SDK or rendering a manifest installs nothing.

The service proposes review jobs and optionally synchronizes approved metadata to Cloud. It does **not** approve, execute or publish changes, load a model, install SDK updates, run consumer scripts or download executables. Validation and publication retain their separate local approval flows.

## Prepare the installation

1. Install a reviewed, pinned package artifact and Node.js 24.11.1–24.x in a stable location. The package remains private; there is no public-registry installation claim. For OpenAPI, provision the pinned oasdiff executable using the existing engine procedure.
2. Create a dedicated account and private local state directories outside every consumer checkout. Give the account read access to subscribed contracts and consumer source, and write access only to its state. Store immutable application files and service definitions in administrator-controlled locations. Do not run the worker as root or LocalSystem.
3. Register the intended [OpenAPI and source subscriptions](local-workflow.md#persist-local-subscriptions-and-observe-once) under that account. Start neither profile with an empty subscription store. HTTP sources require their own explicit origin policies as well as the service's `allowHttp` opt-in.
4. Save and validate the configuration below. Run it in the foreground under the intended identity before installing the generated definition in the native manager.

The Windows manifest uses the built-in **LocalService** identity without a password. Other services using that identity share its permissions; use a separate host or review a dedicated managed-account deployment where that boundary is insufficient. Windows PowerShell 5.1 is used only for read-only DACL inspection. The package adds no npm service-wrapper dependency. WinSW is an externally installed, operator-reviewed Windows prerequisite with an MIT license; see [its official releases](https://github.com/winsw/winsw/releases).

Resolve the installed CLI through its public export, rather than coupling your application to a build directory:

```sh
node --input-type=module -e "import { fileURLToPath } from 'node:url'; console.log(fileURLToPath(import.meta.resolve('plumber/cli')))"
node -p "process.execPath"
```

Use those absolute paths for `--cli` and `--node`. Native managers run that Node executable directly; no shell, package manager, profile script or automatic update command is involved.

## Configuration

This example enables both observation profiles. Remove a profile if it has no registered subscriptions. Use drive-qualified backslash paths, escaped as JSON, on Windows.

```json
{
  "schemaVersion": 1,
  "statePath": "/var/lib/keepseam/state",
  "allowHttp": false,
  "openApi": {
    "enginePath": "/opt/keepseam/bin/oasdiff",
    "intervalMs": 60000
  },
  "sources": {
    "intervalMs": 900000
  }
}
```

| Parameter | Contract |
| --- | --- |
| `schemaVersion` | Required, exactly `1`; unknown fields are rejected |
| `statePath` | Required absolute local directory containing existing registrations; no symlinks, UNC, device paths or path traversal |
| `allowHttp` | Boolean, defaults to `false`; enables only already registered HTTPS source policies |
| `openApi` | Optional; requires `enginePath`; interval defaults to 60,000 ms |
| `sources` | Optional; observes registered MCP catalogs, JSON schemas/examples and documents; interval defaults to 900,000 ms |
| `cloud` | Optional explicit metadata sharing, described below |
| `intervalMs` | Each profile accepts an integer from 1,000 to 3,600,000; delay begins after the completed operation |

At least one observation profile is required. Configuration is read once and normalized into an immutable value. Change it through a reviewed file update followed by a service restart. There is no hot reload. The JSON file is limited to 64 KiB and contains no shell commands, code-loading hooks or inline credentials. The standalone runner currently supports public HTTPS documentation: provider authentication callbacks remain available through the SDK and are not loaded from this JSON profile.

Optional `cloud` configuration:

```json
{
  "credentialsPath": "/etc/keepseam/cloud-credentials.json",
  "statePath": "/var/lib/keepseam/cloud",
  "integrationIds": ["replace-with-an-approved-64-character-local-subscription-id"],
  "intervalMs": 60000
}
```

This is a fragment for the top-level `cloud` field; the example ID must be replaced with an actual lowercase SHA-256 local subscription ID. Cloud currently projects the OpenAPI job workflow, so `openApi` must also be enabled. Enroll and bind that installation with the [Cloud connection procedure](local-workflow.md#connect-an-approved-worker-to-cloud). Provision the separate Cloud state directory before starting. The credential file contains the existing `CloudCredentials` object, is limited to 16 KiB, and remains under customer control. Never embed its contents in a service definition, command arguments, repository, status record or log. Load credentials into a private file using the customer's secret manager; restarting reloads them.

POSIX state/credentials must have no group or other access (`0700` directories, `0600` files); configuration must not be group/world writable. Windows checks native DACLs: private state, database/runtime files and credentials may allow only the current service identity, SYSTEM and Administrators. Ownership must also belong to those identities. Configuration can allow other read-only access. Provision inherited ACLs **before** registration, or explicitly review and correct the existing descendants. The runner inspects these permissions and refuses unsuitable paths; it does not silently change them. It rejects hard-linked runtime files and directory symlinks/junctions. Same-account or administrator tampering is outside this boundary.

## Run and inspect

```sh
plumber worker-service run --config /etc/keepseam/worker.json
plumber worker-service status --config /etc/keepseam/worker.json
plumber worker-service stop --config /etc/keepseam/worker.json
```

`run` stays in the foreground until SIGINT, SIGTERM or a private run-specific stop request. `status` prints `{ status, liveness }`; it is a durable snapshot, **not** evidence that its PID is still alive. Use the native manager for authoritative process status. `stop` writes a request for the observed random `runId`, checks it at most one second later, cancels in-flight HTTP work and drains the current observer/sync. A marker for a crashed process never stops its replacement. Run these local commands as the service identity. With Windows LocalService, use SCM/WinSW management commands from an administrator session; the wrapper requests Ctrl+C/SIGINT and bounds the shutdown wait.

The runner serializes observation and Cloud sync. Failures back off exponentially to the greater of five minutes or the configured interval, without duplicating evidence or granting approval. Authentication/installation rejection disables further Cloud attempts until an operator repairs the enrollment and restarts; local observation continues. An optional abort signal also cancels the Cloud transport while retaining unacknowledged outbox entries.

`worker-service.sqlite3` holds a separate exclusive SQLite transaction for the process lifetime. A second service against the same physical state fails; the OS releases the lock after termination. It is not a PID-file lease and never deletes a purported stale PID file. Existing subscription/execution leases still protect explicit one-shot operations and uncertain work. Store this database on a local filesystem, not a shared volume across hosts. One state directory belongs to one host/installation.

`worker-service.status.json` contains only run ID, PID, lifecycle state, timestamps, cycle count and observation/Cloud enums. `worker-service.log` and `worker-service.previous.log` retain at most 1 MiB each, with counts and sanitized outcomes only. They exclude code, documents, URLs, keys, raw errors and observer results. A crash can leave one small `.next` record, reused on the next write. These limits apply to service logs, not the existing subscription/evidence stores; monitor their documented quotas and disk space separately.

This is process supervision, **not a hung-process watchdog**. A slow batch delays later profiles and Cloud heartbeats. The Cloud can show a stale/offline status during a long local observation; it does not attest that all providers were just checked. Split large dependency sets across separately registered installations if their measured duration exceeds the required cadence. The native manager allows 180 seconds for shutdown, after which it may terminate the process; normal store recovery handles an interrupted observation. It does not replay an uncertain approved execution.

## Linux: systemd

Create the non-root `keepseam` account using the host's account-management procedure. Put state in `/var/lib/keepseam`, binaries in `/opt/keepseam` and configuration in `/etc/keepseam`; the generated sandbox deliberately hides home directories and gives private temporary storage. Consumer sources must be readable outside those hidden locations.

```sh
plumber worker-service render --config /etc/keepseam/worker.json \
  --target systemd --node /usr/bin/node --cli /opt/keepseam/installed-cli.js \
  --user keepseam > keepseam.service
sudo systemd-analyze verify keepseam.service
sudo install -m 0644 keepseam.service /etc/systemd/system/keepseam.service
sudo systemctl daemon-reload
sudo systemctl enable --now keepseam.service
sudo systemctl status keepseam.service
```

Replace `installed-cli.js` with the resolved public CLI export path before rendering. The definition uses `Restart=on-failure`, a 30-second restart delay and five starts per five minutes. Repeated startup failures need an operator to correct the cause and run `systemctl reset-failed keepseam` before restarting. Configuration/consumer files are read-only in the service namespace; only the state directories are writable. `NoNewPrivileges`, private temporary storage, core-dump denial and journal rate limits are included. This does not turn Node or the host into an execution sandbox for arbitrary consumer code.

Stop with `sudo systemctl stop keepseam`; restart after a reviewed package/config update with `sudo systemctl restart keepseam`. Remove boot activation with `sudo systemctl disable --now keepseam`. Keep state through upgrade or rollback. Inspect `journalctl -u keepseam` for startup errors; journal-wide disk retention remains an operator setting. [systemd service semantics](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) and [execution settings](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).

## macOS: launchd

Provision a dedicated non-root account and stable readable installation, configuration and private state directories using the organization's macOS administration procedure. Use a system LaunchDaemon when observation must continue without a logged-in desktop user.

```sh
plumber worker-service render --config /etc/keepseam/worker.json \
  --target launchd --node /usr/local/bin/node --cli /opt/keepseam/installed-cli.js \
  --user keepseam > com.keepseam.keepseam.plist
plutil -lint com.keepseam.keepseam.plist
sudo install -o root -g wheel -m 0600 com.keepseam.keepseam.plist /Library/LaunchDaemons/com.keepseam.keepseam.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.keepseam.keepseam.plist
sudo launchctl print system/com.keepseam.keepseam
```

Replace Node/CLI paths with the actual installation. `RunAtLoad` starts at boot; `KeepAlive.SuccessfulExit=false` restarts a crashed/nonzero-exit process with throttling. It does not daemonize or fork itself. Stop/unload with `sudo launchctl bootout system /Library/LaunchDaemons/com.keepseam.keepseam.plist`; bootstrap it again after a reviewed update. The app's private rotating logs retain operational results; launchd's stdout/stderr destinations are `/dev/null` to avoid unbounded files. A startup failure before state can be opened is diagnosed through `launchctl print` and a foreground invocation as the intended account. [Apple's launchd contract](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

## Windows: Service Control Manager and WinSW

A Node executable does not implement the Windows service entry-point contract. The generated XML targets **WinSW 2.12.0**, installed separately from its official release, not a scheduled task or a hidden detached Node process. Review the wrapper's provenance, pin its exact bytes in your deployment process and test upgrades before replacing it. The manifest performs no downloads.

Provision `C:\ProgramData\Keepseam\state` with LocalService (`S-1-5-19`), SYSTEM and Administrators access only, set an allowed owner, and ensure its existing files inherit equivalent restrictions. Give LocalService read/execute access to Node and the installed package, read access to configuration, consumer sources and the optional credential file, and write access to state only. The credential file's allowed ACL must remain restricted to the three identities. Do not reuse an application directory with broad write permissions.

Render in PowerShell, preserving UTF-8:

```powershell
plumber worker-service render --config 'C:\ProgramData\Keepseam\worker.json' `
  --target windows --node 'C:\Program Files\nodejs\node.exe' `
  --cli 'C:\Program Files\Keepseam\installed-cli.js' |
  Set-Content -LiteralPath 'C:\Program Files\Keepseam\keepseam.xml' -Encoding utf8
```

Replace the CLI path with the resolved installed export. Put the pinned wrapper beside this XML with the matching name `keepseam.exe`. From an administrator PowerShell session:

```powershell
& 'C:\Program Files\Keepseam\keepseam.exe' install
& 'C:\Program Files\Keepseam\keepseam.exe' start
& 'C:\Program Files\Keepseam\keepseam.exe' status
& 'C:\Program Files\Keepseam\keepseam.exe' stop
```

SCM starts the service automatically with delayed start, as LocalService. Recovery waits 30 seconds, then 60 seconds, then five minutes for later failures. WinSW requests Ctrl+C/SIGINT and waits up to 180 seconds before forced termination; the CLI registers handlers before configuration preflight. The XML deliberately omits `stoparguments`: that WinSW 2.12.0 branch does not enforce its configured stop timeout. Wrapper stdout/stderr logs rotate at 1 MiB with two archives each; wrapper/OS diagnostic events have their own retention. `restart` applies reviewed changes; `uninstall` removes service registration after stopping and preserves the customer state. No interactive desktop is requested. [Windows service entry point](https://learn.microsoft.com/en-us/windows/win32/services/service-entry-point), [WinSW configuration](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md), [WinSW shutdown implementation](https://github.com/winsw/winsw/blob/v2.12.0/src/WinSW/WrapperService.cs), [WinSW log rotation](https://github.com/winsw/winsw/blob/v2.12.0/doc/loggingAndErrorReporting.md).

## Upgrade and acceptance

Stop the native service, preserve private state and immutable approval/recovery records, verify the chosen package/engine artifacts, update the pinned executable paths and restart. Do not reset Cloud sequence/outbox state or reinstall into another machine's state directory. Test a rollback on a copy of the deployment; schema compatibility determines whether an older version can read newer state. There is no automatic upgrade or database downgrade.

Unit/package tests cover strict configuration, manifest escaping, permissions, singleton exclusion, crash release, unchanged-evidence deduplication, bounded logs and draining cancellation. A separate disposable-runner acceptance job installs an isolated service on Windows, Linux and macOS, exercises actual observation, forces process loss, checks native restart, stops and explicitly restarts it, then removes only its own service and fixture. Rendering XML/a unit file alone is not an installed-service test. No service is installed on a developer workstation by this test command.
