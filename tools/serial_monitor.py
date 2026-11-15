#!/usr/bin/env python3
"""
Cooperative multi-client ESP8266 serial monitor broker & watcher for RFC2217 (hub4com) and COM ports on Windows.

Architecture:
- Detached per-port Broker (`_broker` internal mode, auto-spawned on demand):
  - Owns the single exclusive `rfc2217://` (or `COMx`) serial connection at `74880` baud.
  - Streams timestamped lines to a shared rolling log in `%TEMP%\\agy_serial_monitor\\logs\\`
    and fans them out in real time over `127.0.0.1` to any number of `watch` subscribers
    across multiple Antigravity conversations, subagents, or the Serial Monitor side panel.
  - Binds its lifetime to the parent Antigravity IDE process (`Antigravity.exe` / `language_server*.exe`)
    via a Win32 `SYNCHRONIZE` kernel handle so closing the IDE shuts down the broker immediately (<100ms).
  - Auto-exits after `--idle-timeout` (default 60s) once `0` `watch` subscribers and `0` upload leases remain.
  - Enables Windows TCP Keepalive on RFC2217 sockets to detect silent network drops and auto-reconnects.
  - Provides connection-tied `lease_port` handoff + OS file mutex so concurrent `esptool` uploads from
    different conversations queue safely, and an `esptool` crash releases the port in milliseconds.

CLI Subcommands:
  watch (or start)  Auto-start broker if needed and stream live output to stdout (use IsDaemon=true in Antigravity)
  ensure            Ensure the background broker is running for `--port` and return immediately
  status            Inspect active broker(s), connected watchers, lease state, and named marks
  mark [label]      Insert a named timestamped marker into the log (tracked per label)
  tail              Read recent `--lines N` or `--since-mark [label]`
  reboot            Pulse RTS (`DTR=False`) to boot cleanly into normal mode `(3,6)` and optionally capture output
  pause / resume    Manual port release / resume
  stop              Shut down active broker (`--port` or `--all`) and cleanly exit attached watchers
"""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import datetime as dt
import hashlib
import json
import msvcrt
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

import serial


STATE_DIR = os.environ.get("SERIAL_MONITOR_STATE_DIR") or os.path.join(tempfile.gettempdir(), "agy_serial_monitor")
LOG_DIR = os.path.join(STATE_DIR, "logs")
DEFAULT_BAUD = 74880
DEFAULT_IDLE_TIMEOUT = 60.0
DEFAULT_PAUSE_TIMEOUT = 300.0
MAX_LOG_BYTES = 16 * 1024 * 1024  # 16 MB rolling cap
BROKER_STOP_SENTINEL = "=== [BROKER_STOPPED] ==="


# ---------------------------------------------------------------------------
# Path, Lock, and Win32 Process Helpers
# ---------------------------------------------------------------------------

def canonical_target_key(port_spec: str) -> str:
    """Normalize a serial port or RFC2217 URL so query flags map to the same physical target."""
    spec = port_spec.strip()
    if "://" in spec:
        parts = urlsplit(spec)
        scheme = parts.scheme.lower()
        netloc = parts.netloc.lower()
        path = parts.path or ""
        return f"{scheme}://{netloc}{path}"
    return spec.lower()


def _key_digest(target_key: str) -> str:
    return hashlib.sha1(target_key.encode("utf-8")).hexdigest()[:16]


def state_file_for_key(target_key: str) -> str:
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, f"mon_{_key_digest(target_key)}.json")


def spawn_lock_file_for_key(target_key: str) -> str:
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, f"spawn_{_key_digest(target_key)}.lock")


def upload_lock_file_for_key(target_key: str) -> str:
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, f"upload_{_key_digest(target_key)}.lock")


def default_log_file_for_key(target_key: str) -> str:
    os.makedirs(LOG_DIR, exist_ok=True)
    safe = target_key.replace("://", "_").replace(":", "_").replace("/", "_").replace("\\", "_")
    return os.path.join(LOG_DIR, f"{safe}_{_key_digest(target_key)[:8]}.log")


def now_ts() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


class FileLock:
    """Cross-process OS file lock using Win32 `msvcrt.locking` (auto-released by OS on process crash)."""

    def __init__(self, path: str, timeout: float = 30.0, poll_interval: float = 0.05):
        self.path = path
        self.timeout = timeout
        self.poll_interval = poll_interval
        self._fd: int | None = None

    def acquire(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT)
        try:
            if os.lseek(fd, 0, os.SEEK_END) == 0:
                os.write(fd, b"0")
            deadline = time.monotonic() + self.timeout
            while True:
                os.lseek(fd, 0, os.SEEK_SET)
                try:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    self._fd = fd
                    return
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"Timed out waiting for lock '{self.path}'")
                    time.sleep(self.poll_interval)
        except Exception:
            os.close(fd)
            raise

    def release(self) -> None:
        if self._fd is not None:
            fd = self._fd
            self._fd = None
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            try:
                os.close(fd)
            except OSError:
                pass

    def __enter__(self) -> "FileLock":
        self.acquire()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.release()


def find_antigravity_host_process() -> tuple[int | None, str | None]:
    """
    Walk the Win32 ancestor chain of the current process to locate the owning Antigravity IDE/LS process.
    Prefers the outermost `antigravity.exe` ancestor, falling back to `language_server*.exe`.
    """
    if os.name != "nt":
        return None, None
    try:
        TH32CS_SNAPPROCESS = 0x00000002

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260),
            ]

        k32 = ctypes.windll.kernel32
        snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snap == wintypes.HANDLE(-1).value:
            return None, None
        try:
            procs: dict[int, tuple[int, str]] = {}
            pe = PROCESSENTRY32W()
            pe.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            if k32.Process32FirstW(snap, ctypes.byref(pe)):
                while True:
                    procs[int(pe.th32ProcessID)] = (int(pe.th32ParentProcessID), pe.szExeFile)
                    if not k32.Process32NextW(snap, ctypes.byref(pe)):
                        break
        finally:
            k32.CloseHandle(snap)

        cur = os.getpid()
        visited: set[int] = set()
        agy_match: tuple[int, str] | None = None
        ls_match: tuple[int, str] | None = None
        while cur and cur not in visited and cur in procs:
            visited.add(cur)
            ppid, exe = procs[cur]
            low = exe.lower()
            if low == "antigravity.exe":
                agy_match = (cur, exe)
            elif low.startswith("language_server") and ls_match is None:
                ls_match = (cur, exe)
            cur = ppid

        if agy_match:
            return agy_match
        if ls_match:
            return ls_match
    except Exception:
        pass
    return None, None


def open_process_synchronize_handle(pid: int) -> int | None:
    """Open a Win32 SYNCHRONIZE handle to `pid` (returns None if process already exited or inaccessible)."""
    if os.name != "nt" or pid <= 0:
        return None
    SYNCHRONIZE = 0x00100000
    k32 = ctypes.windll.kernel32
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = wintypes.HANDLE
    handle = k32.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        return None
    # Check if already signaled (WAIT_OBJECT_0 == 0)
    if k32.WaitForSingleObject(handle, 0) == 0:
        k32.CloseHandle(handle)
        return None
    return int(handle)


# ---------------------------------------------------------------------------
# Socket & Serial Helpers
# ---------------------------------------------------------------------------

def enable_tcp_keepalive(sock: socket.socket, idle_ms: int = 10_000, interval_ms: int = 3_000) -> None:
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, "SIO_KEEPALIVE_VALS"):
            sock.ioctl(socket.SIO_KEEPALIVE_VALS, (1, idle_ms, interval_ms))
    except Exception:
        pass


def open_serial_passive(port_url: str, baud: int) -> serial.SerialBase:
    """Open serial/RFC2217 port passively without pulsing DTR/RTS, with TCP keepalive + fast close wakeup."""
    import serial.rfc2217 as r2217
    from serial.rfc2217 import BINARY, REQUESTED

    ser = serial.serial_for_url(port_url, do_not_open=True)
    ser.baudrate = baud
    ser.timeout = 0.1
    ser.dtr = False
    ser.rts = False
    ser.open()

    if isinstance(ser, r2217.Serial):
        if getattr(ser, "_socket", None) is not None:
            ser._socket.settimeout(0.2)
            enable_tcp_keepalive(ser._socket, idle_ms=10_000, interval_ms=3_000)
        for opt in ser._telnet_options:
            if opt.option == BINARY and opt.state != r2217.ACTIVE:
                opt.state = REQUESTED
                ser.telnet_send_option(opt.send_yes, opt.option)
    return ser


def send_ctrl_request(ctrl_host: str, ctrl_port: int, payload: dict, timeout: float = 5.0) -> dict:
    with socket.create_connection((ctrl_host, ctrl_port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        buf = bytearray()
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf.extend(chunk)
            if b"\n" in chunk:
                break
    raw = bytes(buf).split(b"\n", 1)[0].decode("utf-8", errors="replace").strip()
    return json.loads(raw) if raw else {"ok": False, "error": "empty response"}


def list_active_monitors(cleanup_stale: bool = True) -> list[dict]:
    if not os.path.isdir(STATE_DIR):
        return []
    active = []
    for name in sorted(os.listdir(STATE_DIR)):
        if not (name.startswith("mon_") and name.endswith(".json")):
            continue
        fpath = os.path.join(STATE_DIR, name)
        try:
            with open(fpath, "r", encoding="utf-8") as fh:
                info = json.load(fh)
            resp = send_ctrl_request(info["ctrl_host"], int(info["ctrl_port"]), {"cmd": "ping"}, timeout=0.35)
            if resp.get("ok"):
                info.update(resp)
                info["state_file"] = fpath
                active.append(info)
            elif cleanup_stale:
                try:
                    os.remove(fpath)
                except OSError:
                    pass
        except Exception:
            if cleanup_stale:
                try:
                    os.remove(fpath)
                except OSError:
                    pass
    return active


def resolve_running_monitor(port_spec: str | None) -> dict:
    monitors = list_active_monitors(cleanup_stale=True)
    if port_spec:
        key = canonical_target_key(port_spec)
        for mon in monitors:
            if mon.get("target_key") == key:
                return mon
        raise RuntimeError(f"No active serial monitor broker found for target '{key}'.")
    if not monitors:
        raise RuntimeError("No active serial monitor brokers are currently running.")
    if len(monitors) > 1:
        targets = ", ".join(m.get("target_key", "?") for m in monitors)
        raise RuntimeError(f"Multiple monitor brokers running ({targets}); specify --port.")
    return monitors[0]


def ensure_broker(
    port_url: str,
    baud: int = DEFAULT_BAUD,
    idle_timeout: float = DEFAULT_IDLE_TIMEOUT,
    log_file: str | None = None,
    truncate: bool = False,
) -> dict:
    """
    Ensure a detached broker process is running for `port_url` (spawning one race-free if needed).
    Returns the active broker metadata dict.

    Note on Antigravity command reaping:
      Short-lived (`IsDaemon=false`) tool commands have their child process trees terminated on exit.
      Callers in Antigravity should launch a background `watch` (`IsDaemon=true`) FIRST so the broker
      is spawned under a long-lived daemon session rather than needing a failover respawn.
    """
    key = canonical_target_key(port_url)
    with FileLock(spawn_lock_file_for_key(key), timeout=15.0):
        for mon in list_active_monitors(cleanup_stale=True):
            if mon.get("target_key") == key:
                return mon

        host_pid, host_name = find_antigravity_host_process()
        resolved_log = os.path.abspath(log_file) if log_file else default_log_file_for_key(key)

        cmd = [
            sys.executable,
            os.path.abspath(__file__),
            "_broker",
            "--port",
            port_url,
            "--baud",
            str(baud),
            "--idle-timeout",
            str(idle_timeout),
            "--log",
            resolved_log,
        ]
        if truncate:
            cmd.append("--truncate")
        if host_pid:
            cmd.extend(["--host-pid", str(host_pid), "--host-name", host_name or "Antigravity"])

        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        creationflags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

        subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
        )

        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            for mon in list_active_monitors(cleanup_stale=False):
                if mon.get("target_key") == key:
                    return mon
            time.sleep(0.05)

        raise RuntimeError(f"Timed out waiting for detached serial broker to start for '{key}'.")


# ---------------------------------------------------------------------------
# Detached Per-Board Broker Implementation
# ---------------------------------------------------------------------------

class Subscriber:
    def __init__(self, conn: socket.socket, client_pid: int, label: str):
        self.conn = conn
        self.client_pid = client_pid
        self.label = label
        self.connected_at = now_ts()
        self.lock = threading.Lock()
        self.closed = False

    def send_line(self, line: str) -> bool:
        data = line.encode("utf-8", errors="replace")
        with self.lock:
            if self.closed:
                return False
            try:
                self.conn.sendall(data)
                return True
            except OSError:
                self.closed = True
                try:
                    self.conn.close()
                except OSError:
                    pass
                return False

    def close(self) -> None:
        with self.lock:
            self.closed = True
            try:
                self.conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.conn.close()
            except OSError:
                pass


class SerialBrokerDaemon:
    def __init__(
        self,
        port_url: str,
        baud: int,
        log_file: str,
        idle_timeout: float = DEFAULT_IDLE_TIMEOUT,
        truncate: bool = False,
        host_pid: int | None = None,
        host_name: str | None = None,
    ):
        self.port_url = port_url
        self.target_key = canonical_target_key(port_url)
        self.baud = baud
        self.log_file = os.path.abspath(log_file)
        self.idle_timeout = idle_timeout
        self.host_pid = host_pid
        self.host_name = host_name

        self._lock = threading.Lock()
        self._wake_evt = threading.Event()
        self._stop_evt = threading.Event()
        self._not_connecting_evt = threading.Event()
        self._not_connecting_evt.set()

        self._ser: serial.SerialBase | None = None
        self._state = "starting"
        self._paused_until: float = 0.0
        self._pause_reason: str = ""
        self._lease_holder: dict | None = None

        self._reboot_req_evt = threading.Event()
        self._reboot_done_evt = threading.Event()
        self._reboot_err: str | None = None

        self._subscribers: list[Subscriber] = []
        self._last_activity_mono = time.monotonic()

        self._lines_logged = 0
        self._bytes_rx = 0
        self._marks: dict[str, int] = {}
        self._last_mark_offset = 0
        self._last_mark_label = ""
        self._started_iso = dt.datetime.now().astimezone().isoformat(timespec="seconds")

        os.makedirs(os.path.dirname(self.log_file) or ".", exist_ok=True)
        if not truncate and os.path.isfile(self.log_file) and os.path.getsize(self.log_file) > MAX_LOG_BYTES:
            bak = self.log_file + ".1"
            try:
                os.replace(self.log_file, bak)
            except OSError:
                pass
        mode = "w" if truncate else "a"
        self._log_fh = open(self.log_file, mode, encoding="utf-8", buffering=1)
        self._log_lock = threading.Lock()

        self._ctrl_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._ctrl_sock.bind(("127.0.0.1", 0))
        self._ctrl_sock.listen(16)
        self.ctrl_host, self.ctrl_port = self._ctrl_sock.getsockname()
        self.state_file = state_file_for_key(self.target_key)

    def _touch_activity(self) -> None:
        with self._lock:
            self._last_activity_mono = time.monotonic()

    def _broadcast(self, line: str) -> None:
        with self._lock:
            subs = list(self._subscribers)
        dead: list[Subscriber] = []
        for sub in subs:
            if not sub.send_line(line):
                dead.append(sub)
        if dead:
            with self._lock:
                for sub in dead:
                    if sub in self._subscribers:
                        self._subscribers.remove(sub)
                self._last_activity_mono = time.monotonic()

    def _write_log_and_fanout(self, formatted_line: str, is_device_line: bool = False) -> int:
        with self._log_lock:
            if self._log_fh.tell() > MAX_LOG_BYTES:
                self._log_fh.close()
                bak = self.log_file + ".1"
                try:
                    os.replace(self.log_file, bak)
                except OSError:
                    pass
                self._log_fh = open(self.log_file, "w", encoding="utf-8", buffering=1)
                with self._lock:
                    self._marks.clear()
                    self._last_mark_offset = 0
            self._log_fh.write(formatted_line)
            self._log_fh.flush()
            offset = self._log_fh.tell()
            if is_device_line:
                self._lines_logged += 1
        self._broadcast(formatted_line)
        return offset

    def _emit_meta(self, message: str) -> int:
        return self._write_log_and_fanout(f"[{now_ts()}] === [MONITOR] {message} ===\n", is_device_line=False)

    def _emit_device_line(self, text: str) -> None:
        self._write_log_and_fanout(f"[{now_ts()}] {text}\n", is_device_line=True)

    def _close_serial_locked(self) -> None:
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
            self._ser = None

    def _write_state_file(self) -> None:
        data = {
            "pid": os.getpid(),
            "host_pid": self.host_pid,
            "host_name": self.host_name,
            "target_key": self.target_key,
            "port_url": self.port_url,
            "baud": self.baud,
            "ctrl_host": self.ctrl_host,
            "ctrl_port": self.ctrl_port,
            "log_file": self.log_file,
            "idle_timeout": self.idle_timeout,
            "started_at": self._started_iso,
        }
        tmp = self.state_file + f".tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, self.state_file)

    def _remove_state_file(self) -> None:
        try:
            if os.path.isfile(self.state_file):
                with open(self.state_file, "r", encoding="utf-8") as fh:
                    cur = json.load(fh)
                if cur.get("pid") == os.getpid():
                    os.remove(self.state_file)
        except Exception:
            pass

    def _host_watchdog_loop(self, h_proc: int) -> None:
        k32 = ctypes.windll.kernel32
        try:
            while not self._stop_evt.is_set():
                rc = k32.WaitForSingleObject(wintypes.HANDLE(h_proc), 250)
                if rc == 0:  # WAIT_OBJECT_0 -> Antigravity host exited!
                    self._stop_evt.set()
                    self._wake_evt.set()
                    try:
                        self._ctrl_sock.close()
                    except OSError:
                        pass
                    break
        finally:
            k32.CloseHandle(wintypes.HANDLE(h_proc))

    def _ctrl_loop(self) -> None:
        while not self._stop_evt.is_set():
            try:
                conn, _ = self._ctrl_sock.accept()
            except OSError:
                break
            threading.Thread(target=self._handle_client, args=(conn,), daemon=True).start()

    def _read_json_line(self, conn: socket.socket) -> dict | None:
        raw = bytearray()
        while b"\n" not in raw:
            chunk = conn.recv(4096)
            if not chunk:
                return None
            raw.extend(chunk)
        line = bytes(raw).split(b"\n", 1)[0].decode("utf-8", errors="replace").strip()
        return json.loads(line) if line else {}

    def _handle_client(self, conn: socket.socket) -> None:
        conn.settimeout(5.0)
        try:
            req = self._read_json_line(conn)
            if req is None:
                conn.close()
                return
            cmd = req.get("cmd", "")
            if cmd == "subscribe":
                self._handle_subscribe(conn, req)
                return
            if cmd == "lease_port":
                self._handle_lease_port(conn, req)
                return

            resp = self._dispatch_short_cmd(req)
            conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
        except Exception as exc:
            try:
                conn.sendall((json.dumps({"ok": False, "error": str(exc)}) + "\n").encode("utf-8"))
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _handle_subscribe(self, conn: socket.socket, req: dict) -> None:
        """Keep `conn` open as a live streaming watcher until client disconnects or broker stops."""
        enable_tcp_keepalive(conn, idle_ms=15_000, interval_ms=5_000)
        conn.settimeout(None)
        tail_lines = int(req.get("tail_lines", 20))
        client_pid = int(req.get("client_pid", 0))
        label = str(req.get("label", f"pid-{client_pid}"))

        sub = Subscriber(conn, client_pid=client_pid, label=label)
        ack = {
            "ok": True,
            "broker_pid": os.getpid(),
            "state": self._state,
            "log_file": self.log_file,
        }
        if not sub.send_line(json.dumps(ack) + "\n"):
            return

        if tail_lines > 0 and os.path.isfile(self.log_file):
            try:
                with open(self.log_file, "r", encoding="utf-8", errors="replace") as fh:
                    recent = fh.readlines()[-tail_lines:]
                for ln in recent:
                    if not sub.send_line(ln):
                        return
            except Exception:
                pass

        with self._lock:
            if self._stop_evt.is_set():
                sub.send_line(f"{BROKER_STOP_SENTINEL}\n")
                sub.close()
                return
            self._subscribers.append(sub)
            self._last_activity_mono = time.monotonic()

        # Block reading until the watcher disconnects (EOF) or socket closes on shutdown
        try:
            while not self._stop_evt.is_set():
                data = conn.recv(256)
                if not data:
                    break
        except OSError:
            pass
        finally:
            with self._lock:
                if sub in self._subscribers:
                    self._subscribers.remove(sub)
                self._last_activity_mono = time.monotonic()
            sub.close()
            self._wake_evt.set()

    def _handle_lease_port(self, conn: socket.socket, req: dict) -> None:
        """
        Connection-tied exclusive port lease for `esptool`.
        Releases the serial port immediately; if the client crashes (EOF), re-acquires automatically in ms.
        """
        reason = str(req.get("reason", "esptool"))
        holder_pid = int(req.get("pid", 0))
        timeout = float(req.get("timeout", DEFAULT_PAUSE_TIMEOUT))
        self._touch_activity()

        with self._lock:
            self._lease_holder = {"pid": holder_pid, "reason": reason, "since": now_ts()}
            self._paused_until = time.monotonic() + timeout
            self._pause_reason = f"{reason} (pid={holder_pid})"
            self._close_serial_locked()
            self._state = "leased"
        self._wake_evt.set()
        self._not_connecting_evt.wait(timeout=3.0)
        time.sleep(0.08)  # Allow remote hub4com to recycle single-client TCP state
        self._emit_meta(f"Paused for {reason} (pid={holder_pid})")

        conn.sendall((json.dumps({"ok": True, "state": "leased"}) + "\n").encode("utf-8"))

        do_reset = False
        released_cleanly = False
        conn.settimeout(timeout)
        try:
            rel = self._read_json_line(conn)
            if rel and rel.get("cmd") == "release_port":
                released_cleanly = True
                do_reset = bool(rel.get("reset", False))
                conn.sendall((json.dumps({"ok": True}) + "\n").encode("utf-8"))
        except Exception:
            pass
        finally:
            with self._lock:
                self._lease_holder = None
                self._paused_until = 0.0
                self._pause_reason = ""
                if self._state == "leased":
                    self._state = "resuming"
                if do_reset:
                    self._reboot_err = None
                    self._reboot_done_evt.clear()
                    self._reboot_req_evt.set()
                self._last_activity_mono = time.monotonic()
            if released_cleanly:
                suffix = ", reset queued" if do_reset else ""
                self._emit_meta(f"Resuming after {reason} (pid={holder_pid}{suffix})")
            else:
                self._emit_meta(f"Upload lease holder (pid={holder_pid}) disconnected unexpectedly; resuming immediately")
            self._wake_evt.set()

    def _dispatch_short_cmd(self, req: dict) -> dict:
        cmd = req.get("cmd", "")
        if cmd == "ping":
            with self._lock:
                idle_elapsed = time.monotonic() - self._last_activity_mono
                idle_rem = (
                    None
                    if (self._subscribers or self._lease_holder or self._paused_until > 0 or self.idle_timeout <= 0)
                    else max(0.0, round(self.idle_timeout - idle_elapsed, 1))
                )
                return {
                    "ok": True,
                    "state": self._state,
                    "watchers": [
                        {"pid": s.client_pid, "label": s.label, "connected_at": s.connected_at}
                        for s in self._subscribers
                    ],
                    "watcher_count": len(self._subscribers),
                    "lease_holder": self._lease_holder,
                    "lines_logged": self._lines_logged,
                    "bytes_rx": self._bytes_rx,
                    "marks": dict(self._marks),
                    "last_mark_label": self._last_mark_label,
                    "last_mark_offset": self._last_mark_offset,
                    "idle_seconds_remaining": idle_rem,
                }

        self._touch_activity()

        if cmd == "pause":
            timeout = float(req.get("timeout", DEFAULT_PAUSE_TIMEOUT))
            reason = str(req.get("reason", "cli"))
            with self._lock:
                self._paused_until = time.monotonic() + timeout
                self._pause_reason = reason
                self._close_serial_locked()
                self._state = "paused"
            self._wake_evt.set()
            time.sleep(0.08)
            self._emit_meta(f"Paused ({reason}; auto-resume in {int(timeout)}s)")
            return {"ok": True, "state": "paused"}

        if cmd == "resume":
            reason = str(req.get("reason", "cli"))
            do_reset = bool(req.get("reset", False))
            with self._lock:
                was_paused = self._paused_until > 0
                self._paused_until = 0.0
                self._pause_reason = ""
                if self._state in ("paused", "leased"):
                    self._state = "resuming"
                if do_reset:
                    self._reboot_err = None
                    self._reboot_done_evt.clear()
                    self._reboot_req_evt.set()
            if was_paused:
                suffix = ", reset queued" if do_reset else ""
                self._emit_meta(f"Resuming ({reason}{suffix})")
            self._wake_evt.set()
            return {"ok": True, "state": self._state}

        if cmd == "mark":
            label = str(req.get("label", "checkpoint")).strip() or "checkpoint"
            offset = self._write_log_and_fanout(f"[{now_ts()}] === [MARK] {label} ===\n", is_device_line=False)
            with self._lock:
                self._marks[label] = offset
                self._last_mark_label = label
                self._last_mark_offset = offset
            return {"ok": True, "label": label, "offset": offset, "log_file": self.log_file}

        if cmd == "reboot":
            capture_sec = float(req.get("capture", 0.0))
            with self._log_lock:
                self._log_fh.flush()
                start_offset = self._log_fh.tell()
            with self._lock:
                if self._paused_until > 0 or self._lease_holder is not None:
                    return {"ok": False, "error": f"Monitor is currently busy ({self._state})"}
                self._reboot_err = None
                self._reboot_done_evt.clear()
                self._reboot_req_evt.set()
            self._wake_evt.set()
            if not self._reboot_done_evt.wait(timeout=5.0):
                return {"ok": False, "error": "Timed out waiting for broker to pulse RTS"}
            if self._reboot_err:
                return {"ok": False, "error": self._reboot_err}
            captured = ""
            if capture_sec > 0:
                time.sleep(capture_sec)
                with open(self.log_file, "r", encoding="utf-8", errors="replace") as fh:
                    fh.seek(start_offset)
                    captured = fh.read()
            return {"ok": True, "offset": start_offset, "captured": captured}

        if cmd == "stop":
            self._emit_meta("Stopping serial broker daemon")
            with self._lock:
                subs = list(self._subscribers)
                self._subscribers.clear()
            for sub in subs:
                sub.send_line(f"{BROKER_STOP_SENTINEL}\n")
                sub.close()
            self._stop_evt.set()
            self._wake_evt.set()
            try:
                self._ctrl_sock.close()
            except Exception:
                pass
            return {"ok": True, "state": "stopping"}

        return {"ok": False, "error": f"Unknown command '{cmd}'"}

    def run(self) -> int:
        if self.host_pid:
            h_proc = open_process_synchronize_handle(self.host_pid)
            if h_proc is None:
                # Host IDE already exited before broker finished initializing
                return 0
            threading.Thread(target=self._host_watchdog_loop, args=(h_proc,), daemon=True).start()

        self._write_state_file()
        threading.Thread(target=self._ctrl_loop, daemon=True).start()

        host_tag = f", host={self.host_name}:{self.host_pid}" if self.host_pid else ""
        self._emit_meta(
            f"Broker started on {self.port_url} @ {self.baud} baud (pid={os.getpid()}, ctrl=127.0.0.1:{self.ctrl_port}{host_tag})"
        )

        partial = bytearray()
        last_rx_monotonic = 0.0
        backoff = 0.15
        ever_connected = False

        try:
            while not self._stop_evt.is_set():
                now_m = time.monotonic()

                # Check idle auto-shutdown when 0 watchers and 0 leases/pauses are active
                with self._lock:
                    has_watchers = len(self._subscribers) > 0
                    has_lease = self._lease_holder is not None
                    paused_until = self._paused_until
                    idle_elapsed = now_m - self._last_activity_mono

                if not has_watchers and not has_lease and paused_until == 0 and self.idle_timeout > 0:
                    if idle_elapsed >= self.idle_timeout:
                        self._emit_meta(f"Idle for {int(self.idle_timeout)}s with 0 watchers; shutting down broker")
                        break

                # Handle leased / paused state & safety timeout
                if paused_until > 0:
                    if now_m >= paused_until:
                        with self._lock:
                            self._paused_until = 0.0
                            self._pause_reason = ""
                            self._lease_holder = None
                        self._emit_meta("Pause/lease safety timeout elapsed; auto-resuming")
                    else:
                        self._wake_evt.wait(timeout=min(0.5, paused_until - now_m))
                        self._wake_evt.clear()
                        continue

                # Connect to physical/RFC2217 serial port if needed
                with self._lock:
                    ser = self._ser
                if ser is None:
                    self._not_connecting_evt.clear()
                    try:
                        new_ser = open_serial_passive(self.port_url, self.baud)
                        with self._lock:
                            if self._paused_until > 0 or self._stop_evt.is_set():
                                new_ser.close()
                                continue
                            prev_state = self._state
                            self._ser = new_ser
                            self._state = "streaming"
                            ser = new_ser
                        if not ever_connected:
                            ever_connected = True
                            self._emit_meta(f"Connected to {self.port_url} @ {self.baud} baud")
                        elif prev_state == "reconnecting":
                            self._emit_meta(f"Reconnected to {self.port_url} @ {self.baud} baud")
                        backoff = 0.15
                    except Exception as exc:
                        with self._lock:
                            self._state = "reconnecting"
                        if backoff >= 1.5:
                            self._emit_meta(f"Reconnect pending ({exc})")
                        self._wake_evt.wait(timeout=backoff)
                        self._wake_evt.clear()
                        backoff = min(backoff * 1.7, 3.0)
                        continue
                    finally:
                        self._not_connecting_evt.set()

                # Handle queued hardware reboot into normal mode (3,6)
                if self._reboot_req_evt.is_set():
                    self._reboot_req_evt.clear()
                    try:
                        self._emit_meta("Triggering hardware reset via RTS pulse")
                        ser.dtr = False
                        ser.rts = True
                        time.sleep(0.1)
                        ser.rts = False
                        self._reboot_err = None
                    except Exception as exc:
                        self._reboot_err = str(exc)
                    finally:
                        self._reboot_done_evt.set()

                # Read available UART data
                try:
                    chunk = ser.read(1024)
                except Exception as exc:
                    with self._lock:
                        if self._ser is ser:
                            self._close_serial_locked()
                            if self._paused_until == 0:
                                self._state = "reconnecting"
                    if self._paused_until == 0 and not self._stop_evt.is_set():
                        self._emit_meta(f"Serial link dropped ({exc}); reconnecting...")
                    continue

                if chunk:
                    with self._lock:
                        self._bytes_rx += len(chunk)
                    partial.extend(chunk)
                    last_rx_monotonic = time.monotonic()
                    while b"\n" in partial:
                        raw_line, _, rest = partial.partition(b"\n")
                        partial = bytearray(rest)
                        text = raw_line.rstrip(b"\r").decode("utf-8", errors="replace")
                        self._emit_device_line(text)
                elif partial and (time.monotonic() - last_rx_monotonic) >= 0.25:
                    text = bytes(partial).rstrip(b"\r").decode("utf-8", errors="replace")
                    partial.clear()
                    self._emit_device_line(text)
        except KeyboardInterrupt:
            pass
        finally:
            if partial:
                text = bytes(partial).rstrip(b"\r").decode("utf-8", errors="replace")
                self._emit_device_line(text)
            with self._lock:
                subs = list(self._subscribers)
                self._subscribers.clear()
                self._close_serial_locked()
            for sub in subs:
                sub.close()
            try:
                self._ctrl_sock.close()
            except Exception:
                pass
            self._remove_state_file()
            with self._log_lock:
                self._log_fh.close()
        return 0


# ---------------------------------------------------------------------------
# Public Upload Lease Helper (used by pio_hub4com_rfc2217.py)
# ---------------------------------------------------------------------------

class UploadPortLease:
    """
    Serializes concurrent `esptool` uploads across conversations via an OS file mutex
    AND holds a live connection-tied `lease_port` socket on any running `serial_monitor.py` broker.
    """

    def __init__(self, port_spec: str | None, reason: str = "esptool", timeout: float = DEFAULT_PAUSE_TIMEOUT):
        self.port_spec = port_spec
        self.reason = reason
        self.timeout = timeout
        self._file_lock: FileLock | None = None
        self._lease_sock: socket.socket | None = None
        self.broker_active = False

    def acquire(self) -> "UploadPortLease":
        if not self.port_spec:
            return self
        key = canonical_target_key(self.port_spec)
        # 1. Serialize against concurrent esptool processes from other conversations/projects
        flock = FileLock(upload_lock_file_for_key(key), timeout=self.timeout, poll_interval=0.1)
        flock.acquire()
        self._file_lock = flock

        # 2. If a serial_monitor broker is running for `key`, acquire a live connection-tied lease
        try:
            for mon in list_active_monitors(cleanup_stale=True):
                if mon.get("target_key") == key:
                    sock = socket.create_connection((mon["ctrl_host"], int(mon["ctrl_port"])), timeout=5.0)
                    sock.settimeout(5.0)
                    req = {
                        "cmd": "lease_port",
                        "reason": self.reason,
                        "pid": os.getpid(),
                        "timeout": self.timeout,
                    }
                    sock.sendall((json.dumps(req) + "\n").encode("utf-8"))
                    buf = bytearray()
                    while b"\n" not in buf:
                        chunk = sock.recv(4096)
                        if not chunk:
                            break
                        buf.extend(chunk)
                    resp = json.loads(bytes(buf).split(b"\n", 1)[0].decode("utf-8", errors="replace") or "{}")
                    if resp.get("ok"):
                        self._lease_sock = sock
                        self.broker_active = True
                    else:
                        sock.close()
                    break
        except Exception:
            if self._lease_sock:
                try:
                    self._lease_sock.close()
                except Exception:
                    pass
                self._lease_sock = None
            self.broker_active = False
        return self

    def release(self, reset: bool = False) -> None:
        if self._lease_sock is not None:
            sock = self._lease_sock
            self._lease_sock = None
            try:
                sock.settimeout(3.0)
                sock.sendall((json.dumps({"cmd": "release_port", "reset": reset}) + "\n").encode("utf-8"))
                sock.recv(1024)
            except Exception:
                pass
            finally:
                try:
                    sock.close()
                except Exception:
                    pass
        if self._file_lock is not None:
            self._file_lock.release()
            self._file_lock = None


# Backwards-compatible shims
def notify_pause_if_running(port_spec: str | None, reason: str = "esptool", timeout: float = DEFAULT_PAUSE_TIMEOUT) -> UploadPortLease | None:
    if not port_spec:
        return None
    lease = UploadPortLease(port_spec, reason=reason, timeout=timeout).acquire()
    return lease


def notify_resume(lease: UploadPortLease | None, reason: str = "esptool", reset: bool = False) -> None:
    if lease is not None:
        lease.release(reset=reset)


# ---------------------------------------------------------------------------
# CLI Subcommand Implementations
# ---------------------------------------------------------------------------

def cmd_broker_internal(args: argparse.Namespace) -> int:
    broker = SerialBrokerDaemon(
        port_url=args.port,
        baud=args.baud,
        log_file=args.log,
        idle_timeout=args.idle_timeout,
        truncate=args.truncate,
        host_pid=args.host_pid,
        host_name=args.host_name,
    )
    return broker.run()


def cmd_ensure(args: argparse.Namespace) -> int:
    mon = ensure_broker(
        port_url=args.port,
        baud=args.baud,
        idle_timeout=args.idle_timeout,
        log_file=args.log,
        truncate=args.truncate,
    )
    print(json.dumps(mon, indent=2))
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    """
    Start (if needed) and subscribe to the detached serial broker, streaming output to stdout.
    Self-heals automatically if the broker process crashes; exits cleanly if `stop` is invoked.
    """
    mirror_fh = None
    if args.mirror_log:
        os.makedirs(os.path.dirname(os.path.abspath(args.mirror_log)) or ".", exist_ok=True)
        mirror_fh = open(args.mirror_log, "w" if args.truncate else "a", encoding="utf-8", buffering=1)

    first_attach = True
    try:
        while True:
            mon = ensure_broker(
                port_url=args.port,
                baud=args.baud,
                idle_timeout=args.idle_timeout,
                log_file=args.log,
                truncate=(args.truncate and first_attach),
            )
            tail_n = args.tail if first_attach else 0
            first_attach = False

            stopped_intentionally = False
            disconnect_err = None
            try:
                with socket.create_connection((mon["ctrl_host"], int(mon["ctrl_port"])), timeout=5.0) as sock:
                    enable_tcp_keepalive(sock, idle_ms=15_000, interval_ms=5_000)
                    req = {
                        "cmd": "subscribe",
                        "tail_lines": tail_n,
                        "client_pid": os.getpid(),
                        "label": args.label or f"watch-{os.getpid()}",
                    }
                    sock.sendall((json.dumps(req) + "\n").encode("utf-8"))
                    sock.settimeout(None)

                    buf = bytearray()
                    got_ack = False
                    while True:
                        chunk = sock.recv(4096)
                        if not chunk:
                            break
                        buf.extend(chunk)
                        while b"\n" in buf:
                            raw_line, _, rest = buf.partition(b"\n")
                            buf = bytearray(rest)
                            line = raw_line.decode("utf-8", errors="replace")
                            if not got_ack:
                                got_ack = True
                                ack = json.loads(line)
                                if not ack.get("ok"):
                                    sys.stderr.write(f"Failed to subscribe to broker: {ack}\n")
                                    return 1
                                msg = (
                                    f"[{now_ts()}] === [WATCH] Attached to broker pid={ack.get('broker_pid')} "
                                    f"({mon['target_key']}, state={ack.get('state')}) ===\n"
                                )
                                sys.stdout.write(msg)
                                sys.stdout.flush()
                                continue
                            if line.strip() == BROKER_STOP_SENTINEL:
                                stopped_intentionally = True
                                break
                            out_line = line + "\n"
                            sys.stdout.write(out_line)
                            sys.stdout.flush()
                            if mirror_fh:
                                mirror_fh.write(out_line)
                                mirror_fh.flush()
                        if stopped_intentionally:
                            break
            except KeyboardInterrupt:
                return 0
            except Exception as exc:
                disconnect_err = str(exc)

            if stopped_intentionally:
                sys.stdout.write(f"[{now_ts()}] === [WATCH] Broker stopped; exiting watcher ===\n")
                sys.stdout.flush()
                return 0

            # Unexpected broker EOF / process tree cleanup -> brief pause and failover via ensure_broker()
            detail = f" ({disconnect_err})" if disconnect_err else " (EOF)"
            sys.stdout.write(f"[{now_ts()}] === [WATCH] Broker disconnected{detail}; failing over in 0.5s... ===\n")
            sys.stdout.flush()
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        if mirror_fh:
            mirror_fh.close()


def cmd_status(args: argparse.Namespace) -> int:
    monitors = list_active_monitors(cleanup_stale=True)
    if args.port:
        key = canonical_target_key(args.port)
        monitors = [m for m in monitors if m.get("target_key") == key]
    if not monitors:
        print("No active serial monitors.")
        return 0
    print(json.dumps(monitors, indent=2))
    return 0


def cmd_mark(args: argparse.Namespace) -> int:
    mon = resolve_running_monitor(args.port)
    resp = send_ctrl_request(mon["ctrl_host"], int(mon["ctrl_port"]), {"cmd": "mark", "label": args.label})
    if not resp.get("ok"):
        sys.stderr.write(f"Failed to mark log: {resp}\n")
        return 1
    print(f"Marked '{resp['label']}' at offset {resp['offset']} in {resp['log_file']}")
    return 0


def cmd_tail(args: argparse.Namespace) -> int:
    mon = resolve_running_monitor(args.port)
    log_file = mon["log_file"]
    if not os.path.isfile(log_file):
        sys.stderr.write(f"Log file '{log_file}' does not exist.\n")
        return 1

    if args.since_mark is not None:
        marks = mon.get("marks") or {}
        if args.since_mark == "":
            offset = int(mon.get("last_mark_offset", 0))
        else:
            if args.since_mark not in marks:
                sys.stderr.write(f"Mark label '{args.since_mark}' not found (available: {list(marks.keys())}).\n")
                return 1
            offset = int(marks[args.since_mark])
        with open(log_file, "r", encoding="utf-8", errors="replace") as fh:
            fh.seek(offset)
            sys.stdout.write(fh.read())
        return 0

    with open(log_file, "r", encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()
    for line in lines[-args.lines :]:
        sys.stdout.write(line)
    return 0


def cmd_reboot(args: argparse.Namespace) -> int:
    try:
        mon = resolve_running_monitor(args.port)
    except RuntimeError:
        if not args.port:
            raise
        # No active broker; perform one-shot passive attach + RTS pulse directly
        ser = open_serial_passive(args.port, DEFAULT_BAUD)
        try:
            ser.dtr = False
            ser.rts = True
            time.sleep(0.1)
            ser.rts = False
            if args.capture > 0:
                end = time.monotonic() + args.capture
                buf = bytearray()
                while time.monotonic() < end:
                    buf.extend(ser.read(1024))
                sys.stdout.write(buf.decode("utf-8", errors="replace"))
            else:
                print("Reboot triggered.")
        finally:
            ser.close()
        return 0

    timeout = max(8.0, args.capture + 6.0)
    resp = send_ctrl_request(
        mon["ctrl_host"],
        int(mon["ctrl_port"]),
        {"cmd": "reboot", "capture": args.capture},
        timeout=timeout,
    )
    if not resp.get("ok"):
        sys.stderr.write(f"Reboot failed: {resp.get('error')}\n")
        return 1
    if args.capture > 0:
        sys.stdout.write(resp.get("captured", ""))
    else:
        print("Reboot triggered.")
    return 0


def cmd_pause(args: argparse.Namespace) -> int:
    mon = resolve_running_monitor(args.port)
    resp = send_ctrl_request(
        mon["ctrl_host"],
        int(mon["ctrl_port"]),
        {"cmd": "pause", "timeout": args.timeout, "reason": "cli"},
    )
    print(json.dumps(resp))
    return 0 if resp.get("ok") else 1


def cmd_resume(args: argparse.Namespace) -> int:
    mon = resolve_running_monitor(args.port)
    resp = send_ctrl_request(mon["ctrl_host"], int(mon["ctrl_port"]), {"cmd": "resume", "reason": "cli"})
    print(json.dumps(resp))
    return 0 if resp.get("ok") else 1


def cmd_stop(args: argparse.Namespace) -> int:
    if args.all:
        monitors = list_active_monitors(cleanup_stale=True)
        for mon in monitors:
            send_ctrl_request(mon["ctrl_host"], int(mon["ctrl_port"]), {"cmd": "stop"})
            print(f"Stopped broker on {mon['target_key']} (pid={mon['pid']}).")
        if not monitors:
            print("No active serial monitors.")
        return 0

    mon = resolve_running_monitor(args.port)
    send_ctrl_request(mon["ctrl_host"], int(mon["ctrl_port"]), {"cmd": "stop"})
    print(f"Stopped broker on {mon['target_key']} (pid={mon['pid']}).")
    return 0


def build_parser() -> argparse.ArgumentParser:
    default_port = os.environ.get("AGY_SERIAL_PORT")
    parser = argparse.ArgumentParser(description="Cooperative multi-client RFC2217 / COM serial monitor broker for Antigravity.")
    sub = parser.add_subparsers(dest="subcmd", required=True)

    # Internal detached broker entrypoint
    p_brk = sub.add_parser("_broker")
    p_brk.add_argument("--port", required=True)
    p_brk.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    p_brk.add_argument("--idle-timeout", type=float, default=DEFAULT_IDLE_TIMEOUT)
    p_brk.add_argument("--log", required=True)
    p_brk.add_argument("--truncate", action="store_true")
    p_brk.add_argument("--host-pid", type=int, default=None)
    p_brk.add_argument("--host-name", type=str, default=None)
    p_brk.set_defaults(func=cmd_broker_internal)

    # `watch` (and alias `start`) for per-conversation Background Task UI streaming
    for name in ("watch", "start"):
        p_w = sub.add_parser(name, help="Auto-start broker (if needed) and stream live serial output to stdout.")
        p_w.add_argument("--port", "-p", default=default_port, required=(default_port is None), help="COM port or rfc2217:// URL")
        p_w.add_argument("--baud", "-b", type=int, default=DEFAULT_BAUD, help=f"Baud rate (default: {DEFAULT_BAUD})")
        p_w.add_argument("--tail", type=int, default=20, help="Recent log lines to replay on attach (default: 20, 0 for none)")
        p_w.add_argument("--idle-timeout", type=float, default=DEFAULT_IDLE_TIMEOUT, help=f"Broker idle auto-exit seconds (default: {int(DEFAULT_IDLE_TIMEOUT)})")
        p_w.add_argument("--label", default=None, help="Optional watcher label shown in `status`")
        p_w.add_argument("--log", "-l", default=None, help="Optional custom shared log file path (default: %TEMP%\\agy_serial_monitor\\logs\\...)")
        p_w.add_argument("--mirror-log", default=None, help="Optional per-conversation mirror log file")
        p_w.add_argument("--truncate", action="store_true", help="Truncate log file if starting a fresh broker")
        p_w.set_defaults(func=cmd_watch)

    p_ens = sub.add_parser("ensure", help="Ensure detached broker is running for --port and return immediately.")
    p_ens.add_argument("--port", "-p", default=default_port, required=(default_port is None))
    p_ens.add_argument("--baud", "-b", type=int, default=DEFAULT_BAUD)
    p_ens.add_argument("--idle-timeout", type=float, default=DEFAULT_IDLE_TIMEOUT)
    p_ens.add_argument("--log", "-l", default=None)
    p_ens.add_argument("--truncate", action="store_true")
    p_ens.set_defaults(func=cmd_ensure)

    p_status = sub.add_parser("status", help="Show status of active serial broker(s) and watchers.")
    p_status.add_argument("--port", "-p", default=None, help="Optional target port filter")
    p_status.set_defaults(func=cmd_status)

    p_mark = sub.add_parser("mark", help="Write a named marker line into the serial log (tracked per label).")
    p_mark.add_argument("label", nargs="?", default="checkpoint", help="Marker label text")
    p_mark.add_argument("--port", "-p", default=default_port, help="Optional target port")
    p_mark.set_defaults(func=cmd_mark)

    p_tail = sub.add_parser("tail", help="Print recent lines or lines since a named `mark`.")
    p_tail.add_argument("--lines", "-n", type=int, default=50, help="Number of trailing lines (default: 50)")
    p_tail.add_argument(
        "--since-mark",
        nargs="?",
        const="",
        default=None,
        metavar="LABEL",
        help="Print lines after `mark` (optionally pass LABEL for concurrent safety)",
    )
    p_tail.add_argument("--port", "-p", default=default_port, help="Optional target port")
    p_tail.set_defaults(func=cmd_tail)

    p_reboot = sub.add_parser("reboot", help="Pulse RTS to reboot target into normal mode (3,6).")
    p_reboot.add_argument("--capture", "-c", type=float, default=0.0, help="Seconds of post-reboot serial log to capture")
    p_reboot.add_argument("--port", "-p", default=default_port, help="Optional target port")
    p_reboot.set_defaults(func=cmd_reboot)

    p_pause = sub.add_parser("pause", help="Temporarily release the serial port.")
    p_pause.add_argument("--timeout", "-t", type=float, default=DEFAULT_PAUSE_TIMEOUT)
    p_pause.add_argument("--port", "-p", default=default_port)
    p_pause.set_defaults(func=cmd_pause)

    p_resume = sub.add_parser("resume", help="Resume a paused serial broker immediately.")
    p_resume.add_argument("--port", "-p", default=default_port)
    p_resume.set_defaults(func=cmd_resume)

    p_stop = sub.add_parser("stop", help="Stop active serial broker daemon and attached watchers.")
    p_stop.add_argument("--port", "-p", default=default_port)
    p_stop.add_argument("--all", action="store_true", help="Stop all active serial brokers")
    p_stop.set_defaults(func=cmd_stop)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
