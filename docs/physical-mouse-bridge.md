# Better Git background physical hold contract (planned 1.2.136)

Use the private per-window Unix socket, not keyboard events or OS URL routing after Begin. Directory `/tmp/better-git-mouse-<uid>` is owned by the current user, mode 0700; sockets `vscode-<extensionHostPID>-<uuid>.sock` mode 0600. Never create the directory on the client or follow symlinks. Only connect to user-owned sockets in the validated directory.

One bounded UTF-8 JSON object plus newline per connection; reply is one JSON line. Probe: `{"version":1,"phase":"probe"}` -> `{version:1,extensionVersion:"1.2.136",backgroundHold:true,canBegin:<bool>}`. Probe does not change state. Discover candidates, Begin only where canBegin is true; Begin independently checks foreground focus and no existing hold. Capture and pin the accepting socket for the entire physical gesture. Never re-route a live gesture to another window. Connection failure abandons locally; never emit fallback keys into the foreground app.

Every gesture packet has exactly these fields: `{version:1,phase,id,seq,source,direction,mode}`. id is a fresh UUID per physical hold; seq starts at 1, increments once per packet; source is corsair or razer; direction next or previous; mode changes (Eyes) or files. Keep source constant. Direction is the original hold direction except Step, where it is the actual wheel direction.

Phases:
- begin: seq 1, captures the current review without button-down navigation; accepted only while this VS Code window is foreground.
- ready: threshold reached; enable stage feedback, set supplied mode.
- step: wheel ratchet; mode=changes calls hunk review, mode=files calls file selection; no stage.
- mode: toggle to supplied mode within the same hold.
- short-release: F14 equivalent; leaves quick-adjacent Undo recognition pending.
- boundary: F15 equivalent; closes short release and navigates once if not cancelled.
- finish: long physical owner release; stages current marked group under existing Eyes exclusion/Undo rules. Closes gesture.
- cancel: adjacent F16 equivalent: ready hold cancels only; pre-ready hold cancels and performs existing exact Undo. Closes gesture.
- abandon: session lock/disconnect/explicit safety abandonment: discard pending hold without stage/Undo or restoring another editor. Closes gesture.
- heartbeat: every 500 ms while the owner remains physically down, even with another app foreground. No UI or selection mutation. Missing heartbeat/input for 3 seconds discards, never commits.

Send packets in sequence and await admission replies before the next packet. `{accepted:true,id,seq}` means admitted, not rendered/staged. Same seq may retry unchanged (no duplicate effect); a gap is rejected with expectedSeq; no silent reordering. A terminal packet is not followed by new input. Retired IDs cannot start again. Queue cap 64; overflow abandons safely, never stages. New hold needs a fresh UUID and a focused window.

The receiver keeps original window/group ownership, stages only on Finish, and prevents stale packets crossing sessions or repositories. While background it preserves OS/app focus via preserveFocus; editor changes/closed repo invalidate the captured hold safely. The 300ms wheel-idle start gate still applies at packet arrival; the already-running step may finish. Wand transport remains unchanged.

Do not enable until this protocol is present in the installed/active extension. Native Default and VS Code modes must use this same socket for lifecycle, wheel and mode packets once Begin is accepted; do not also emit old keys/URIs. Existing foreground-only path can remain for older extensions.
