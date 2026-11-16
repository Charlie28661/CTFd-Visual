"""內建模擬流量：python server.py --demo

刻意走和真實收集器一樣的路徑：
  - 平台事件（瀏覽 / 下載 / 提示 / 提交）帶使用者資訊，像 CTFd 外掛送來的
  - 題目連線事件只帶 IP + port，像封包監聽器送來的，由伺服器用 IP 對回使用者
"""
import random
import time

CHALLENGES = [
    # (名稱, 分類, 分數, 是否有獨立服務)
    ("Baby Login", "web", 100, True), ("Cookie Monster", "web", 150, True),
    ("SSTI Bakery", "web", 250, True), ("GraphQL Maze", "web", 350, True),
    ("Proto Pollution", "web", 450, True), ("Cache Me", "web", 500, True),
    ("ret2win", "pwn", 100, True), ("Format Fun", "pwn", 200, True),
    ("Heap Note", "pwn", 350, True), ("Kernel Panic", "pwn", 500, True),
    ("ROP Chain", "pwn", 300, True),
    ("Baby XOR", "crypto", 100, False), ("RSA Leak", "crypto", 200, False),
    ("Lattice Garden", "crypto", 450, False), ("ECB Penguin", "crypto", 150, True),
    ("Nonce Reuse", "crypto", 300, True),
    ("CrackMe 101", "reverse", 100, False), ("Obfuscated JS", "reverse", 200, False),
    ("VM Escape Room", "reverse", 400, False), ("Go Away", "reverse", 300, False),
    ("Packed Lunch", "reverse", 250, False),
    ("Lost PCAP", "forensics", 150, False), ("Memory Lane", "forensics", 300, False),
    ("Stego Cat", "forensics", 100, False), ("Disk Dive", "forensics", 400, False),
    ("Sanity Check", "misc", 50, False), ("Jail Break", "misc", 250, True),
    ("QR Tower", "misc", 150, False), ("OSINT Trail", "misc", 200, False),
    ("AI Whisperer", "misc", 350, True),
]

TEAMS = ["Null Pandas", "ret2cat", "0xDEAD", "貓貓蟲", "ㄐㄐ隊", "shell we?", "CakeSort",
         "StarHack", "Segfault Tea", "Heap Heap Hooray", "BitFlippers", "珍奶加密",
         "404 Found", "root 肉鬆", "Stack Smashers", "夜市 pwn 王", "DoubleSigma", "NopSled"]

HANDLES = ["alice", "bob", "carol", "dave", "eve", "frank", "grace", "heidi", "ivan", "judy",
           "mallory", "niaj", "olivia", "peggy", "rupert", "sybil", "trent", "victor", "walter",
           "xavier", "yvonne", "zoe", "kuro", "shiro", "neko", "inu", "tako", "ika", "ebi", "uni"]


def run(hub):
    rng = random.Random()
    chals = []
    for i, (name, cat, value, svc) in enumerate(CHALLENGES, start=1):
        port = 30000 + i if svc else None
        chals.append({"id": i, "name": name, "category": cat, "value": value, "port": port})
        if port:
            hub.add_port_rule(port, i)
    hub.ingest({"replace": True, "challenges": [
        {k: c[k] for k in ("id", "name", "category", "value")} for c in chals]})

    # 越低分的題目越熱門
    weights = [1.0 / (c["value"] ** 0.75) for c in chals]

    users = []
    uid = 0
    for t, team in enumerate(TEAMS):
        for m in range(rng.randint(2, 4)):
            uid += 1
            users.append({
                "id": uid, "name": f"{rng.choice(HANDLES)}{uid:02d}", "team": team,
                "ip": f"10.{20 + t}.{rng.randint(0, 3)}.{10 + m}",
                "focus": rng.choices(chals, weights)[0],
                "active": rng.random() < 0.6, "rate": rng.uniform(0.2, 0.7),
                "burst_until": 0.0,
            })
    strangers = [f"198.51.100.{rng.randint(2, 250)}" for _ in range(5)]
    solved = set()      # (team, challenge id)
    blooded = set()     # 已經有人解出的題目 id

    def platform(u, typ, c):
        return {"type": typ, "ip": u["ip"], "challenge_id": c["id"],
                "user": {"id": u["id"], "name": u["name"], "team": u["team"]}}

    def refocus(u):
        pool = [c for c in chals if (u["team"], c["id"]) not in solved] or chals
        u["focus"] = rng.choices(pool, [1.0 / (c["value"] ** 0.75) for c in pool])[0]

    # 先讓每個人「登入」一次，建立 IP → 使用者的對應
    hub.ingest({"events": [{"type": "seen", "ip": u["ip"],
                            "user": {"id": u["id"], "name": u["name"], "team": u["team"]}}
                           for u in users]})

    dt = 0.1
    while True:
        time.sleep(dt)
        now = time.time()
        events = []
        for u in users:
            if rng.random() < dt / 25:          # 平均 25 秒切換一次活躍 / 休息
                u["active"] = not u["active"] if rng.random() < 0.5 else u["active"]
            if not u["active"]:
                continue
            c = u["focus"]
            if now < u["burst_until"] and c["port"]:     # 跑腳本爆破中
                if rng.random() < dt / 0.25:
                    events.append({"type": "traffic", "ip": u["ip"], "port": c["port"],
                                   "count": rng.randint(4, 18), "bytes": rng.randint(4000, 60000)})
                continue
            if rng.random() > u["rate"] * dt:
                continue
            roll = rng.random()
            if c["port"]:
                if roll < 0.62:
                    events.append({"type": "traffic", "ip": u["ip"], "port": c["port"],
                                   "count": max(1, int(rng.lognormvariate(0.8, 0.9))),
                                   "bytes": rng.randint(200, 8000)})
                    if rng.random() < 0.006:
                        u["burst_until"] = now + rng.uniform(4, 9)
                    continue
                kind = "view" if roll < 0.90 else "download" if roll < 0.975 else "submit"
            else:
                kind = ("view" if roll < 0.62 else "download" if roll < 0.90
                        else "hint" if roll < 0.96 else "submit")
            if kind == "submit":
                key = (u["team"], c["id"])
                chance = 0.22 * (100 / (c["value"] + 50))
                if key not in solved and rng.random() < chance:
                    solved.add(key)
                    blooded.add(c["id"])
                    events.append(platform(u, "solve", c))
                    for mate in users:
                        if mate["team"] == u["team"] and mate["focus"] is c:
                            refocus(mate)
                else:
                    events.append(platform(u, "fail", c))
            else:
                events.append(platform(u, kind, c))
            if rng.random() < 0.03:
                refocus(u)
        # 沒登入過的陌生 IP 也會打題目服務
        if rng.random() < dt * 0.8:
            c = rng.choice([c for c in chals if c["port"]])
            events.append({"type": "traffic", "ip": rng.choice(strangers), "port": c["port"],
                           "count": rng.randint(1, 8)})
        if events:
            hub.ingest({"events": events})
        # 大部分題目都被解過之後重開一輪，讓 demo 一直看得到首殺特寫
        if len(blooded) >= len(chals) * 0.6:
            solved.clear()
            blooded.clear()
            hub.ingest({"challenges": [
                {"id": c["id"], "name": c["name"], "category": c["category"],
                 "value": c["value"], "solves": 0} for c in chals]})
