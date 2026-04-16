"""
FUSE probe server.

Serves HTTP on :8080. GET /fuse-test runs a real FUSE mount attempt via the
libc mount() syscall — the same syscall libfuse would use — and reports which
stage failed. This is the ground-truth check for whether a container has the
kernel-level capabilities required for FUSE:

  1. /dev/fuse exists as a character device
  2. /dev/fuse can be opened O_RDWR
  3. mount("fuse", mnt, "fuse", MS_NODEV|MS_NOSUID, "fd=...,...") succeeds
     (this is what requires CAP_SYS_ADMIN + the device)
"""
import ctypes
import ctypes.util
import errno as errno_mod
import json
import os
import stat
from http.server import BaseHTTPRequestHandler, HTTPServer

MOUNT_POINT = "/tmp/fuse_probe_mnt"
MS_NODEV = 4
MS_NOSUID = 2


def _libc():
    libc_path = ctypes.util.find_library("c") or "libc.so.6"
    libc = ctypes.CDLL(libc_path, use_errno=True)
    libc.mount.argtypes = [
        ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p,
        ctypes.c_ulong, ctypes.c_void_p,
    ]
    libc.mount.restype = ctypes.c_int
    libc.umount.argtypes = [ctypes.c_char_p]
    libc.umount.restype = ctypes.c_int
    return libc


def probe_fuse():
    # Stage 1: device node must exist and be a char device
    try:
        st = os.stat("/dev/fuse")
    except FileNotFoundError:
        return {"ok": False, "stage": "device", "error": "/dev/fuse not present"}
    except PermissionError as e:
        return {"ok": False, "stage": "device", "error": f"stat: {e}"}
    if not stat.S_ISCHR(st.st_mode):
        return {"ok": False, "stage": "device", "error": "/dev/fuse not a char device"}

    # Stage 2: open the device
    try:
        fd = os.open("/dev/fuse", os.O_RDWR | os.O_CLOEXEC)
    except OSError as e:
        return {
            "ok": False, "stage": "open",
            "errno": errno_mod.errorcode.get(e.errno, e.errno), "error": str(e),
        }

    # Stage 3: the real mount syscall
    try:
        os.makedirs(MOUNT_POINT, exist_ok=True)
        libc = _libc()
        opts = f"fd={fd},rootmode=40000,user_id=0,group_id=0".encode()
        rc = libc.mount(b"fuse", MOUNT_POINT.encode(), b"fuse",
                        MS_NODEV | MS_NOSUID, opts)
        if rc != 0:
            eno = ctypes.get_errno()
            return {
                "ok": False, "stage": "mount",
                "errno": errno_mod.errorcode.get(eno, eno),
                "error": os.strerror(eno),
            }
        try:
            libc.umount(MOUNT_POINT.encode())
        except Exception:
            pass
        return {"ok": True, "stage": "mount"}
    finally:
        try:
            os.close(fd)
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/fuse-test":
            body = json.dumps(probe_fuse()).encode()
            self._send(200, "application/json", body)
        elif self.path == "/health":
            self._send(200, "text/plain", b"ok\n")
        else:
            self._send(200, "text/plain", b"fuse-probe\n")

    def log_message(self, fmt, *args):
        print("[server] " + (fmt % args), flush=True)

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"[server] listening on 0.0.0.0:8080", flush=True)
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
