---
name: esp-remote-serial
description: Cooperative remote serial flashing (hub4com / RFC2217) and live multi-client 74880-baud UART monitoring for ESP8266 PlatformIO development in Antigravity on Windows. Activate when flashing ESP8266 firmware over rfc2217://, monitoring serial boot/runtime logs, rebooting boards over RTS, or opening the Serial Monitor side panel.
---

# ESP8266 Remote Serial Flashing & Monitoring (`serial-monitor`)

Provides high-speed ESP8266 serial flashing under PlatformIO over `hub4com` (`com2tcp-rfc2217`), a cooperative multi-client serial monitor broker (`serial_monitor.py`), and an Auxiliary Side Pane terminal (**Serial Monitor**) for Google Antigravity on Windows.

---

## 1. Opening the Side Panel & Resolving Saved Targets

### Open the Auxiliary Side Pane UI
To surface a one-click pill in chat that opens or toggles the **Serial Monitor** panel:

```markdown
[Serial Monitor](sidecar://serial-monitor/monitor/)
```

### Resolve Saved Target Bookmarks & Nicknames
The UI sidecar persists saved board endpoints and nicknames in:

`$HOME\.gemini\antigravity\sidecar_data\serial-monitor\monitor\data\state.json`

Read this JSON file first whenever the user refers to an ESP8266 board by nickname (e.g., `"Bench ESP01"`) or asks to flash/monitor a saved board without specifying an explicit `rfc2217://` URL or `COM` port. Each entry under `.targets` contains `{ "targetKey", "portUrl", "baud", "nickname" }`.

---

## 2. Bundled Tooling & Core Rules (Windows + PlatformIO)

Relative to this `SKILL.md` file (`<plugin-root>\skills\esp-remote-serial\SKILL.md`), the Python helpers live in `<plugin-root>\tools\`:

- `<plugin-root>\tools\pio_hub4com_rfc2217.py` — PlatformIO SCons post-script & standalone `esptool.py` wrapper for `hub4com` (`com2tcp-rfc2217`).
- `<plugin-root>\tools\serial_monitor.py` — Cooperative multi-client `74880`-baud serial broker & watcher CLI.

**Key Operational Rules**:
1. **Do NOT install `com0com` or use vanilla `esptool` / `pio device monitor`**:
   - Non-admin Windows VMs/workstations cannot install kernel virtual COM drivers, and `com2tcp-rfc2217` is single-client exclusive and stays in 7-bit NVT ASCII mode unless Telnet `TRANSMIT-BINARY` is negotiated.
2. **Always append `?ign_set_control`** to `rfc2217://` URLs:
   - Format: `rfc2217://<host>:<port>?ign_set_control`
3. **Python Interpreter**:
   - Run `serial_monitor.py` and `pio_hub4com_rfc2217.py` using PlatformIO's Python environment (which already includes `pyserial`), e.g. `$HOME\.platformio\penv\Scripts\python.exe` (or `$HOME\scoop\persist\uv\tools\versions\platformio\Scripts\python.exe` / `%APPDATA%\uv\tools\platformio\Scripts\python.exe` when PlatformIO is installed via `uv`).

---

## 3. Live Serial Monitoring (`74880` Baud)

ESP8266 ROM boot logs (`boot: (3,6)`, `(1,7)`, crash backtraces) and `ESP8266_RTOS_SDK` console output default to **`74880` baud**. Because `com2tcp-rfc2217` (and `COMx`) only allows one open client, always go through `serial_monitor.py`, which shares a single connection across Antigravity conversations and the **Serial Monitor** side panel, yields automatically during `pio_hub4com_rfc2217.py` uploads without losing boot logs, and auto-exits on Antigravity close or `60s` idle.

- **Launch `watch` FIRST as a Background Daemon**:
  - Antigravity terminates child process trees of short-lived (`IsDaemon = false`) tool commands when they exit. Always start `watch` **first** with `IsDaemon = true`, `WaitMsBeforeAsync = 500`, and `toolSummary = "Serial monitor (<host>:<port>)"` so the broker is anchored under a persistent daemon session.

```powershell
$py   = "$HOME\.platformio\penv\Scripts\python.exe" # or uv PlatformIO Scripts\python.exe
$mon  = "$HOME\.gemini\config\plugins\serial-monitor\tools\serial_monitor.py"
$port = "rfc2217://<host>:<port>?ign_set_control"

# 1. Start live watcher daemon FIRST (IsDaemon=true, WaitMsBeforeAsync=500)
& $py $mon watch --port $port --label "my-project"

# 2. Bracket a test action to inspect only newly emitted logs
& $py $mon mark "test-step" --port $port
# ... trigger device or HTTP action ...
& $py $mon tail --since-mark "test-step" --port $port

# 3. Other common operations
& $py $mon tail --lines 50 --port $port       # Read recent lines
& $py $mon reboot --capture 4 --port $port    # Clean RTS reboot into (3,6) + capture 4s boot log
& $py $mon status                             # Inspect active brokers, watchers, and marks
& $py $mon stop --port $port                  # Manual stop (optional)
```

---

## 4. High-Speed ESP8266 Flashing (`pio_hub4com_rfc2217.py`)

`pio_hub4com_rfc2217.py` patches `pyserial`/`esptool` RFC2217 bugs (Telnet binary negotiation, eliminating ~27s of redundant per-command port reconfigurations, and fusing `DTR_ON + RTS_OFF` into one TCP segment so NodeMCU 2-transistor auto-reset enters `(1,7)` UART bootloader mode reliably over network RTT).

When `serial_monitor.py` is active, `pio_hub4com_rfc2217.py` acquires an exclusive `UploadPortLease`, converts `--after hard_reset` to `no_reset` during upload, and queues a clean `RTS` pulse at `74880` baud on lease release — capturing **100% of ROM boot logs from byte 0**.

- **Upload Baud Ceiling**: Verified up to **`2000000` baud** over `com2tcp-rfc2217` (`0.00%` divisor error on ESP8266's `80 MHz` UART clock; `> 2000000` is rejected by Windows UART drivers). Use `921600` if a legacy USB-UART bridge does not support `2000000`.

```powershell
$env:PLATFORMIO_EXTRA_SCRIPTS = "post:$HOME\.gemini\config\plugins\serial-monitor\tools\pio_hub4com_rfc2217.py"
$env:PLATFORMIO_UPLOAD_SPEED  = "2000000"

pio run -t upload   --upload-port "rfc2217://<host>:<port>?ign_set_control"  # Bootloader + partitions + app
pio run -t uploadfs --upload-port "rfc2217://<host>:<port>?ign_set_control"  # LittleFS / SPIFFS image
pio run -t erase    --upload-port "rfc2217://<host>:<port>?ign_set_control"  # Full flash erase

# Direct esptool commands (flash_id, read_mac, etc.)
& $py "$HOME\.gemini\config\plugins\serial-monitor\tools\pio_hub4com_rfc2217.py" `
    --chip esp8266 --port "rfc2217://<host>:<port>?ign_set_control" --baud 921600 flash_id
```

---

## 5. Connectivity Troubleshooting

- **`Could not open ..., the port doesn't exist`**:
  - Test TCP reachability (`& $py -c "import socket; socket.create_connection(('<host>', <port>), timeout=3)"`).
  - Silent TCP SYN timeouts from a Windows VM (e.g. Hyper-V) or dev machine on the same subnet usually indicate a Windows Firewall inbound rule or vSwitch ACL blocking TCP `<port>` on the `hub4com` host, or another raw terminal holding the single-client `com2tcp-rfc2217` port.
