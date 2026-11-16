# BVB wire protocol v2

All integers are unsigned little-endian. Each GATT write is at most 20 bytes,
compatible with the default 23-byte ATT MTU. No newline-delimited commands or
heuristics over user text exist. v1 packet types A1/A2/A3 are not accepted.

## GATT

| Characteristic | UUID | Access |
| --- | --- | --- |
| Service | `7f510001-6f3b-4f37-9d9a-6c7f5f11b001` | Primary |
| Write | `7f510002-6f3b-4f37-9d9a-6c7f5f11b001` | Write with response |
| Status | `7f510003-6f3b-4f37-9d9a-6c7f5f11b001` | Read / Notify |
| Capabilities | `7f510004-6f3b-4f37-9d9a-6c7f5f11b001` | Read |

Capability discovery/read and notification subscription must succeed before
enabling actions. An old firmware has no Capabilities characteristic; clients
must not send any probe or operation to its Write characteristic.

Capabilities, 16 bytes:

| Offset | Length | Meaning |
| --- | --- | --- |
| 0 | 4 | ASCII `BVB2` |
| 4 | 1 | Features: 1=open, 2=search, 4=legacy; required value 7 |
| 5 | 1 | State: 0=idle, 1=receiving, 2=queued, 3=executing |
| 6 | 2 | Maximum payload: 4096 |
| 8 | 4 | Random boot identifier |
| 12 | 4 | Highest reserved operation ID in this boot |

Read capabilities on connect and immediately before each new operation. IDs
start at highWater+1, cannot wrap, and must increase for the entire ESP32 boot.
Duplicate/older IDs are never re-executed, including after disconnect or failed
uploads. A change in boot ID requires deliberate reconnect. Do not retransmit
an operation with a fresh ID after an uncertain outcome.

## START (20 bytes)

| Offset | Length | Meaning |
| --- | --- | --- |
| 0 | 1 | `B1` |
| 1 | 1 | Protocol version `02` |
| 2 | 4 | Operation ID (nonzero) |
| 6 | 1 | Operation: 1=open, 2=search, 3=legacy |
| 7 | 1 | PC OS: 1=Windows, 2=Mac |
| 8 | 1 | Append Enter: 0/1; open requires 0 |
| 9 | 1 | PC keyboard: 0=US, 1=JIS |
| 10 | 2 | Payload length N, ≤4096; open requires 0; others require >0 |
| 12 | 2 | Shortcut delay, 200–5000 ms |
| 14 | 2 | Launch delay, 500–15000 ms |
| 16 | 2 | Address bar focus delay, 100–5000 ms |
| 18 | 2 | Inter-key delay, 8–100 ms |

Only a valid START while idle reserves an ID. Receiving/queued/executing are
exclusive. Another START cannot overwrite the current request. A packet that
arrived during HID execution remains rejected even if drained after completion.

## DATA / END

DATA = `B2` (1 byte), operation ID (4), absolute byte offset (2), payload (1–13).
Offsets must exactly match the received length. Overflow, wrong sequence, or
incomplete END aborts that upload, while unrelated IDs cannot clear it.

END = `B3` (1 byte), operation ID (4). Full validation precedes Accepted.
Search payload is an ASCII URL with exact prefix
`https://www.google.com/search?q=`. Its nonempty suffix permits letters, digits,
`-_.` and uppercase `%HH` only. This restricts query separators and controls to
encoded data. The browser validates Unicode scalar values, replaces newlines
with spaces, and percent-encodes UTF-8 once; it does not decode input first.

Legacy payload is printable ASCII, LF, TAB, or marker `1E` + 4–6 uppercase hex
digits + `;`. Tokens must represent U+0080–U+10FFFF excluding surrogates, and are
only valid with PC OS Windows. Firmware types `U+` + digits followed by Alt+X.
Open has no payload. All payloads are fully validated before any HID keypress.

Payload capacity excludes transport metadata. Total write bytes:
`N + 20 + 7*ceil(N/13) + 5`; at N=4096 this is 6333 bytes, at N=0 it is 25.
This excludes BLE/ATT overhead and capability/status traffic.

## Status (7 bytes)

`C2` (1), event (1), operation ID (4), reason (1).

Events: 1=Accepted, 2=HID sequence finished, 3=Error.
Reasons: 0=none, 1=busy, 2=duplicate/stale ID, 3=invalid header,
4=size, 5=sequence/incomplete, 6=encoding, 7=receive timeout, 8=HID interrupted.

Subscribe before uploading. Match status by ID. Accepted is emitted once at
validation; completion is emitted only after the sequence finishes. Neither
event confirms Chrome or the OS processed the keys. Unknown/missing completion
must not be automatically retried. On transport errors the browser disconnects,
retains the input, and requires a deliberate reconnect.

## Deadlines and cancellation

Firmware aborts an incomplete upload after 10000 ms without a packet. The client
bounds each GATT call at 10000 ms and each write is followed by 18 ms pacing.
Overall wait is the upload budget plus a separate conservative HID budget:

```
upload = 10000 + (ceil(N/13) + 2) * 1200
setup  = legacy ? 0 : launch + 4*shortcut + 2*focus + 30*(key + 300)
hid    = 15000 + setup + (N + appendEnter)*(key + 300) + 700*unicodeTokens
```

The per-byte allowance includes USB report/hold time. This is an upper waiting
budget, not a claim about the PC speed or a retry schedule. An unresponsive
individual write still fails after 10 seconds; the HID completion wait can be
much longer. Uncertainty causes disconnect and no replay.

The loop services the bounded BLE queue during every delay. Disconnect changes
the connection generation; old-generation packets and HID work cannot continue
on a new connection. Busy-at-arrival tagging prevents queued packets from being
executed after a previous operation. USB detach/suspend and queue overflow also
interrupt HID. Key and modifier state is released after each chord, each typed
character, and on all exit paths. Electrical loss can prevent delivery of a
release report; no software can acknowledge PC input without a PC-side agent.
