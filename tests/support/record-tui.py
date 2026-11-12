#!/usr/bin/env python3
"""Drive a real Pi terminal over a PTY and record asciinema v2 output."""
import errno
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import subprocess
import sys
import termios
import time

record_path, *command = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
started = time.monotonic()
child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
selector.register(sys.stdin, selectors.EVENT_READ)
try:
    with open(record_path, "w", encoding="utf8") as recording:
        recording.write(json.dumps({"version": 2, "width": 100, "height": 32, "timestamp": int(time.time()), "title": "Pi 1.4.0 BTW while main runs"}) + "\n")
        while child.poll() is None:
            for key, _ in selector.select(0.1):
                if key.fileobj == master:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not chunk:
                        continue
                    text = chunk.decode("utf8", errors="replace")
                    recording.write(json.dumps([round(time.monotonic() - started, 6), "o", text], ensure_ascii=False) + "\n")
                    recording.flush()
                    print(json.dumps({"output": text}), flush=True)
                else:
                    line = sys.stdin.readline()
                    if not line:
                        child.terminate()
                        break
                    request = json.loads(line)
                    if request.get("stop"):
                        child.terminate()
                        break
                    recording.write(json.dumps([round(time.monotonic() - started, 6), "i", request["text"]], ensure_ascii=False) + "\n")
                    recording.flush()
                    for char in request["text"]:
                        os.write(master, char.encode("utf8"))
                        time.sleep(0.005)
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    selector.close()
    os.close(master)
