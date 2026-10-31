#!/usr/bin/env python3
"""Launch MCP with real OS pipes, including under restricted socket sandboxes."""

import argparse
import os
import select
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=os.environ.get("ROUTER_NODE") or shutil.which("node"))
    args = parser.parse_args()
    if not args.node:
        parser.error("Node.js >=24 is required; set ROUTER_NODE or --node")
    root = Path(__file__).resolve().parent.parent
    def log(message):
        path = os.environ.get("ROUTER_LAUNCH_LOG")
        if path:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, (message + "\n").encode())
            finally:
                os.close(fd)

    log("start")
    child = subprocess.Popen(
        [args.node, "--import", str(root / "node_modules/tsx/dist/loader.mjs"), str(root / "src/main.ts")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=os.name == "posix",
    )
    shutdown_timer = None

    def send_signal(signum):
        try:
            if os.name == "posix":
                # O grupo pode sobreviver ao líder se um descendente retém stdout.
                os.killpg(child.pid, signum)
            elif child.poll() is None:
                child.kill() if signum == signal.SIGKILL else child.terminate()
        except ProcessLookupError:
            pass

    def stop(signum=signal.SIGTERM, _frame=None):
        nonlocal shutdown_timer
        log(f"stop signal={signum} child_state={child.poll()}")
        send_signal(signum)
        if shutdown_timer is None:
            # Prazo independente da cópia: stdout pode permanecer aberto após SIGTERM.
            shutdown_timer = threading.Timer(5, lambda: send_signal(signal.SIGKILL))
            shutdown_timer.daemon = True
            shutdown_timer.start()

    def copy(source, target, input_stream=False):
        try:
            while True:
                select.select([source], [], [])
                try:
                    data = os.read(source, 65536)
                except BlockingIOError:
                    continue
                if not data:
                    log(f"eof source={source} target={target} input={input_stream}")
                    break
                log(f"read source={source} bytes={len(data)} input={input_stream}")
                while data:
                    select.select([], [target], [])
                    try:
                        written = os.write(target, data)
                    except BlockingIOError:
                        continue
                    data = data[written:]
        except (BrokenPipeError, OSError) as error:
            log(f"copy_error source={source} errno={error.errno} input={input_stream}")
        finally:
            if input_stream:
                stop()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=copy, args=(0, child.stdin.fileno(), True), daemon=True).start()
    stderr = threading.Thread(target=copy, args=(child.stderr.fileno(), 2), daemon=True)
    stderr.start()
    try:
        copy(child.stdout.fileno(), 1)
        code = child.wait()
        log(f"child_exit code={code}")
        stderr.join(timeout=1)
        return code if code >= 0 else 128 - code
    finally:
        if child.poll() is None:
            stop()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            send_signal(signal.SIGKILL)
            child.wait()
        if shutdown_timer is not None:
            shutdown_timer.cancel()
        for stream in (child.stdin, child.stdout, child.stderr):
            stream.close()


if __name__ == "__main__":
    sys.exit(main())
