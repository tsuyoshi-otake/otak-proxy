# Change Log

## [Unreleased]

### Security
- Release pipeline hardening: the invisible-Unicode scanner no longer skips a text file because it contains a NUL byte, fails when a run scans zero files, covers the full Unicode 16.0 Default_Ignorable code point table plus U+2800, and gains a `--dir` mode that CI and the publish workflow use to scan the packaged VSIX itself, not only its sources. The scanner no longer trusts file extensions: a binary file is skipped only when its content carries the PNG or MP3 signature, a file that cannot be read or a directory entry that is not a regular file fails the scan, and a repository-mode candidate that is missing from the working tree is reported as missing instead of silently ignored. The publish workflow now runs only on pushed `v*` tags: it verifies the tag matches `package.json` and sits on `main`, checks both registry tokens before anything publishes, pins every action to a commit SHA, publishes the same artifact to each registry in its own job, and no longer passes `--skip-duplicate`, so re-publishing an existing version fails instead of passing silently. Pull requests now run the same lint, tests, packaging and dependency audit in CI, and Dependabot proposes weekly npm and GitHub Actions updates with a three-day cooldown (#108).

### Fixed
- Switching Off no longer says "Proxy disabled" while a value is still there. When a proxy URL with credentials is still in Git, VS Code or npm and the record that proves otak-proxy wrote it (or the key that checks its password) is missing, Off keeps the value as before but now shows a warning that names it, the status bar shows ⚠ instead of the clean Off icon, and the README Troubleshooting entry lists both remedies. A value you changed yourself is still kept silently (#108).
- Off now reads npm's user config file only. A proxy that is set in a global or project `.npmrc`, or in the same value in both the user and the global layer, no longer makes Off report the npm target as failed: the user value is removed, the other layer is left alone, and the result is shown as an external override. A missing user config file counts as nothing to remove (#108).
- A per-scheme proxy no longer shows "only partly applied" for the bypass list alone: the warning is shown only when Git or VS Code cannot store the separate HTTP and HTTPS URLs (#108).
- Credential consent no longer holds up the proxy toggle. The apply that needs your answer now stops at once with `Auto (blocked)` in the status bar and the prompt is shown on its own; Allow records your consent and applies the current proxy once, Deny leaves it blocked, and a second apply while the prompt is open neither waits for it nor shows a second prompt. Switching Off while the prompt is open clears the blocked state. Reloading the window drops an open prompt, and the blocked state stays until the next apply (#108).
- A success message that differs only in its parameter (for example two different proxy URLs configured within seconds) is no longer dropped as a duplicate (#108).
- Monitor settings that are not valid numbers no longer stop or flood the monitor. A `pollingInterval`, `testInterval` or `maxRetries` that is not a number (for example `"60"` in a workspace file) falls back to its default, and a fractional or out-of-range `maxRetries` is rounded down and limited to 0 to 10; a NaN `maxRetries` used to keep the all-retries-failed warning from ever appearing (#108).
- The hostname error now lists underscores (`only alphanumeric, dots, hyphens, and underscores allowed`), matching what the validator accepts, and the localized text follows (#108).
- A refused or unreachable proxy is now recognized as unreachable inside VS Code, so Auto turns OFF as designed. The connection test used VS Code's patched HTTP stack, which could send the test through the proxy in `http.proxy` instead of the proxy under test; it now opens its own TCP or TLS connection to the proxy. A malformed or oversized CONNECT response from the proxy is now reported as a protocol failure instead of an unknown one (#108).
- A busy window no longer ignores proxy changes published by another window. Cross-window ordering now uses the shared sync file's version instead of each window's own revision counter: a window that ran many connection tests used to drop a quieter window's toggle because its own counter was ahead, and the quiet window's publications were discarded for the same reason. Deliveries are adopted in the order they were published and applied one at a time, and a delivery superseded by this window's own newer publication is skipped instead of rolling it back (#108).
- Monitoring no longer silently fails to start when the stored proxy state has no revision (for example after a fresh install or a migration) or when an unrelated commit lands while monitoring is starting (#108).
- The proxy toggle now persists the new mode. Off → Auto saves `auto` and starts monitoring, and Auto → Off saves `off`, so the status bar no longer shows the pre-toggle mode and a window reload no longer restores it. The apply's own bookkeeping write used to make the toggle discard the mode it had just chosen. If an earlier version left the saved mode out of step (for example `auto` after turning the proxy off), the first start after updating applies that saved mode; toggle once to bring it in line. When the saved state keeps changing while the toggle saves the new mode, the toggle now shows the "toggle failed" error and changes nothing, instead of silently doing nothing. A different mode or proxy that another window saved in the meantime is not a failure: the toggle keeps the other window's mode, or decides again for the new proxy (#78).
- During a toggle, diagnostics now see the new mode, so Off → Auto no longer reports the proxy it just wrote as a leftover and no longer runs a needless convergence retry (#78).
- The first-run setup answer is no longer discarded when the startup apply finishes while the prompt is open. An answer that still could not be saved — the saved state kept changing through every save attempt — is now reported with an error instead of being silently dropped, and the setup is offered again at the next start (#78).
- The startup proxy enforcement no longer applies the same proxy up to three times: it now re-runs only when the proxy state actually changed during the apply (#78).
- Proxy URLs that a browser URL parser accepts but the extension rejected are now picked up: a trailing `/` (for example `HTTP_PROXY=http://proxy.corp.com:8080/`), underscores in host names such as Docker service names (`http://squid_proxy:3128`), and a literal `%` in credentials (`http://user:100%@proxy:8080`) no longer make detection report "no proxy", and a saved per-scheme proxy URL with credentials no longer fails validation after a window reload. Entered and detected URLs are converted to one canonical form (lower-case scheme, no trailing `/`), and an upper-case scheme such as `HTTP://` now gets the same host and credential checks as a lower-case one. A `%` in a password is no longer corrupted when the password is read back from secret storage (#108).
- Apply results are now recorded against the same state the apply was planned for. When another window committed a newer proxy state between the apply's generation check and its result write, the result used to land on the newer state anyway, which also made that state's own apply look superseded; the stale result commit is now discarded instead (#108).
- Credential consent and `otakProxy.credentialTargetPolicy` now judge every URL an apply writes, not just the primary one. A per-scheme proxy whose HTTPS URL carried credentials (for example `HTTP_PROXY=http://proxy:3128` with `HTTPS_PROXY=http://user:secret@proxy:3128`) wrote that credential to `.npmrc` and the terminal environment without asking and bypassed `blockPlaintextTargets`. The split credentials are now kept in SecretStorage like the primary URL's, so they survive a window reload, and the apply is skipped on machines where they cannot be restored — per address, so a per-scheme proxy is refused when any address that needed credentials cannot restore them on this machine, and a credential-free proxy is no longer refused only because another saved URL (such as the manual fallback) carries credentials. The skip covers every apply — monitor, toggle, and sync — not only the startup check. A VS Code `http.proxy` value is treated as otak-proxy's own write when it names the same proxy with the same credentials or names the same proxy address without credentials (the extension's own detection write carries none), while a value for the same proxy with different or added credentials is detected again instead of being ignored (#108).
- Proxy passwords no longer leak into error notifications, the status bar tooltip, the Output channel, logs, or the Configure Manual Proxy input box. A failed Git, npm, or pip write could report its command line — including a credential-bearing URL — in the notification and in `lastError`; those errors are now masked before they leave the config managers, and the error aggregator masks every error at ingestion, so `lastError` — the text behind the tooltip and notifications — never holds a password, not only its persisted copy. Masking now also catches every credential in a message instead of only the first, credentials embedded in text right after `/`, `:` or `@`, passwords that contain an unencoded `/`, `?` or `#`, passwords that contain whitespace, an all-digit password that a TAB or line break (dropped by the URL parser) or a raw `/`, `?` or `#` would otherwise turn into a displayed port number (`http://user:8080<TAB>#@proxy`), a token-like username with an empty password in a message (`http://token:@proxy:8080`), and Windows `DOMAIN\user:pass@proxy` authorities that a URL parser rewrites into the path. The Configure command prefills the credential-free URL; resubmitting it unchanged keeps the stored credentials, entering different credentials replaces them, and a different credential-free URL stores none. An invalid `otakProxy.proxyUrl` value in settings.json is now rejected with the invalid-URL error instead of being saved and synced to other windows. The same validation now runs on every read of the setting, so an invalid saved value is ignored there and logged once per activation; the one-time v3 settings migration also ignores an invalid `otakProxy.proxyUrl` (nothing is stored in SecretStorage and the setting is not rewritten). Replacing a credential-bearing fallback through settings.json no longer leaves a stale credential-requirement marker that would skip the credential-free fallback (#108).
- On multi-user Linux/BSD machines, another user's otak-proxy locks no longer break proxy applies or wedge Git writes: locks now live under a per-user temp directory (`<temp>/otak-proxy-<uid>`, mode 0700) instead of one shared directory whose first user's permissions locked everyone else out. A lock directory the extension cannot use now reports a normal apply failure (stop reason `lockIoError`) or a Git permission error instead of an internal error or an endless retry. Until every window of the same user has restarted after the update, an old and a new window do not exclude each other's writes (#108).
- Auto proxy detection at startup and on switching to Auto now applies per-scheme and bypass-list changes that keep the same primary proxy URL, and shows the same "system proxy changed" notification as the system-proxy monitor. A change only in a single proxy's own HTTP and HTTPS copies (without a bypass list), which the apply does not use, no longer re-applies there, as on the monitor path (#108).
- A failed system proxy query is no longer treated as "no proxy". When the Windows registry query, `gsettings`, or `networksetup` fails or times out, detection now reports an unknown result instead of removing the proxy: in Auto mode the last known proxy stays applied to Git, npm, VS Code, and the terminal, no fallback is engaged, the background check retries with backoff and warns after the last retry, `otak: Import System Proxy` says that detection failed, toggling from Off to Auto keeps Off and warns instead of engaging the fallback, and the first-run Auto setup offers to configure a proxy or re-detect and otherwise (also when the URL prompt is cancelled) asks again on the next start instead of finishing as "no proxy". A missing Windows `Internet Settings` key (English `reg` message), a missing `gsettings`, a missing GNOME proxy schema or an empty schema registry (non-GNOME desktops, CI) is still "no proxy", and `gsettings` runs with `LANGUAGE=C` so that this is recognized on a non-English desktop. On macOS a failed query on a listed network service is unknown unless some service has a manual proxy; fallback service names are ignored unless every query fails, and a successful list with no enabled service is "no proxy" (#108).
- A Windows `ProxyServer` such as `host:8080;` or `http=a:80 https=b:80` is now read correctly instead of ending as a silent "no proxy", and the registry `ProxyEnable` and `AutoDetect` flags are read the same way (non-zero number) by proxy detection and by diagnostics. An empty user-level proxy environment variable no longer hides the machine-level value in the Windows environment check (#108).
- A failure while capturing the state generation no longer leaves the proxy monitor stuck on "check already in progress" or leaks an unhandled rejection: that check ends as a failed detection and the next check runs normally; and with the default 30 second polling and 60 second test interval, Auto mode connection tests now run every 60 seconds instead of about every 90 seconds, because the interval is measured from the start of the previous test (#108).

### Changed
- The diagnostics output explains the missing-local-credential and apply-blocked reasons (including the new credential-consent block) and names the Git and npm ownership targets instead of printing their raw ids (#108).
- Translations: 41 strings that were still English in the 14 locales other than Japanese (the Diagnose command and its reasons, automatic-remediation and credential settings, Windows action messages, and the unsupported-auto-config status bar text) are now translated in the 14 locales that still showed English, and the new messages are added in all 16 locales (#108).
- The connection test of an `https://` proxy no longer reads the operating system's certificate store through VS Code's default certificate handling. An `https://` proxy whose certificate chains only to a CA in the OS store now reports a TLS failure unless VS Code's `http.experimental.systemCertificatesV2` is on (with `http.systemCertificates` on, the default); Node's built-in CA list and `NODE_EXTRA_CA_CERTS` are always trusted. That failure does not turn Auto OFF (#108).
- With several windows open, a sync publication that would write the same proxy settings this window already applied no longer re-applies them: each window keeps a record of the last plan it verifiably applied and skips only the identical rewrite. As a side effect, a hand edit of `.npmrc` or `.gitconfig` made after the last apply now stays until the next real proxy change or local apply instead of being rewritten by the next sync. Any real change — a different URL, a per-scheme HTTPS URL or bypass change, a rotated credential, or a previous attempt that did not write — still applies as before (#108).
- Background checks start fewer processes and read SecretStorage less. The Windows environment check no longer starts PowerShell: it reads the saved variables with two `reg query` calls, skips saved values that contain non-ASCII characters instead of comparing them, and does not run at all while `otakProxy.notificationLevel` is `"off"`. GNOME detection reads all proxy settings with one `gsettings list-recursively org.gnome.system.proxy` call instead of up to five `gsettings get` calls, and each read of the saved proxy state fetches a stored proxy credential from SecretStorage at most once and no longer looks for the legacy manual-proxy key when no manual proxy is set. Detection results are unchanged (#108).

## [3.2.16] - 2026-10-03

### Fixed
- When the system proxy's per-scheme HTTPS URL or bypass list changes while the main URL stays the same, the change is now saved and applied even when the same check also runs a connection test or sees the proxy's reachability change. Before this, the change was discarded in that case, and the previous HTTPS URL or bypass list stayed in effect. In `Auto: OFF` the new values are saved, and applied when the test shows that the proxy answers (#102).

### Changed
- Notifications (#102): when a per-scheme or bypass change arrives in the same check as a connection test, it is applied like any other system proxy change and shows the same notifications ("Proxy configured" and "system proxy changed", or "Proxy disabled" when the test shows that the proxy cannot be reached). This includes a recovery from `Auto: OFF`, which was silent and applied the previous values.

## [3.2.15] - 2026-10-03

### Fixed
- In `Auto: OFF`, Auto now turns back on when a connection test shows that the proxy answers, even with `407`, `403`, or `5xx`, or when the proxy accepts the connection and the test then times out (for an `https:` proxy, only once the TLS handshake has finished). Before this, these results left `Auto: OFF` in place while the proxy was working (#97).
- In `Auto: OFF`, a timeout or DNS failure before the proxy is reached, or a TLS failure, no longer turns Auto back on. Such a result proves nothing about the proxy, so the current state is kept; Auto still turns off only when the proxy cannot be reached at all (#97).
- A reachability change alone no longer turns the proxy back on in `Auto: OFF`. The connection test decides, and when it shows the proxy answering it applies the proxy in the same step, so recovery no longer depends on a later reachability change. Other VS Code windows see the recovery only after the proxy has been applied (#97).
- A system proxy that changes while VS Code is running is now applied. The change was discarded whenever the same check also ran a connection test, so the new proxy was saved but not applied. In `Auto: OFF`, a new system proxy is judged on its own test and starts in Auto unless it cannot be reached; the same proxy written differently, for example with an upper-case host name, is not a new proxy (#97).
- When a connection test shows that the proxy cannot be reached, the managed proxy settings are now removed right after the test, as intended. Before this, that removal never ran and the settings were removed only by the reachability change that followed (#97).
- A connection test of a proxy that is no longer the current one no longer changes the current state (#97).

### Changed
- Notifications (#97): recovery from `Auto: OFF` by a connection test is silent, like the reachability recovery it replaces. A system proxy that changes while VS Code is running now shows "system proxy changed", because it is now applied. In `Auto: OFF`, a detection whose test proves nothing applies nothing and shows no notification.
- README: describe when Auto turns off and back on (#97).

## [3.2.14] - 2026-10-03

### Fixed
- Diagnostics no longer treat npm as having no proxy when `npm config list` fails (for example, npm is not on `PATH` or times out). The failure is reported for information, and the npm mismatch and residual checks are skipped, as for Git (#93).
- In Off, and in `Auto: OFF` without the fallback proxy, a PAC, WPAD, or GNOME auto-config setting no longer makes diagnostics report `partial`. It is still shown for information (#93).
- An empty or truncated apply lock left by a window that stopped mid-write no longer blocks every window forever. It is reclaimed once it is older than the lock lease, and a window that fails to write its new lock removes it (#93).
- When the system proxy's per-scheme HTTPS URL or bypass list changes while the main URL stays the same, the new values are applied and the previous HTTPS URL is no longer kept. In `Auto: OFF` they are saved and applied when a connection test succeeds again; a detection without a test no longer applies the proxy while `Auto: OFF` is shown (#93).
- With a browser-based VS Code UI connected to a remote extension host, diagnostics no longer report every command-based check (Git, npm, and similar) as unavailable. What can run now follows where the extension host runs, not the UI. This is covered by unit tests and has not yet been tried with a real browser UI (#93).

### Changed
- README: describe how diagnostics report unsupported auto-config in Off and a Git or npm config that cannot be read (#93).

## [3.2.13] - 2026-10-03

### Fixed
- Recognize how npm 10.8.0 through 11.6.1 word the refusal to print a proxy URL with credentials ("can not be retrieved"). The npm fix from 3.2.12 now also works there, including with the npm 10 bundled with Node.js 22. Before this, a credentialed proxy written to npm still failed verification on those versions, and Off could not remove it (#88).

### Changed
- README: npm 10.8 and later, not only npm 11, refuse to print a proxy URL with a password (#88).

## [3.2.12] - 2026-10-03

Not published: the release workflow stopped at the unit tests (#88). These changes first ship in 3.2.13.

### Fixed
- In Auto, when the system proxy disappears while VS Code is running (for example after a VPN disconnect), test the configured fallback proxy and use it when it is reachable, as at startup. When it is not reachable, Auto turns off instead of staying on without a proxy (#85).
- Verify and clean up npm proxy URLs that contain credentials. npm 11 refuses to print such values, which made every npm write fail verification and kept Off from removing them. otak-proxy now reads them from the npm user config file, and keeps any value it cannot confirm there (#85).

### Changed
- README: describe the fallback when the system proxy disappears and how npm proxy URLs with credentials are read, and use `npm config list` in Troubleshooting, which masks passwords (#85).

## [3.2.11] - 2026-10-02

### Changed
- Rewrite the README in English only and bring it up to date with the current behavior: pip support, value ownership on Off, the credential target policy, first-run setup, the fallback proxy test, diagnostics, and the VSIX build steps (#81).
- Point the issue template links at the current repository and remove the link to GitHub Discussions, which is not enabled (#81).

## [3.2.10] - 2026-10-02

### Fixed
- Let the bounded remediation retry actually reach the tool settings after the first attempt's own result commit. The retry was previously fenced out as superseded and reported success without writing. The fence now follows only the revision the apply itself reports, so another writer's change, including Auto turning off, still stops the retry (#78).
- Report `runtimeState: partial` instead of `applied` when fresh diagnostics find a convergence-blocking residual or mismatch, and separate the selected state from actual convergence in the diagnostics report (`recordedRuntimeState`, `desired`, `converged`) (#78).

### Added
- Record why each proxy apply stopped (per-target results, whether the retry ran, the stop reason, remaining blocker IDs) without proxy URLs or credentials, and show the latest one as `lastRemediation` in `otak: Diagnose Proxy State`. An older request that finishes late no longer replaces a newer result (#78).

## [3.2.9] - 2026-09-10

### Added
- Notify Windows users when saved `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or `NO_PROXY` values have not reached the current VS Code process, without exposing proxy URLs or credentials (#76).
- Explain that VS Code must be fully restarted and existing terminals reopened before the updated environment takes effect (#76).

## [3.2.8] - 2026-09-09

### Fixed
- Serialize `SharedStateFile.compareAndSwap()` under a publish lease and re-read the version inside the critical section, so two windows that observe the same version can no longer both report `written` (#73).
- Replace the anonymous mtime-based Git config and instance registry mutexes with an owner-token lease (heartbeat renewal, re-read before reclaim, owner-checked release) so a slow holder can no longer delete a successor's lock (#73).
- Make Git and npm proxy write verification fail-closed: an unreadable config, a missing key, or a mismatched value is now reported as a failure instead of success (#73).
- Verify the pip proxy write by reading it back, reporting the key as residual when the written value cannot be confirmed (#73).
- Judge each npm proxy key against the value written to that key, so a split HTTP/HTTPS proxy is no longer mistaken for an external change during partial-write compensation (#73).

### Changed
- Consolidate every cross-process critical section on a single `FileLease` primitive (`src/utils/FileLease.ts`) instead of three separate lock implementations (#73).

## [3.2.7] - 2026-09-05

### Fixed
- Stop treating Git `unset` exit 5 as missing-key success when multi-values remain (#44).
- Compensate leftover Git/npm keys after a partial set so Off can recover them (#43).
- Fence stale async completions with `ProxyState.revision` so a late test or apply cannot mutate a newer generation (#17).
- Re-inspect before Off unsets and preserve external values that no longer match ownership (#46).
- Restore Auto proxy credentials locally after persist/sync instead of applying a credentialless URL (#45).
- Restore WHATWG default ports on CONNECT (`:80` / `:443`) instead of substituting 8080/443 incorrectly (#54).
- Accept WHATWG-bracketed IPv6 proxy URLs and pass an unbracketed hostname to Node `http.request` (#53).
- Pass encoded credentials as a single argv element without `cmd.exe` (#52).
- Write only Git `http.proxy` as the routing key; treat `https.proxy` as leftover and clear it on Off (#55).
- Keep distinct HTTP and HTTPS proxy fields instead of collapsing them to one URL (#56).
- Stop the Off terminal mask from emptying an unowned `NO_PROXY` (#57).
- Report PAC, WPAD, and GNOME auto-config as unsupported instead of applying none (#58).
- Surface apply-blocked (untrusted workspace / invalid URL) instead of painting a false Auto success (#66).
- Classify canary CONNECT failures so only an unreachable proxy endpoint clears Auto (#67).

### Changed
- Align `ARCHITECTURE.md` with the two-state Off ↔ Auto toggle (#68).

## [3.2.6] - 2026-08-15

### Fixed
- Treat a lock file observed while a peer renews its lease as held until it can be read safely, preventing a concurrent apply attempt from reporting a spurious I/O error during an active lock (#42).

## [3.2.5] - 2026-08-15

### Fixed
- Make the logical-clock future-timestamp rejection test robust to the resolver sampling its own clock, while keeping the tested value clearly outside the 30-second contract bound (#42).

## [3.2.4] - 2026-08-15

### Fixed
- Prevent a delayed proxy-detection completion from an earlier monitor lifecycle from publishing a stale result after the monitor has been stopped or restarted (#42).

### Changed
- Add independently defined domain decision oracles, deterministic property-test seed and counterexample replay, atomic-condition coverage, mutation analysis, protocol-compatible boundary contracts, deterministic failure injection, and TLA+/TLC lifecycle and sync verification evidence (#42).

## [3.2.3] - 2026-08-13

### Security
- Reject invisible Unicode code points - variation selectors, tag characters, bidi overrides, zero-width and other non-printing characters - across the sources, every non-ignored repository file, and the compiled artifacts that ship (#37). The GlassWorm campaign hid extension payloads in exactly these code points, which no amount of code review catches; the check now runs as part of `npm run lint` and again before the VSIX is packaged.
- Derive the multi-window temp file suffixes and the instance id fallback from `crypto.randomBytes` instead of `Math.random` (#38).

### Changed
- Replace dynamically constructed regular expressions in the secret redactor, in message parameter substitution, and in Windows registry parsing with literal or static equivalents (#38). Redacted output, substituted messages, and parsed registry values are unchanged; parameter values containing `$`-sequences are now substituted literally instead of being treated as replacement patterns.

## [3.2.2] - 2026-08-01

### Fixed
- Stop re-detecting the extension's own VS Code `http.proxy` write as a system proxy in Auto mode, which shadowed platform detection and kept the status bar arrow spinning after the real proxy disappeared (#23, #29). Detection provenance is now tracked, and the self-written value is suppressed only when it provably matches the applied proxy; the new `otakProxy.ignoreSelfWrittenVSCodeProxy` setting can disable the suppression.
- Wait out another window's apply lock with a bounded retry schedule (~7.75s) instead of skipping the write on the first contended acquire, so the losing window converges normally in multi-window use (#30).

### Changed
- Remove the "another window is already applying proxy settings" warning. After the bounded wait, a warning is shown only when fresh diagnostics still report an issue that blocks convergence, rate-limited per issue (#30).
- Replace the stale UI screenshot in the README with an ASCII status bar reference (#31).

## [3.2.1] - 2026-07-28

### Security
- Redact username-only proxy userinfo, including token-style credentials such as `http://TOKEN@proxy:8080`, from logs, status details, history, persisted errors, shared state, and diagnostics (#27).
- Remove proxy settings only when their current values still match otak-proxy ownership fingerprints; preserve externally owned or externally changed Git, npm, pip, and VS Code values (#27).

### Changed
- Use a bounded 15-second command deadline for Git, npm, and pip configuration writes, with a longer Git lock wait for busy hosts.
- Coalesce concurrent npm runtime diagnostics into one `npm config list --json` read to avoid spawning duplicate npm processes.

### Fixed
- Keep the proxy selected during initial setup active by storing it as the Auto fallback instead of migrating the obsolete Manual mode to an empty Auto state (#27).
- Re-apply an unchanged detected proxy when recovering from Auto OFF or another unconverged target state, including when automatic connection testing is disabled (#27).
- Apply synchronized Auto OFF and Off states to local targets, retain degraded state after partial failures, and include sync changes in bounded remediation retries (#27).
- Re-read state after slow system-proxy detection and serialize adjacent monitor events so newer toggle choices and connection-test metadata are not overwritten (#27).
- Track terminal-environment and per-target convergence explicitly, while treating unavailable optional tools as skipped rather than successfully configured (#27).
- Report toggle and setup apply failures without first publishing a false OFF or success state (#27).
- Retry remediation only for transient timeout or lock failures, while preserving structured configuration error types through aggregation.
- Use a stable Auto idle icon instead of continuously animating the status bar spinner (#27).

## [3.2.0] - 2026-07-26

### Changed
- Detect shared state file changes with OS change notifications on the sync directory instead of polling its stats every 50ms, so idle windows no longer touch the file system continuously (#24).
- Skip the periodic sync read and JSON parse while the shared state file is unchanged, using a stat-based revision signature (#24).
- Refresh the active instance list on the 10 second heartbeat instead of the 1 second sync tick (#24).
- Read the Windows Internet Settings registry key once per detection cycle instead of spawning a separate `reg query` for `ProxyEnable` and `ProxyServer` (#24).
- Back off proxy detection and connection test intervals by 4x while the window is not focused; refocusing restores the configured cadence and still triggers an immediate check (#24).
- Log the connection test scheduler's proxy URL only when it actually changes (#24).

### Fixed
- Avoid an abort inside libuv (`fs-event.c` assertion) when the sync directory path contains an 8.3 short name such as `C:\Users\DEVELO~1`, by resolving the watched directory to its real path before watching it (#24).

## [3.1.6] - 2026-07-06

### Fixed
- Release the toggle command's serialization queue before showing the "no system proxy detected" warning, so an undismissed notification can no longer leave the status bar click and tooltip "Toggle Mode" link unresponsive on a fresh install (#19).

## [3.1.5] - 2026-07-05

### Fixed
- Keep `existing terminals keep their old proxy environment` as a diagnostics advisory without showing default remediation warnings or manual-diagnose info notifications when it is the only issue.

## [3.1.4] - 2026-07-05

### Fixed
- Publish Auto monitoring state changes to the shared sync file, so failed connection tests that enter `Auto: OFF` cannot leave other windows or later reloads with stale reachable Auto state.
- Clear stale Auto OFF/test-result fields when `otak: Import System Proxy` switches back to Auto, and restart monitoring so the newly imported proxy is tested immediately.
- Move otak-proxy status bar items to the left side and keep detailed hover tooltips enabled by default, so tooltips remain available without covering right-side VS Code notifications.

## [3.1.3] - 2026-07-05

### Fixed
- Release cross-window apply locks before showing non-blocking diagnostic notifications, so an undismissed warning can no longer leave other Auto OFF or fallback proxy applies stuck behind `apply-lock-skipped` (#18).

## [3.1.2] - 2026-07-05

### Fixed
- Clear managed Git, npm, VS Code, and terminal proxy settings when an Auto mode startup/focus connection test fails, so `Auto: OFF` no longer leaves tools pointed at an unreachable detected proxy (#18).
- Treat Auto OFF as having no active proxy even when the last detected `autoProxyUrl` is retained for monitoring context, preventing startup/sync paths from re-applying the unreachable URL (#18).
- Report managed residual Git/npm/VS Code proxy settings from `otak: Diagnose Proxy State` when Auto OFF retains the last detected URL, instead of treating that URL as the expected active proxy (#18).

## [3.1.1] - 2026-07-05

### Fixed
- Read the WinHTTP proxy state from the locale-independent `WinHttpSettings` registry binary, so proxy diagnostics no longer fail to parse localized `netsh winhttp show proxy` output on non-English/Japanese Windows (#11).
- Run startup proxy enforcement off the activation critical path via a bounded background reconciliation loop, so a slow diagnostics pass can no longer delay extension activation (#12).
- Localize the `otak: Diagnose Proxy State` output: every notification and target/reason label now resolves through the 16 shipped locale files instead of hard-coded English (#13).
- Preserve every distinct proxy credential during the v2→v3 SecretStorage migration (previously only one survived when several authenticated proxy URLs existed), and warn when duplicates cannot be migrated (#14).
- Key flap-tracker fingerprints on stable proxy identity so rapidly changing proxy values can no longer bypass flap suppression and retry escalation (#15).
- Distinguish a Git config read failure (unparsable `.gitconfig` or missing `git`) from an unset key, so read failures are surfaced as informational instead of triggering retryable convergence mismatches that retries cannot fix (#16).
- Renew the apply-lock lease during long applies and shorten the locked critical section so concurrent windows contend for a shorter time.

### Changed
- The manual `otak: Diagnose Proxy State` command now always reads fresh state, bypassing the slow-diagnostics TTL cache (#16).
- WinINet diagnostics query only the four required registry values individually instead of dumping the entire Internet Settings key (#16).
- Run WinHTTP/WinINet diagnostics wherever the extension host is a Windows host, including Remote-SSH to Windows, not only the local UI host (#16).
- Clarify the diagnostic issue notification wording (#9).
- Remove dead internal API surface: unused `ProxyApplyTrigger` values and the unpopulated `TargetOwnership.previousUserValue` field (#16).

### Security
- Close credential redaction gaps found in the v3 review so authenticated URLs, authorization headers, and tokens are consistently masked in logs and diagnostics.
- Pin the v3 remediation safety settings to machine scope so synced or workspace configuration cannot weaken them.

## [3.0.0] - 2026-07-04

### Added
- Added the v3 diagnostics and safe remediation foundation with sanitized issue reports, execution-context detection, slow diagnostic TTL caching, and the `otak: Diagnose Proxy State` command.
- Added cross-window host/user apply locks plus bounded delayed retry and flap suppression so repeated external rewrites do not create infinite repair loops.
- Added credential-aware SecretStorage migration and local consent controls for authenticated proxy URLs that would be written to plaintext target config files.
- Added terminal environment masking options for proxy Off mode and Windows-aware terminal env handling.
- Added the user-approved `otak: Reset WinHTTP Proxy` command, gated by `otakProxy.windowsActionsEnabled`.

### Changed
- Routed startup, sync, Auto mode, and manual proxy application through the same safe apply path while preserving the existing `ProxyApplier.applyProxy()` boolean API.
- Expanded settings for diagnostics, remediation, notification level, flap thresholds, slow diagnostic TTL, credential target policy, Windows actions, and legacy Auto detection compatibility.

### Security
- Redaction now covers authenticated URLs, authorization headers, Basic auth payloads, npm tokens, Git extra headers, command output, copied diagnostics, control characters, and sync/diagnostic payloads.
- Synchronized/global state continues to store sanitized public proxy data only; local ownership and credential consent are machine-local.

## [2.3.2] - 2026-06-28

### Changed
- Replaced the marketplace icon with the new otak-proxy branding (dark badge with the proxy plug glyph), shipped at 48/128/256/512 px plus SVG

### Documentation
- Rewrote the README using the otak-paste layout: centered header with status badges, capability list, settings table, language support, and a Related Extensions table

## [2.3.1] - 2026-06-20

### Changed
- Bounded `NotificationThrottler` memory: the notification history is now capped (LRU eviction) so it no longer grows with session length when many distinct error messages are surfaced (O(N) retained entries → O(1))
- Skipped log argument sanitization when logging is silenced, avoiding unnecessary serialization/allocation on the hot path
- Avoided a redundant array copy in `ProxyChangeLogger` history getters

### Documentation
- Updated README to cover the `otak: Configure Manual Proxy` command, the automatic connection testing and multi-instance sync features, and the previously undocumented settings (`autoTestEnabled`, `testInterval`, `syncEnabled`, `syncInterval`, `detectionSourcePriority`, `maxRetries`)

## [2.3.0] - 2026-06-19

### Added
- UI language support for all G20 countries, adding 10 new locales (16 total): Spanish (`es`), Brazilian Portuguese (`pt-br`), French (`fr`), German (`de`), Hindi (`hi`), Indonesian (`id`), Italian (`it`), Russian (`ru`), Arabic (`ar`), and Turkish (`tr`). The UI language continues to follow the VS Code display language.

### Changed
- Locale resolution now maps any Portuguese variant (`pt`, `pt-pt`, `pt-br`) to the shipped Brazilian Portuguese translations
- `package.nls.*.json` files for the new locales are generated from `src/i18n/locales/*.json` via `npm run gen:nls`

## [2.2.17] - 2026-06-06

### Changed
- Removed dead `updateDetectionPriority` helper and stale `TestOptions` / `TestUrlError` re-exports from the proxy utility entrypoint; consumers were already using the SystemProxyDetector method or the source modules directly
- Added `knip.json` so dead-code detection reliably distinguishes real unused exports from test-only files

### Fixed
- Restored the missing `[2.2.6]` changelog entry from git history and slimmed the `[2.2.7]` entry back to its own two changes

## [2.2.16] - 2026-06-06

### Changed
- Refactored command, config, monitor, sync, UI, error, and extension modules into focused submodules with no user-visible behavior change

## [2.2.15] - 2026-06-06

### Added
- Added progress feedback while applying or clearing VS Code, Git, npm, and integrated terminal proxy settings

### Changed
- Localized aggregated configuration errors and troubleshooting suggestions

### Fixed
- Improved Git config lock handling with cross-window wait/retry feedback, stale lock cleanup, and throttled lock notifications

## [2.2.14] - 2026-06-05

### Changed
- Refactored extension initialization, proxy application, monitoring, sync, and proxy utility modules into focused submodules with no user-visible behavior change

## [2.2.13] - 2026-06-05

### Fixed
- Started multi-instance sync before applying local startup state so an existing shared state wins on launch
- Stopped clearing unrelated Git, VS Code, and npm proxy settings on startup when otak-proxy is Off
- Tested manual fallback proxies before using them in Auto mode and left Auto mode as `OFF` when fallback is unreachable
- Honored newly detected system proxy state when switching from Manual to Auto
- Sent `Proxy-Authorization` headers during proxy connection tests and treated non-2xx CONNECT responses as failures
- Rejected malformed URL-encoded proxy credentials during validation

## [2.2.12] - 2026-06-05

### Added
- Added `otak: Configure Manual Proxy` to the Command Palette and localized extension descriptions across package NLS files

### Changed
- Localized manual proxy prompts, validation errors, troubleshooting suggestions, system-proxy warnings, and proxy test result messages
- Showed warning messages as temporary status bar messages to reduce notification noise
- Refined Vietnamese UI translations

## [2.2.11] - 2026-06-05

### Changed
- Replaced sync file watching with stat polling for more reliable cross-instance changes
- Changed `otakProxy.proxyUrl` to machine scope and raised the minimum VS Code version to 1.97.0
- Hardened status bar and sync tooltips by writing dynamic values as text

### Fixed
- Stored proxy credentials only in secret storage or runtime state, while persisting sanitized URLs to settings, global state, sync files, and logs
- Scrubbed legacy persisted proxy credentials and compared manual proxy URL changes by public URL
- Blocked proxy apply and disable operations in untrusted workspaces
- Fixed HTTPS proxy connection tests by using protocol-specific transports and default ports

## [2.2.10] - 2026-04-25

### Changed
- Updated README copy to clarify Auto and Manual modes, integrated terminal environment behavior, and privacy handling

### Fixed
- Masked proxy passwords in status bar text, status bar tooltips, and fallback proxy notifications

## [2.2.9] - 2026-03-28

### Added
- Add `otakProxy.showProxyUrl` setting and `otak: Toggle Proxy URL Visibility` command to show/hide the proxy URL in the status bar for privacy (PR #7 by @yogwang)
  - When hidden, URLs are replaced with localized "Configured" text in both status bar and tooltip

### Fixed
- Deduplicate sync events to stop redundant "Proxy configured" notifications during multi-instance synchronization (PR #6 by @yogwang, closes #5)
  - Add version/state deduplication in SyncManager and ConflictResolver
  - Implement notification throttling in UserNotifier
  - Add silent mode for background sync and monitor-driven proxy transitions

## [2.2.8] - 2026-03-23

### Changed
- Add `otak:` prefix to all command titles for better discoverability in the Command Palette (PR #3 by @yogwang)
- Deduplicate and reorder i18n locale entries by scope
- Enrich config descriptions for `enableFallback`, `syncEnabled`, `syncInterval` across all locales

## [2.2.7] - 2026-02-17

### Changed
- All `otakProxy.*` settings are now excluded from VSCode Settings Sync: `proxyUrl`, `pollingInterval`, `maxRetries`, `testInterval`, `autoTestEnabled`, `enableFallback`, `syncInterval` → `machine-overridable` (workspace can still override); `detectionSourcePriority`, `syncEnabled` → `machine`

### Fixed
- TestProxy: consolidate failure notifications into a single message (previously two sequential error toasts appeared)

## [2.2.6] - 2026-02-17

### Changed
- Refactor: introduce `ErrorUtils` for type-safe error property access (`getErrorCode`, `getErrorMessage`, `getErrorStderr`, `getErrorSignal`, `wasProcessKilled`), replacing `error: any` casts across config managers and sync components
- Logger: respect `OTAK_PROXY_LOG_SILENT` env-var at the method level; improve type safety (`unknown` over `any`); sanitize error stack traces
- SyncManager: add periodic sync timer, `remoteChangeInProgress` guard to prevent concurrent remote/manual sync races, surface `instancesCleaned` in `SyncResult`
- Config managers (Git, npm, Terminal, VSCode, SystemProxyDetector): migrate to `ErrorUtils`; tighten TypeScript types

### Fixed
- ConflictResolver / SharedStateFile / FileWatcher: harden edge cases found during expanded property tests

## [2.2.5] - 2026-02-16

### Fixed
- Status bar not updating when receiving proxy state changes from another VSCode instance via multi-instance sync

## [2.2.4] - 2026-02-16

### Fixed
- Multi-instance sync: proxy state changes via commands (toggle, configure URL, import) were not propagated to other VSCode instances

## [2.2.3] - 2026-02-16

### Added
- UI i18n: Vietnamese (`vi`)

### Changed
- Unit tests: hermetic Git/npm config + improved parallel stability
- Sync conflict notification is now shown as a short-lived status bar message (auto-dismiss)

## [2.0.0] - 2024-12-06

### Added
- **Multi-language UI Support**
  - Automatic language detection (English and Japanese)
  - Localized messages, commands, and configuration descriptions
  - No configuration needed - uses VSCode Language Pack settings

- **npm Proxy Support**
  - Automatic npm proxy configuration alongside VSCode and Git
  - Configures both http-proxy and https-proxy for npm
  - Graceful error handling when npm is not installed

- **Enhanced Auto Mode**
  - Configurable polling interval (10-300 seconds, default 30)
  - Automatic retry with exponential backoff on detection failures
  - Customizable detection source priority
  - Detailed logging of proxy changes and detection sources
  - Immediate check when VSCode window gains focus

- **Security Enhancements**
  - Strict input validation to prevent command injection
  - Shell metacharacter detection and rejection
  - Credential masking in logs and UI
  - Secure command execution using execFile()

- **Improved Error Handling**
  - Detailed error messages with troubleshooting suggestions
  - Error aggregation across multiple configuration operations
  - Platform-specific error detection and handling
  - Graceful degradation when components fail

### Changed
- **Status Bar Improvements**
  - Command links are now always available after extension activation
  - Enhanced tooltip with last check time and detection source
  - Better error feedback in status bar

- **Configuration**
  - Added `otakProxy.pollingInterval` setting
  - Added `otakProxy.detectionSourcePriority` setting
  - Added `otakProxy.maxRetries` setting

### Fixed
- Command registration order to ensure all commands are available immediately
- Proxy detection reliability with retry logic
- Error handling for partial configuration failures

## [1.5.0] - 2024-03-01

### Changed
- Repackaged the extension for version 1.5.0

## [1.3.3] - 2024-02-21

### Changed
- Improved notification handling
  - Added auto-closing notifications for error messages (7 seconds)
  - Enhanced proxy URL configuration prompts with dismissible notifications

## [1.3.2] - 2024-02-20

### Changed
- Updated dependencies for better stability
- Improved code quality

## [1.3.1] - 2024-02-20

### Changed
- Repackaged extension for better stability

## [1.3.0] - 2024-02-20

### Changed
- Improved status bar tooltip interface
  - Added clickable action buttons in tooltip
  - Simplified status display format
  - Enhanced tooltip layout and usability
- Removed unnecessary notifications for proxy state changes

## [1.2.2] - 2024-02-18

### Changed
- Cancelled the implementation of multi-language support
- Focus on maintaining stable core functionality

## [1.1.3] - 2024-02-18

### Changed
- Removed OS system proxy configuration feature
- Simplified proxy management to focus on VSCode and Git settings only
- Removed admin privilege requirement

## [1.1.2] - 2024-02-17

### Changed
- Updated extension icon for better visibility

## [1.1.1] - 2024-02-17

### Fixed
- Git proxy disabling error handling
  - Added existence check for Git proxy settings
  - Improved error handling when removing non-existent proxy settings

## [1.1.0] - 2024-02-17

### Added
- One-click proxy configuration for:
  - OS system proxy settings (Windows WinHTTP, macOS Network Services, Linux GNOME)
  - VSCode proxy settings
  - Git proxy configuration
- Status bar toggle button
- Multi-OS support
- Error handling with detailed messages
- Independent error handling for each component

### Changed
- Removed GitHub CLI specific configuration
- Simplified proxy management focusing on system proxy

### Notes
- Requires admin privileges for system proxy
- Settings are applied immediately

## [1.0.0] - 2024-02-16

### Added
- Initial release
- VSCode proxy configuration
- Git proxy configuration
- GitHub CLI proxy configuration
- Basic error handling

## [0.0.1] - 2024-02-16

### Added
- Initial release of Otak Proxy Extension for VSCode
- Toggle proxy settings for VSCode, Git and GitHub CLI with one click
- Clear status bar indicators
- Simple and efficient proxy configuration management
- Automatic synchronization across all tools
