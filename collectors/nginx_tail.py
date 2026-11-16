#!/usr/bin/env python3
"""access log 收集器：持續讀取反向代理（nginx 等）的 access log，回報誰在打哪一題。

適用於 web 題掛在 nginx 後面、每一題有自己的 access log 的情況（只用標準函式庫）：

    python3 nginx_tail.py --server http://127.0.0.1:8088 --token <ingest_token> \
        --map /var/log/nginx/web1.access.log="Baby Login" \
        --map /var/log/nginx/web2.access.log=42

--map 的格式是「log 路徑=題目名稱或題目 id」。每一行的第一個欄位必須是來源 IP
（nginx 預設的 combined 格式就是）。
"""
import argparse
import json
import os
import sys
import time
from urllib import request as urlrequest


class Tail:
    """像 tail -F：會跟著 log rotate / truncate 重新開檔。"""

    def __init__(self, path):
        self.path = path
        self.fh = None
        self.ino = None
        self.buf = b""
        self._open(seek_end=True)

    def _open(self, seek_end):
        try:
            fh = open(self.path, "rb")
        except OSError:
            self.fh = None
            return
        if seek_end:
            fh.seek(0, os.SEEK_END)
        self.fh, self.ino, self.buf = fh, os.fstat(fh.fileno()).st_ino, b""

    def lines(self):
        if self.fh is None:
            self._open(seek_end=False)
            if self.fh is None:
                return []
        chunk = self.fh.read()
        if not chunk:
            try:
                st = os.stat(self.path)
                if st.st_ino != self.ino or st.st_size < self.fh.tell():
                    self.fh.close()
                    self._open(seek_end=False)
            except OSError:
                pass
            return []
        data = self.buf + chunk
        parts = data.split(b"\n")
        self.buf = parts.pop()
        return parts


def first_ip(line):
    token = line.split(b" ", 1)[0].decode("ascii", "ignore").strip("[]")
    if token and all(ch in "0123456789abcdefABCDEF.:" for ch in token) and ("." in token or ":" in token):
        return token
    return None


def main():
    ap = argparse.ArgumentParser(description="CTFd Visual access log 收集器")
    ap.add_argument("--server", required=True, help="visual 伺服器位址，例如 http://127.0.0.1:8088")
    ap.add_argument("--token", required=True, help="ingest_token")
    ap.add_argument("--map", action="append", required=True, metavar="LOG=題目",
                    help="access log 路徑與對應的題目名稱或 id，可重複指定")
    ap.add_argument("--interval", type=float, default=0.5, help="彙整回報間隔秒數（預設 0.5）")
    ap.add_argument("--exclude", default="", help="要忽略的來源 IP，逗號分隔")
    args = ap.parse_args()

    tails = []
    for item in args.map:
        path, sep, target = item.rpartition("=")
        if not sep or not path or not target:
            sys.exit(f"--map 格式錯誤：{item!r}（應為 路徑=題目）")
        tails.append((Tail(path), int(target) if target.isdigit() else target))
    exclude = {x.strip() for x in args.exclude.split(",") if x.strip()}
    url = args.server.rstrip("/") + "/api/ingest"
    print(f"開始讀取 {len(tails)} 個 log 檔", flush=True)

    failed = False
    while True:
        time.sleep(args.interval)
        counts = {}
        for tail, target in tails:
            for line in tail.lines():
                ip = first_ip(line)
                if ip and ip not in exclude:
                    counts[(ip, target)] = counts.get((ip, target), 0) + 1
        if not counts:
            continue
        events = []
        for (ip, target), n in counts.items():
            ev = {"type": "traffic", "ip": ip, "count": n}
            ev["challenge_id" if isinstance(target, int) else "challenge"] = target
            events.append(ev)
        try:
            req = urlrequest.Request(
                url, data=json.dumps({"events": events}).encode(),
                headers={"Content-Type": "application/json", "X-Visual-Token": args.token},
                method="POST")
            with urlrequest.urlopen(req, timeout=3) as resp:
                resp.read()
            if failed:
                print("已恢復與 visual 伺服器的連線", flush=True)
            failed = False
        except Exception as exc:
            if not failed:
                print(f"送出失敗（之後會持續重試）：{exc}", file=sys.stderr, flush=True)
            failed = True


if __name__ == "__main__":
    main()
