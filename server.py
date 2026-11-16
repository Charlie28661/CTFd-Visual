#!/usr/bin/env python3
"""CTFd Visual — 即時題目流量視覺化伺服器（只用 Python 標準函式庫）。

資料流：
    收集器 (CTFd 外掛 / 封包監聽 / nginx log)  --POST /api/ingest-->  本伺服器
    本伺服器  --Server-Sent Events /api/stream-->  瀏覽器儀表板

執行：
    python server.py --demo            # 用模擬流量看效果
    python server.py --config config.json
"""
import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import queue
import secrets
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"

EVENT_TYPES = {"view", "download", "hint", "traffic", "fail", "solve", "seen"}
MAX_BODY = 4 * 1024 * 1024
MAX_PENDING = 4000          # 每次推播最多帶的事件數，超過就丟掉最舊的
IP_TTL = 6 * 3600           # IP → 使用者對應的有效時間
PSEUDO = "x:"               # 只存在於 port_map / host_map、CTFd 沒有的題目 id 前綴


def clean(value, limit=64):
    """把外部傳入的名稱整理成安全的短字串。"""
    if value is None:
        return None
    text = "".join(ch for ch in str(value) if ch.isprintable()).strip()
    return text[:limit] or None


def to_int(value, default=0, lo=0, hi=10 ** 9):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


class Client:
    def __init__(self):
        self.q = queue.Queue(maxsize=300)
        self.dead = False


class Hub:
    """所有共享狀態：題目清單、IP 對應、統計、已連線的瀏覽器。"""

    def __init__(self, cfg):
        self.lock = threading.RLock()
        self.cfg = cfg
        self.demo = bool(cfg.get("demo"))
        self.mask_ip = bool(cfg.get("mask_ip", True))
        self.salt = secrets.token_bytes(8)
        self.challenges = {}        # id -> dict
        self.name_index = {}        # lower(name) -> id
        self.ip_users = {}          # ip -> (user, team, ts)
        self.recent = deque(maxlen=600)
        self.timeline = deque(maxlen=300)   # [sec, platform, traffic, fail, solve]
        self.pending_events = []
        self.pending_chals = {}
        self.full_resync = False
        self.clients = set()
        self.seq = 0
        self.port_rules = []        # (lo, hi, target, category)
        self.host_map = {}
        for key, val in (cfg.get("port_map") or {}).items():
            self.add_port_rule(key, val)
        for key, val in (cfg.get("host_map") or {}).items():
            self.host_map[str(key).lower()] = self._target(val)
        threading.Thread(target=self._flush_loop, daemon=True).start()

    # ---- 設定 -------------------------------------------------------------
    @staticmethod
    def _target(val):
        if isinstance(val, dict):
            return (val.get("challenge"), clean(val.get("category"), 32))
        return (val, None)

    def add_port_rule(self, key, val):
        key = str(key).strip()
        try:
            if "-" in key:
                lo, hi = (int(x) for x in key.split("-", 1))
            else:
                lo = hi = int(key)
        except ValueError:
            print(f"[設定] 忽略無法解析的 port：{key!r}", file=sys.stderr)
            return
        target, category = self._target(val)
        with self.lock:
            self.port_rules.append((lo, hi, target, category))

    # ---- 題目 -------------------------------------------------------------
    def _public(self, c):
        return {k: c[k] for k in ("id", "name", "category", "value", "total", "solves", "fails")}

    def _upsert(self, raw):
        cid = clean(raw.get("id"), 48)
        if cid is None:
            return None
        name = clean(raw.get("name"), 80) or f"#{cid}"
        category = clean(raw.get("category"), 32) or "other"
        value = to_int(raw.get("value"))
        c = self.challenges.get(cid)
        if c is None:
            c = {"id": cid, "name": name, "category": category, "value": value,
                 "total": 0, "solves": 0, "fails": 0}
            self.challenges[cid] = c
            self.pending_chals[cid] = c
        elif (c["name"], c["category"], c["value"]) != (name, category, value):
            if self.name_index.get(c["name"].lower()) == cid:
                del self.name_index[c["name"].lower()]
            c.update(name=name, category=category, value=value)
            self.pending_chals[cid] = c
        if "solves" in raw:         # 來自 CTFd 資料庫的解題數：以它為準
            solves = to_int(raw.get("solves"))
            if solves != c["solves"]:
                c["solves"] = solves
                self.pending_chals[cid] = c
        self.name_index[name.lower()] = cid
        # 同名的臨時題目（先從 port_map 出現）併入真正的題目
        ghost = self.challenges.get(PSEUDO + name.lower())
        if ghost is not None and ghost is not c:
            c["total"] += ghost["total"]
            c["fails"] += ghost["fails"]
            del self.challenges[ghost["id"]]
            self.full_resync = True
        return cid

    def _sync(self, items, replace):
        seen = set()
        for raw in items:
            if isinstance(raw, dict):
                cid = self._upsert(raw)
                if cid:
                    seen.add(cid)
        if replace:
            for cid in [k for k in self.challenges if k not in seen and not k.startswith(PSEUDO)]:
                c = self.challenges.pop(cid)
                if self.name_index.get(c["name"].lower()) == cid:
                    del self.name_index[c["name"].lower()]
                self.full_resync = True

    def _by_ref(self, target, category=None):
        """target 可以是題目 id（數字）或題目名稱。"""
        if target is None:
            return None
        text = clean(target, 80)
        if text is None:
            return None
        if isinstance(target, int) or text.isdigit():
            if text not in self.challenges:
                self._upsert({"id": text})
            return text
        cid = self.name_index.get(text.lower())
        if cid in self.challenges:
            return cid
        return self._upsert({"id": PSEUDO + text.lower(), "name": text, "category": category})

    def _resolve_challenge(self, raw):
        ch = raw.get("challenge")
        if isinstance(ch, dict):
            return self._upsert(ch)
        if raw.get("challenge_id") is not None:
            cid = clean(raw.get("challenge_id"), 48)
            if cid is None:
                return None
            if cid not in self.challenges:
                self._upsert({"id": cid})
            return cid
        if ch is not None:
            return self._by_ref(ch, clean(raw.get("category"), 32))
        if raw.get("port") is not None:
            port = to_int(raw.get("port"), default=-1, lo=-1, hi=65535)
            for lo, hi, target, category in self.port_rules:
                if lo <= port <= hi:
                    return self._by_ref(target, category)
        if raw.get("host"):
            hit = self.host_map.get(str(raw["host"]).lower().split(":")[0])
            if hit:
                return self._by_ref(hit[0], hit[1])
        return None

    # ---- 事件 -------------------------------------------------------------
    def _anon_label(self, ip):
        if not self.mask_ip:
            return ip
        return "anon-" + hashlib.sha1(self.salt + ip.encode()).hexdigest()[:5]

    def _event(self, raw, now):
        typ = raw.get("type") or "traffic"
        if typ not in EVENT_TYPES:
            return False
        ip = clean(raw.get("ip"), 64) or ""
        user = team = None
        u = raw.get("user")
        if isinstance(u, dict):
            user, team = clean(u.get("name")), clean(u.get("team"))
        elif u is not None:
            user = clean(u)
        if team is None:
            team = clean(raw.get("team"))
        anon = False
        if user:
            if ip:
                self.ip_users[ip] = (user, team, now)
                if len(self.ip_users) > 50000:
                    cutoff = now - IP_TTL
                    self.ip_users = {k: v for k, v in self.ip_users.items() if v[2] >= cutoff}
        elif ip:
            hit = self.ip_users.get(ip)
            if hit and now - hit[2] < IP_TTL:
                user, team = hit[0], hit[1]
            else:
                user, anon = self._anon_label(ip), True
        else:
            return False
        if typ == "seen":           # 只用來學習 IP → 使用者，不產生畫面事件
            return True
        cid = self._resolve_challenge(raw)
        if cid is None:
            return False
        c = self.challenges[cid]
        count = to_int(raw.get("count"), default=1, lo=1, hi=100000) if typ == "traffic" else 1
        first_blood = False
        c["total"] += count
        if typ == "fail":
            c["fails"] += 1
        elif typ == "solve":
            first_blood = bool(raw["first_blood"]) if "first_blood" in raw else c["solves"] == 0
            if "solves" in raw:     # 事件自帶資料庫裡的解題數，避免和題目同步重複計算
                c["solves"] = max(c["solves"], to_int(raw.get("solves")))
            else:
                c["solves"] += 1
        self.seq += 1
        ev = {"id": self.seq, "ts": round(now, 3), "type": typ, "user": user, "team": team,
              "cid": cid, "count": count}
        if anon:
            ev["anon"] = True
        if typ == "solve":
            ev["solves"] = c["solves"]
        if first_blood:
            ev["fb"] = True
        size = to_int(raw.get("bytes"))
        if size:
            ev["bytes"] = size
        self.recent.append(ev)
        self.pending_events.append(ev)
        sec = int(now)
        if not self.timeline or self.timeline[-1][0] != sec:
            self.timeline.append([sec, 0, 0, 0, 0])
        col = {"traffic": 2, "fail": 3, "solve": 4}.get(typ, 1)
        self.timeline[-1][col] += count
        return True

    def ingest(self, payload):
        if not isinstance(payload, dict):
            return 0
        now = time.time()
        accepted = 0
        with self.lock:
            chals = payload.get("challenges")
            if isinstance(chals, list):
                self._sync(chals, bool(payload.get("replace")))
            events = payload.get("events")
            if isinstance(events, list):
                for raw in events:
                    if isinstance(raw, dict) and self._event(raw, now):
                        accepted += 1
        return accepted

    # ---- 推播 -------------------------------------------------------------
    def snapshot(self):
        with self.lock:
            return {
                "server_time": time.time(),
                "demo": self.demo,
                "title": self.cfg.get("title") or "CTFd Visual",
                "challenges": [self._public(c) for c in self.challenges.values()],
                "recent": list(self.recent),
                "timeline": [list(row) for row in self.timeline],
            }

    def add_client(self):
        client = Client()
        with self.lock:
            snap = self.snapshot()
            self.clients.add(client)
        return client, snap

    def remove_client(self, client):
        with self.lock:
            self.clients.discard(client)

    def _flush_loop(self):
        while True:
            time.sleep(0.1)
            with self.lock:
                if not (self.pending_events or self.pending_chals or self.full_resync):
                    continue
                msg = {}
                if self.full_resync:
                    msg["challenges_full"] = [self._public(c) for c in self.challenges.values()]
                elif self.pending_chals:
                    msg["challenges"] = [self._public(c) for c in self.pending_chals.values()
                                         if c["id"] in self.challenges]
                if self.pending_events:
                    msg["events"] = self.pending_events[-MAX_PENDING:]
                self.pending_events = []
                self.pending_chals = {}
                self.full_resync = False
                clients = list(self.clients)
            chunk = ("data: " + json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n\n").encode()
            for client in clients:
                try:
                    client.q.put_nowait(chunk)
                except queue.Full:      # 太慢的瀏覽器直接斷線，讓它自動重連拿新快照
                    client.dead = True
                    self.remove_client(client)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CTFdVisual/1.0"
    hub = None
    ingest_token = ""
    view_key = ""
    verbose = False

    def log_message(self, fmt, *args):
        if self.verbose:
            super().log_message(fmt, *args)

    # ---- 回應工具 ---------------------------------------------------------
    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _view_ok(self, query):
        if not self.view_key:
            return True
        given = (query.get("key") or [""])[0]
        return hmac.compare_digest(given.encode(), self.view_key.encode())

    def _ingest_ok(self):
        given = self.headers.get("X-Visual-Token") or ""
        auth = self.headers.get("Authorization") or ""
        if not given and auth.lower().startswith("bearer "):
            given = auth[7:].strip()
        return hmac.compare_digest(given.encode(), self.ingest_token.encode())

    # ---- 路由 -------------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path == "/api/stream":
            if not self._view_ok(query):
                return self._send(403, {"error": "bad key"})
            return self._stream()
        if url.path == "/api/state":
            if not self._view_ok(query):
                return self._send(403, {"error": "bad key"})
            return self._send(200, self.hub.snapshot())
        if url.path == "/healthz":
            return self._send(200, {"ok": True})
        return self._static(url.path)

    do_HEAD = do_GET

    def do_POST(self):
        url = urlparse(self.path)
        length = to_int(self.headers.get("Content-Length"), default=-1, lo=-1)
        if url.path != "/api/ingest":
            self.close_connection = True
            return self._send(404, {"error": "not found"})
        if length < 0 or length > MAX_BODY:
            self.close_connection = True
            return self._send(413, {"error": "body too large or missing Content-Length"})
        body = self.rfile.read(length)
        if not self._ingest_ok():
            return self._send(401, {"error": "bad token"})
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._send(400, {"error": "invalid json"})
        return self._send(200, {"accepted": self.hub.ingest(payload)})

    def _static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (WEB_DIR / rel).resolve()
        if WEB_DIR not in target.parents or not target.is_file():
            return self._send(404, "not found", "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    def _stream(self):
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        client, snap = self.hub.add_client()
        try:
            first = "event: snapshot\ndata: " + json.dumps(snap, ensure_ascii=False, separators=(",", ":")) + "\n\n"
            self.wfile.write(first.encode())
            self.wfile.flush()
            while not client.dead:
                try:
                    chunk = client.q.get(timeout=15)
                except queue.Empty:
                    chunk = b": ping\n\n"
                self.wfile.write(chunk)
                self.wfile.flush()
        except OSError:
            pass
        finally:
            self.hub.remove_client(client)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def load_config(args):
    cfg = {"host": "0.0.0.0", "port": 8088, "ingest_token": "", "view_key": "",
           "mask_ip": True, "port_map": {}, "host_map": {}, "title": "CTFd Visual"}
    path = Path(args.config) if args.config else ROOT / "config.json"
    if path.is_file():
        cfg.update(json.loads(path.read_text(encoding="utf-8")))
    elif args.config:
        sys.exit(f"找不到設定檔：{path}")
    env = os.environ
    if env.get("VISUAL_HOST"):
        cfg["host"] = env["VISUAL_HOST"]
    if env.get("VISUAL_PORT"):
        cfg["port"] = int(env["VISUAL_PORT"])
    if env.get("VISUAL_TOKEN"):
        cfg["ingest_token"] = env["VISUAL_TOKEN"]
    if env.get("VISUAL_VIEW_KEY"):
        cfg["view_key"] = env["VISUAL_VIEW_KEY"]
    if args.host:
        cfg["host"] = args.host
    if args.port:
        cfg["port"] = args.port
    if args.token:
        cfg["ingest_token"] = args.token
    cfg["demo"] = bool(args.demo)
    return cfg


def main():
    ap = argparse.ArgumentParser(description="CTFd Visual 即時流量視覺化伺服器")
    ap.add_argument("--config", help="設定檔路徑（預設讀取同目錄的 config.json）")
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    ap.add_argument("--token", help="收集器上傳事件用的 token")
    ap.add_argument("--demo", action="store_true", help="啟動內建模擬流量")
    ap.add_argument("--verbose", action="store_true", help="印出每個 HTTP 請求")
    args = ap.parse_args()
    cfg = load_config(args)

    generated = not cfg["ingest_token"]
    if generated:
        cfg["ingest_token"] = secrets.token_urlsafe(24)

    hub = Hub(cfg)
    Handler.hub = hub
    Handler.ingest_token = cfg["ingest_token"]
    Handler.view_key = cfg.get("view_key") or ""
    Handler.verbose = args.verbose

    if cfg["demo"]:
        import demo
        threading.Thread(target=demo.run, args=(hub,), daemon=True).start()

    httpd = Server((cfg["host"], cfg["port"]), Handler)
    shown = "localhost" if cfg["host"] in ("0.0.0.0", "::") else cfg["host"]
    suffix = f"/?key={cfg['view_key']}" if cfg.get("view_key") else "/"
    print(f"CTFd Visual 已啟動： http://{shown}:{cfg['port']}{suffix}")
    if generated:
        print(f"未設定 ingest_token，本次自動產生： {cfg['ingest_token']}")
    if cfg["demo"]:
        print("DEMO 模式：正在產生模擬流量")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
