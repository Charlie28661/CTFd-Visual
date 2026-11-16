#!/usr/bin/env python3
"""封包監聽收集器：監看題目服務的 port，回報「哪個來源 IP 正在打哪個 port」。

需要 root 權限與 scapy：
    pip install scapy
    sudo python3 sniffer.py --server http://127.0.0.1:8088 --token <ingest_token> \
        --ports 31337,8001-8010 --iface eth0

port → 題目的對應寫在 visual 伺服器的 config.json（port_map），這支程式只回報 IP 與 port。
IP → 使用者則由 CTFd 外掛回報的登入紀錄自動對應。

注意：
  * 請在「對外」的網卡上監聽（例如 eth0），才看得到玩家的真實來源 IP。
  * 如果題目前面有反向代理 / 負載平衡，來源 IP 會變成代理的 IP，
    這種情況請改用 nginx_tail.py 讀代理的 access log。
"""
import argparse
import json
import sys
import threading
import time
from urllib import request as urlrequest


def parse_ports(spec):
    """'31337,8001-8010' -> [(31337, 31337), (8001, 8010)]"""
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, hi = (int(x) for x in part.split("-", 1))
        else:
            lo = hi = int(part)
        if not (0 < lo <= hi < 65536):
            raise ValueError(f"port 範圍不正確：{part}")
        out.append((lo, hi))
    if not out:
        raise ValueError("至少要指定一個 port")
    return out


def bpf_filter(ranges, udp):
    terms = [f"dst port {lo}" if lo == hi else f"dst portrange {lo}-{hi}" for lo, hi in ranges]
    proto = "(tcp or udp)" if udp else "tcp"
    return f"{proto} and ({' or '.join(terms)})"


def post(url, token, events):
    req = urlrequest.Request(
        url, data=json.dumps({"events": events}).encode(),
        headers={"Content-Type": "application/json", "X-Visual-Token": token}, method="POST")
    with urlrequest.urlopen(req, timeout=3) as resp:
        resp.read()


def main():
    ap = argparse.ArgumentParser(description="CTFd Visual 封包監聽收集器")
    ap.add_argument("--server", required=True, help="visual 伺服器位址，例如 http://127.0.0.1:8088")
    ap.add_argument("--token", required=True, help="ingest_token")
    ap.add_argument("--ports", required=True, help="要監看的題目 port，例如 31337,8001-8010")
    ap.add_argument("--iface", help="網卡名稱（預設由 scapy 決定）")
    ap.add_argument("--interval", type=float, default=0.5, help="彙整回報間隔秒數（預設 0.5）")
    ap.add_argument("--udp", action="store_true", help="同時監看 UDP")
    ap.add_argument("--exclude", default="", help="要忽略的來源 IP，逗號分隔（例如健康檢查、代理）")
    args = ap.parse_args()

    try:
        from scapy.all import IP, IPv6, TCP, UDP, sniff
    except ImportError:
        sys.exit("需要 scapy：pip install scapy")

    ranges = parse_ports(args.ports)
    exclude = {x.strip() for x in args.exclude.split(",") if x.strip()}
    url = args.server.rstrip("/") + "/api/ingest"
    lock = threading.Lock()
    stats = {}      # (src ip, dst port) -> [新連線數, 帶資料的封包數, bytes]

    def on_packet(pkt):
        if IP in pkt:
            src = pkt[IP].src
        elif IPv6 in pkt:
            src = pkt[IPv6].src
        else:
            return
        if src in exclude:
            return
        if TCP in pkt:
            layer = pkt[TCP]
            flags = int(layer.flags)
            syn = 1 if (flags & 0x02) and not (flags & 0x10) else 0
        elif UDP in pkt:
            layer, syn = pkt[UDP], 0
        else:
            return
        size = len(layer.payload)
        if not syn and not size:
            return                      # 純 ACK 之類的不算
        with lock:
            row = stats.setdefault((src, int(layer.dport)), [0, 0, 0])
            row[0] += syn
            row[1] += 1 if size else 0
            row[2] += size

    def flusher():
        failed = False
        while True:
            time.sleep(args.interval)
            with lock:
                snapshot = dict(stats)
                stats.clear()
            if not snapshot:
                continue
            events = [{"type": "traffic", "ip": ip, "port": port,
                       "count": data or syn, "bytes": size}
                      for (ip, port), (syn, data, size) in snapshot.items()]
            try:
                for i in range(0, len(events), 2000):
                    post(url, args.token, events[i:i + 2000])
                if failed:
                    print("已恢復與 visual 伺服器的連線", flush=True)
                failed = False
            except Exception as exc:
                if not failed:
                    print(f"送出失敗（之後會持續重試）：{exc}", file=sys.stderr, flush=True)
                failed = True

    threading.Thread(target=flusher, daemon=True).start()
    flt = bpf_filter(ranges, args.udp)
    print(f"開始監聽：{flt}" + (f"（網卡 {args.iface}）" if args.iface else ""), flush=True)
    sniff(filter=flt, prn=on_packet, store=False, iface=args.iface)


if __name__ == "__main__":
    main()
