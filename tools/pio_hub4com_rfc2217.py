#!/usr/bin/env python3
"""
PlatformIO & esptool helper for ESP8266 remote serial flashing over hub4com (com2tcp-rfc2217) on Windows.

Works in two modes:
1. PlatformIO SCons hook (`PLATFORMIO_EXTRA_SCRIPTS="post:C:/path/to/tools/pio_hub4com_rfc2217.py"`
   or `extra_scripts = post:...` in `platformio.ini`):
   Redirects `$ESPTOOL` and `$ERASETOOL` to this wrapper script during `pio run -t upload`, `uploadfs`, or `erase`.
2. Direct `esptool.py` wrapper (`python pio_hub4com_rfc2217.py --chip esp8266 --port "rfc2217://...?ign_set_control" flash_id`):
   Applies client-side RFC2217 fixes & performance optimizations for hub4com's `com2tcp-rfc2217`,
   coordinates port handoff with any active `serial_monitor.py` broker, and delegates to `esptool._main()`.

URL & Baud Notes:
- Always append `?ign_set_control` to `rfc2217://` URLs to skip synchronous waits on `SET-CONTROL` acknowledgments.
- Hardware/driver stress-testing (`write_flash --verify`, compressed `-z` and uncompressed `-u`) against `com2tcp-rfc2217`
  confirmed a clean ceiling at `2,000,000` baud (`921600`, `1000000`, `1152000`, `1500000`, `1843200`, `2000000` all pass
  with 0 errors; `>= 2048000` is rejected by the Windows UART driver). Both ESP8266's `80 MHz` UART clock (`80 / 40`) and
  `12/24/48 MHz` USB-UART bridges have `0.00%` divisor error at `2,000,000` baud.
"""

from __future__ import annotations

import inspect
import os
import struct
import sys
import time


def _configure_platformio_scons() -> None:
    from SCons.Script import Import

    Import("env")  # noqa: F821
    pio_env = eval("env")

    orig_esptool = pio_env.subst("$ESPTOOL")
    if not orig_esptool or not os.path.isfile(orig_esptool):
        pkg_dir = pio_env.PioPlatform().get_package_dir("tool-esptoolpy")
        if pkg_dir:
            orig_esptool = os.path.join(pkg_dir, "esptool.py")

    # SCons executes SConscript via exec(compile(..., scriptname, 'exec')) without setting __file__
    wrapper_path = os.path.abspath(inspect.getfile(inspect.currentframe()))
    pio_env["ENV"]["ORIG_ESPTOOL_PATH"] = orig_esptool
    pio_env.Replace(
        ESPTOOL=wrapper_path,
        ERASETOOL=wrapper_path,
    )


def _extract_esptool_port(argv: list[str]) -> str | None:
    for idx, arg in enumerate(argv):
        if arg in ("--port", "-p") and idx + 1 < len(argv):
            return argv[idx + 1]
        if arg.startswith("--port="):
            return arg.split("=", 1)[1]
        if arg.startswith("-p") and len(arg) > 2 and not arg.startswith("--"):
            return arg[2:]
    return os.environ.get("ESPTOOL_PORT")


def _defer_after_reset_arg(argv: list[str]) -> tuple[list[str], bool]:
    """
    Ensure esptool leaves the MCU without pulsing RTS while at upload baudrate when a monitor is active.
    Converts explicit `--after hard_reset` (used by PlatformIO) or implicit default (`hard_reset`) into
    `--after no_reset`, while respecting explicit `--after no_reset` / `soft_reset` / `no_reset_stub`.
    """
    out = list(argv)
    for idx, arg in enumerate(out):
        if arg in ("--after", "-a") and idx + 1 < len(out):
            if out[idx + 1] == "hard_reset":
                out[idx + 1] = "no_reset"
                return out, True
            return out, False
        if arg.startswith("--after="):
            val = arg.split("=", 1)[1]
            if val == "hard_reset":
                out[idx] = "--after=no_reset"
                return out, True
            return out, False
    return ["--after", "no_reset"] + out, True


def _run_esptool_with_rfc2217_fixes() -> None:
    esptool_path = os.environ.get("ORIG_ESPTOOL_PATH")
    if not esptool_path or not os.path.isfile(esptool_path):
        pio_core = os.environ.get("PLATFORMIO_CORE_DIR") or os.path.expanduser("~/.platformio")
        esptool_path = os.path.join(pio_core, "packages", "tool-esptoolpy", "esptool.py")
    if not os.path.isfile(esptool_path):
        sys.stderr.write(
            f"Error: Cannot locate PlatformIO's esptool.py at '{esptool_path}'. "
            "Ensure PlatformIO's 'tool-esptoolpy' package is installed.\n"
        )
        sys.exit(1)

    sys.path.insert(0, os.path.dirname(esptool_path))

    import serial.rfc2217 as r2217
    from serial.rfc2217 import (
        BINARY,
        COM_PORT_OPTION,
        IAC,
        REQUESTED,
        RFC2217_PARITY_MAP,
        RFC2217_STOPBIT_MAP,
        SB,
        SE,
        SET_CONTROL,
        SET_CONTROL_DTR_ON,
        SET_CONTROL_RTS_OFF,
        SET_CONTROL_USE_HW_FLOW_CONTROL,
        SET_CONTROL_USE_NO_FLOW_CONTROL,
        SET_CONTROL_USE_SW_FLOW_CONTROL,
        Timeout,
    )
    import esptool
    import esptool.reset

    # Fix 1: Negotiate Telnet TRANSMIT-BINARY (option 0) in both directions on RFC2217 open()
    #        and shorten reader socket timeout so close() wakes promptly on Windows.
    #        Why: pyserial 3.5 initializes `we-BINARY` and `they-BINARY` as INACTIVE instead of REQUESTED.
    #        Without binary mode negotiated, hub4com's `com2tcp-rfc2217` Telnet filter stays in 7-bit NVT
    #        ASCII mode and translates `0x0D` (CR) bytes inside binary SLIP packets into `0x0D 0x00`
    #        (failing with `Invalid head of packet (0x72)` right after stub upload).
    _orig_open = r2217.Serial.open

    def _patched_open(self):
        self._cached_rfc2217_hw_cfg = None
        _orig_open(self)
        if getattr(self, "_socket", None) is not None:
            self._socket.settimeout(0.2)
        need_wait = False
        for opt in self._telnet_options:
            if opt.option == BINARY and opt.state != r2217.ACTIVE:
                opt.state = REQUESTED
                self.telnet_send_option(opt.send_yes, opt.option)
                need_wait = True
        if need_wait:
            deadline = time.time() + 2.0
            while time.time() < deadline:
                if all(o.active for o in self._telnet_options if o.option == BINARY):
                    break
                time.sleep(0.005)

    r2217.Serial.open = _patched_open

    # Fix 2: Skip redundant RFC2217 network re-negotiations when only client-side read `timeout` changes.
    #        Why: esptool.py reassigns `self._port.timeout` twice per SLIP command, which triggers
    #        pyserial's `rfc2217.Serial._reconfigure_port()` even though read `timeout` is purely
    #        client-side (`Queue.get`). Each call re-sends SET-BAUDRATE/DATASIZE/PARITY/STOPSIZE/SET-CONTROL
    #        with `150ms` sleeps, adding ~27s of idle overhead to a 512 KB upload (39.4s vs 11.6s).
    def _patched_reconfigure_port(self):
        if self._socket is None:
            raise r2217.SerialException("Can only operate on open ports")
        if self._write_timeout is not None:
            raise NotImplementedError("write_timeout is currently not supported")

        hw_cfg = (
            self._baudrate,
            self._bytesize,
            self._parity,
            self._stopbits,
            self._rtscts,
            self._xonxoff,
        )
        if getattr(self, "_cached_rfc2217_hw_cfg", None) == hw_cfg:
            return

        if not 0 < self._baudrate < 2 ** 32:
            raise ValueError(f"invalid baudrate: {self._baudrate!r}")

        self._rfc2217_port_settings["baudrate"].set(struct.pack(b"!I", self._baudrate))
        self._rfc2217_port_settings["datasize"].set(struct.pack(b"!B", self._bytesize))
        self._rfc2217_port_settings["parity"].set(struct.pack(b"!B", RFC2217_PARITY_MAP[self._parity]))
        self._rfc2217_port_settings["stopsize"].set(struct.pack(b"!B", RFC2217_STOPBIT_MAP[self._stopbits]))

        items = self._rfc2217_port_settings.values()
        timeout = Timeout(self._network_timeout)
        while not timeout.expired():
            if sum(o.active for o in items) == len(items):
                break
            time.sleep(0.005)
        else:
            raise r2217.SerialException(f"Remote does not accept parameter change (RFC2217): {list(items)!r}")

        prev_cfg = getattr(self, "_cached_rfc2217_hw_cfg", None)
        if prev_cfg is None or prev_cfg[4:] != hw_cfg[4:]:
            if self._rtscts and self._xonxoff:
                raise ValueError("xonxoff and rtscts together are not supported")
            elif self._rtscts:
                self.rfc2217_set_control(SET_CONTROL_USE_HW_FLOW_CONTROL)
            elif self._xonxoff:
                self.rfc2217_set_control(SET_CONTROL_USE_SW_FLOW_CONTROL)
            else:
                self.rfc2217_set_control(SET_CONTROL_USE_NO_FLOW_CONTROL)

        self._cached_rfc2217_hw_cfg = hw_cfg

    r2217.Serial._reconfigure_port = _patched_reconfigure_port

    # Fix 3: Fuse DTR_ON + RTS_OFF into one TCP segment for NodeMCU 2-transistor auto-reset.
    #        Why: esptool's ClassicReset calls `_setDTR(True)` followed by `_setRTS(False)`. Over local UART
    #        this takes microseconds; over RFC2217 pyserial emits two separate TCP packets. During network RTT
    #        between `DTR=1` and `RTS=0`, both DTR and RTS are asserted simultaneously, turning off both NPN
    #        transistors so `RST` releases HIGH while `GPIO0` is still HIGH — booting into normal flash mode
    #        `(3,6)` instead of UART bootloader mode `(1,7)`.
    _orig_classic_reset = esptool.reset.ClassicReset.__call__

    def _patched_classic_reset(self):
        if isinstance(self.port, r2217.Serial) and getattr(self.port, "_socket", None) is not None:
            self._setDTR(False)  # IO0=HIGH
            self._setRTS(True)   # EN=LOW (hold chip in reset)
            time.sleep(0.1)
            pkt = (
                IAC + SB + COM_PORT_OPTION + SET_CONTROL + SET_CONTROL_DTR_ON + IAC + SE
                + IAC + SB + COM_PORT_OPTION + SET_CONTROL + SET_CONTROL_RTS_OFF + IAC + SE
            )
            self.port._socket.sendall(pkt)
            self.port._dtr_state = True
            self.port._rts_state = False
            time.sleep(self.reset_delay)
            self._setDTR(False)  # IO0=HIGH
        else:
            _orig_classic_reset(self)

    esptool.reset.ClassicReset.__call__ = _patched_classic_reset

    # Fix 4: Serialize concurrent uploads via OS file mutex + connection-tied `lease_port` on active
    #        `serial_monitor.py` broker. Converts `--after hard_reset` -> `no_reset` during upload and
    #        queues an `RTS` reset on lease release so 100% of 74880-baud boot logs are captured from byte 0.
    upload_lease = None
    deferred_reset = False
    target_port = _extract_esptool_port(sys.argv[1:])
    if target_port:
        try:
            tooling_dir = os.path.dirname(os.path.abspath(inspect.getfile(inspect.currentframe())))
            if tooling_dir not in sys.path:
                sys.path.insert(0, tooling_dir)
            import serial_monitor as _smon

            upload_lease = _smon.UploadPortLease(target_port, reason="esptool").acquire()
            if upload_lease.broker_active:
                new_tail, deferred_reset = _defer_after_reset_arg(sys.argv[1:])
                sys.argv[1:] = new_tail
        except Exception:
            if upload_lease is not None:
                upload_lease.release(reset=False)
            upload_lease = None

    esptool_ok = False
    try:
        esptool._main()
        esptool_ok = True
    except SystemExit as exc:
        esptool_ok = exc.code in (0, None)
        raise
    finally:
        if upload_lease is not None:
            upload_lease.release(reset=(deferred_reset and esptool_ok))


if __name__ == "__main__":
    _run_esptool_with_rfc2217_fixes()
else:
    _configure_platformio_scons()
