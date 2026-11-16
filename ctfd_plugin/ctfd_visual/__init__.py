"""CTFd 外掛：把「誰對哪一題做了什麼」即時轉送給 CTFd Visual 伺服器。

安裝：把整個 ctfd_visual 資料夾放進 CTFd/plugins/，並設定環境變數後重啟 CTFd：

    CTFD_VISUAL_URL=http://<visual 伺服器>:8088
    CTFD_VISUAL_TOKEN=<與 visual 伺服器相同的 ingest_token>
    CTFD_VISUAL_INCLUDE_ADMINS=0     # 選用，1 = 連管理員的操作也顯示
    CTFD_VISUAL_SYNC=1               # 選用，0 = 不主動同步題目清單（題目被碰到才出現）

送出的事件：
    view     開啟題目           GET  /api/v1/challenges/<id>
    solve    flag 正確          POST /api/v1/challenges/attempt
    fail     flag 錯誤 / 被限流  POST /api/v1/challenges/attempt
    hint     查看提示           GET  /api/v1/hints/<id>
    download 下載題目附件        GET  /files/<path>
    seen     其他已登入請求（只用來讓伺服器學習 IP → 使用者，供封包監聽對應）

設計原則：絕不影響 CTFd 本身 —— 所有例外都吞掉、事件用背景執行緒非同步送出、
佇列滿了就丟棄。
"""
import json
import os
import queue
import re
import threading
import time
from urllib import request as urlrequest

from flask import request, session

from CTFd.models import Challenges, Solves, db
from CTFd.utils.user import authed, get_current_user, get_ip, is_admin

try:
    from CTFd.models import ChallengeFiles, Hints
except ImportError:  # 非常舊的 CTFd
    ChallengeFiles = Hints = None

try:
    from CTFd.utils.dates import ctf_started
except ImportError:
    def ctf_started():
        return True

RE_CHALLENGE = re.compile(r"/api/v1/challenges/(\d+)/?$")
RE_ATTEMPT = re.compile(r"/api/v1/challenges/attempt/?$")
RE_HINT = re.compile(r"/api/v1/hints/(\d+)/?$")
RE_FILE = re.compile(r"/files/(.+)$")

SYNC_INTERVAL = 60      # 題目清單同步間隔（秒）
SEEN_INTERVAL = 120     # 同一個 (使用者, IP) 多久回報一次 seen
CACHE_TTL = 60


def _flag(name, default):
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


class _Sender:
    """背景送信：每個 worker 行程各一條執行緒（fork 之後才啟動）。"""

    def __init__(self, app, url, token, sync):
        self.app = app
        self.url = url.rstrip("/") + "/api/ingest"
        self.token = token
        self.sync = sync
        self.pid = None
        self.q = queue.Queue(maxsize=10000)

    def ensure(self):
        if self.pid != os.getpid():
            self.pid = os.getpid()
            self.q = queue.Queue(maxsize=10000)
            threading.Thread(target=self._run, name="ctfd-visual", daemon=True).start()

    def put(self, event):
        self.ensure()
        try:
            self.q.put_nowait(event)
        except queue.Full:
            pass

    def _run(self):
        last_sync = 0.0
        while True:
            try:
                batch = []
                try:
                    batch.append(self.q.get(timeout=1.0))
                    time.sleep(0.2)             # 稍等一下把同一瞬間的事件併成一批
                    while len(batch) < 500:
                        batch.append(self.q.get_nowait())
                except queue.Empty:
                    pass
                payload = {}
                if batch:
                    payload["events"] = batch
                if self.sync and time.time() - last_sync > SYNC_INTERVAL:
                    last_sync = time.time()
                    challenges = self._challenge_list()
                    if challenges is not None:
                        payload["challenges"] = challenges
                        payload["replace"] = True
                if payload and not self._post(payload):
                    time.sleep(2)               # visual 伺服器連不上：這批丟掉，稍後再試
            except Exception:
                time.sleep(2)

    def _post(self, payload):
        try:
            req = urlrequest.Request(
                self.url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "X-Visual-Token": self.token},
                method="POST",
            )
            with urlrequest.urlopen(req, timeout=3) as resp:
                resp.read()
            return True
        except Exception:
            return False

    def _challenge_list(self):
        """比賽開始後才同步；有前置條件（未解鎖）的題目不主動公開。"""
        with self.app.app_context():
            try:
                if not ctf_started():
                    return None
                counts = dict(
                    db.session.query(Solves.challenge_id, db.func.count(Solves.id))
                    .group_by(Solves.challenge_id).all()
                )
                out = []
                for c in Challenges.query.filter(Challenges.state == "visible").all():
                    reqs = getattr(c, "requirements", None) or {}
                    if reqs.get("prerequisites"):
                        continue
                    out.append({"id": c.id, "name": c.name, "category": c.category,
                                "value": c.value, "solves": counts.get(c.id, 0)})
                return out
            except Exception:
                return None
            finally:
                db.session.remove()


class _Tracker:
    def __init__(self, sender, include_admins):
        self.sender = sender
        self.include_admins = include_admins
        self.chal_cache = {}        # id -> (expires, meta or None)
        self.ref_cache = {}         # ("hint", id) / ("file", path) -> challenge id
        self.seen = {}              # (user id, ip) -> last report time

    def challenge_meta(self, cid):
        now = time.time()
        hit = self.chal_cache.get(cid)
        if hit and hit[0] > now:
            return hit[1]
        c = Challenges.query.filter_by(id=cid).first()
        meta = None
        if c is not None and c.state == "visible":      # 隱藏題目不外流
            meta = {"id": c.id, "name": c.name, "category": c.category, "value": c.value}
        if len(self.chal_cache) > 5000:
            self.chal_cache.clear()
        self.chal_cache[cid] = (now + CACHE_TTL, meta)
        return meta

    def lookup(self, kind, ref):
        key = (kind, ref)
        if key in self.ref_cache:
            return self.ref_cache[key]
        cid = None
        if kind == "hint" and Hints is not None:
            row = Hints.query.filter_by(id=ref).first()
            cid = getattr(row, "challenge_id", None)
        elif kind == "file" and ChallengeFiles is not None:
            row = ChallengeFiles.query.filter_by(location=ref).first()
            cid = getattr(row, "challenge_id", None)
        if len(self.ref_cache) > 20000:
            self.ref_cache.clear()
        self.ref_cache[key] = cid
        return cid

    def classify(self, response):
        """回傳 (事件類型, 題目 id)；與題目無關的請求回傳 (None, None)。"""
        path, method, status = request.path, request.method, response.status_code
        if method == "GET" and status == 200:
            m = RE_CHALLENGE.search(path)
            if m:
                return "view", int(m.group(1))
            m = RE_HINT.search(path)
            if m:
                return "hint", self.lookup("hint", int(m.group(1)))
            m = RE_FILE.search(path)
            if m:
                return "download", self.lookup("file", m.group(1))
        elif method == "POST" and RE_ATTEMPT.search(path):
            body = request.get_json(silent=True) or request.form or {}
            try:
                cid = int(body.get("challenge_id"))
            except (TypeError, ValueError):
                return None, None
            if status == 429:
                return "fail", cid
            data = (response.get_json(silent=True) or {}).get("data") or {}
            result = data.get("status")
            if result == "correct":
                return "solve", cid
            if result in ("incorrect", "ratelimited"):
                return "fail", cid
            if result == "already_solved":
                return "view", cid
        return None, None

    def track(self, response):
        self.sender.ensure()
        if "/themes/" in request.path or not authed():
            return
        ip = get_ip()
        typ, cid = self.classify(response)
        meta = self.challenge_meta(cid) if typ and cid else None
        if meta is None:
            # 與題目無關的請求：同一個 (使用者, IP) 每隔一段時間才回報一次，其餘直接略過
            key, now = (session.get("id"), ip), time.time()
            if now - self.seen.get(key, 0) <= SEEN_INTERVAL:
                return
            if len(self.seen) > 50000:
                self.seen.clear()
            self.seen[key] = now
        if not self.include_admins and is_admin():
            return
        user = get_current_user()
        if user is None:
            return
        team = getattr(user, "team", None)
        who = {"id": user.id, "name": user.name, "team": team.name if team is not None else None}
        if meta is None:
            self.sender.put({"type": "seen", "ip": ip, "user": who})
            return
        event = {"type": typ, "ip": ip, "user": who, "challenge": meta}
        if typ == "solve":
            solves = Solves.query.filter_by(challenge_id=cid).count()
            event["solves"] = solves
            event["first_blood"] = solves <= 1
        self.sender.put(event)


def load(app):
    url = os.environ.get("CTFD_VISUAL_URL", "").strip()
    token = os.environ.get("CTFD_VISUAL_TOKEN", "").strip()
    if not url or not token:
        print(" * [ctfd_visual] 未設定 CTFD_VISUAL_URL / CTFD_VISUAL_TOKEN，外掛未啟用", flush=True)
        return

    sender = _Sender(app, url, token, sync=_flag("CTFD_VISUAL_SYNC", "1"))
    tracker = _Tracker(sender, include_admins=_flag("CTFD_VISUAL_INCLUDE_ADMINS", "0"))

    @app.after_request
    def _ctfd_visual_after_request(response):
        try:
            tracker.track(response)
        except Exception:
            pass
        return response

    print(f" * [ctfd_visual] 事件將送往 {sender.url}", flush=True)
