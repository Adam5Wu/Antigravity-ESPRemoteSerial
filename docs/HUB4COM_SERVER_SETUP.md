# Setting Up `hub4com` (`com2tcp-rfc2217`) on the USB Host (Windows)

When running Google Antigravity inside a non-Administrator Windows VM (e.g. Hyper-V, VMware, Windows Sandbox) or a separate Windows workstation while physical ESP8266 boards are plugged into another Windows host, [`hub4com`](https://sourceforge.net/projects/com0com/files/hub4com/) exposes physical `COM` ports over TCP using **RFC 2217** (including dynamic baud rate switching between `74880` and `2000000` and `DTR`/`RTS` auto-reset control lines).

Unlike kernel-mode virtual COM port drivers (`com0com`), **no Administrator privileges or drivers are required on the Antigravity client machine** — `pio_hub4com_rfc2217.py` and `serial_monitor.py` speak RFC 2217 directly in user space over TCP.

---

## 1. Prerequisites on the USB Host

1. Download **hub4com** from the [`com0com` / `hub4com` project](https://sourceforge.net/projects/com0com/files/hub4com/). (`hub4com.exe` runs purely in user space; no signed kernel driver installation is needed to bridge a physical `COMx` port to TCP.)
2. Plug in your ESP8266 board / USB-UART adapter (CH340, CP2102N, FT232, etc.) and check its port name in **Device Manager** (for example, `COM4`).

---

## 2. Starting the RFC 2217 Bridge

Use `com2tcp-rfc2217.bat` (shipped alongside `hub4com.exe`) to expose the physical COM port on a TCP port (for example, `3030`):

```bat
com2tcp-rfc2217.bat \\.\COM4 3030
```

> [!TIP]
> Always use the `\\.\COM<N>` Windows device namespace (required for `COM10` and above, and works identically for `COM1`–`COM9`).

To host multiple ESP8266 boards on the same USB host, launch one `com2tcp-rfc2217.bat` instance per board on separate TCP ports:

```bat
start "ESP8266-1 (COM4)" com2tcp-rfc2217.bat \\.\COM4 3030
start "ESP8266-2 (COM7)" com2tcp-rfc2217.bat \\.\COM7 3031
```

---

## 3. Windows Firewall / Hyper-V vSwitch Access

Allow inbound TCP connections for your chosen port(s) on the **USB host**:

```powershell
# Run in an elevated PowerShell on the USB host machine
New-NetFirewallRule `
    -DisplayName "hub4com RFC2217 (TCP 3030-3035)" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 3030-3035 `
    -Action Allow `
    -Profile Private
```

Verify TCP reachability from your Antigravity Windows client:

```powershell
python -c "import socket; s = socket.create_connection(('192.168.1.50', 3030), timeout=3); print('OK:', s.getpeername()); s.close()"
```

---

## 4. Why Vanilla `esptool` & `pyserial` Fail Against `hub4com`

Connecting unpatched `pyserial` / PlatformIO `esptool.py` to `com2tcp-rfc2217.bat` runs into four protocol and timing bugs that `pio_hub4com_rfc2217.py` and `serial_monitor.py` solve on the client side:

| Issue with Vanilla `pyserial` / `esptool` | Symptom on ESP8266 | Client-Side Fix in `pio_hub4com_rfc2217.py` |
| :--- | :--- | :--- |
| **1. Missing `?ign_set_control` URL flag** | Stalls waiting for `SET-CONTROL` ACKs omitted by `hub4com` | Uses `rfc2217://<host>:<port>?ign_set_control` everywhere (auto-appended by the UI) |
| **2. Unnegotiated Telnet `TRANSMIT-BINARY` (Option 0)** | `hub4com`'s Telnet filter stays in 7-bit NVT ASCII mode and mutates `0x0D` bytes inside SLIP packets (`Invalid head of packet (0x72)` right after stub upload) | Actively negotiates bidirectional `BINARY` mode on RFC2217 `open()` |
| **3. Redundant `_reconfigure_port()` on timeout edits** | `esptool.py` reassigns `port.timeout` twice per SLIP command, causing `pyserial` to re-send 5 RFC2217 control packets + `150ms` sleeps every time (~39.4s vs ~11.6s for 512 KB) | Caches `(baud, bytesize, parity, stopbits, rtscts, xonxoff)` and skips network round-trips when only client read `timeout` changes |
| **4. Split TCP packets during NodeMCU `DTR`/`RTS` auto-reset** | Network RTT between `DTR=1` and `RTS=0` asserts both lines simultaneously, turning off both NPN transistors so `RST` releases HIGH while `GPIO0` is HIGH — booting normal flash `(3,6)` instead of UART bootloader `(1,7)` | Fuses `SET_CONTROL_DTR_ON` + `SET_CONTROL_RTS_OFF` into a single `sendall()` TCP segment |

---

## 5. ESP8266 Baud Rates (`74880` Monitor / `2000000` Upload)

- **Boot & Console Monitoring (`74880` baud)**:
  - With a standard `26 MHz` crystal, the ESP8266 ROM bootloader emits reset reason and boot mode diagnostics (`boot mode:(3,6)` vs `(1,7)`) at **`74880` baud** (also the default console rate in `ESP8266_RTOS_SDK`). `com2tcp-rfc2217` forwards arbitrary non-standard Win32 baud rates like `74880` cleanly.
- **High-Speed Flashing (`2,000,000` baud)**:
  - Hardware stress-testing (`write_flash --verify`, compressed `-z` and uncompressed `-u`) over `com2tcp-rfc2217` confirmed zero-error flashing up to **`2,000,000` baud** (`921600`, `1000000`, `1152000`, `1500000`, `1843200`, `2000000`).
  - Both ESP8266's `80 MHz` UART clock (`80 / 40 = 2.0 MHz`) and modern `12 / 24 / 48 MHz` USB-UART bridges (CH340, CP2102N, FT232H) have **`0.00%` divisor error** at `2,000,000` baud (`>= 2,048,000` is rejected by Windows UART drivers). Select the rate with `upload_speed = 2000000` in the project's `platformio.ini` (PlatformIO has no environment-variable override); if an older USB-UART IC caps out lower, use `upload_speed = 921600`.
