# CTFd Visual — 即時題目流量視覺化

把 CTF 比賽中「誰正在對哪一題發送請求」即時畫出來的儀表板，適合投影在會場大螢幕或給出題 / 維運人員監看。

## 畫面

- **流量圖（中央）**：外圈是隊伍 / 玩家，內圈是題目（依分類分組上色）。每個請求是一顆從外圈飛向題目的粒子；
  兩者之間的連線越亮，代表最近打得越兇。題目節點越大越亮 = 越熱門。
  - Flag 答錯：題目上出現紅圈與 ✕
  - 解出題目：擴散光環與 ✓，並跳出通知（首殺會特別標示）
  - **首殺特寫**：有人拿下某題的首殺時，鏡頭會推近該玩家 → 跟著他的流量沿連線衝向題目 → 題目碎裂、插上旗子，
    約 8 秒後拉回全景。同時有多個首殺會排隊播放（最多排 2 個，其餘用一般解題特效）；右上角「首殺特寫」可關閉。
  - 空心圓 = 還對應不到帳號的來源 IP
- **題目熱度（左）**：近 60 秒各題請求數排行，附解出 / 答錯次數。
- **活躍隊伍（右上）**：近 60 秒最活躍的隊伍，以及他們主要在打哪一題。
- **即時動態（右下）**：事件流水帳。
- **時間軸（下）**：最近 5 分鐘每秒請求數，上方標記解出（綠三角）與答錯（紅點）。

滑鼠移到任一節點或排行列可以只看它的流量，點一下固定。右上角可切換「隊伍 / 個人」、篩選事件類型、全螢幕。

## 快速預覽

只需要 Python 3.8+，不用安裝任何套件：

```bash
python server.py --demo
```

打開 <http://localhost:8088> 就能看到模擬流量。

## 架構

```
CTFd 外掛 ──────┐  (誰開了哪題、提交 flag、下載附件；同時回報 使用者 ↔ IP)
封包監聽器 ─────┼──POST /api/ingest──▶  server.py  ──SSE──▶  瀏覽器
access log 收集器┘  (哪個 IP 正在連哪一題的服務)
```

題目服務的流量只看得到來源 IP；伺服器會用 CTFd 外掛回報的登入紀錄把 IP 對回使用者 / 隊伍。

| 路徑 | 用途 |
| --- | --- |
| `server.py` | 視覺化伺服器（收事件、推播、提供網頁），只用標準函式庫 |
| `web/` | 前端頁面 |
| `ctfd_plugin/ctfd_visual/` | CTFd 外掛 |
| `collectors/sniffer.py` | 封包監聽收集器（需要 scapy + root） |
| `collectors/nginx_tail.py` | 反向代理 access log 收集器 |
| `demo.py` | 模擬流量 |

## 正式部署

### 1. 啟動視覺化伺服器

```bash
cp config.example.json config.json   # 修改 ingest_token 與 port_map
python server.py
```

`config.json` 欄位：

| 欄位 | 說明 |
| --- | --- |
| `ingest_token` | 收集器上傳事件用的密鑰。沒設定的話每次啟動會隨機產生並印出來 |
| `view_key` | 選用。設定後要用 `http://host:8088/?key=...` 才能看儀表板 |
| `mask_ip` | `true`（預設）時，對應不到帳號的 IP 會顯示成 `anon-xxxxx` 而不是真實 IP |
| `port_map` | 題目服務的 port → 題目。值可以是題目名稱、CTFd 題目 id（數字），或 `{"challenge": 名稱, "category": 分類}`；鍵可以是單一 port 或範圍 `"8001-8010"` |
| `host_map` | 網域 → 題目（給帶有 `host` 欄位的事件用） |
| `title` | 頁面標題 |

也可以用環境變數 `VISUAL_HOST` / `VISUAL_PORT` / `VISUAL_TOKEN` / `VISUAL_VIEW_KEY` 或 `--host --port --token` 參數覆寫。

### 2. 安裝 CTFd 外掛

把 `ctfd_plugin/ctfd_visual` 整個資料夾複製到 CTFd 的 `CTFd/plugins/` 底下，設定環境變數後重啟 CTFd：

```bash
CTFD_VISUAL_URL=http://<visual 伺服器>:8088
CTFD_VISUAL_TOKEN=<ingest_token>
```

docker-compose 的寫法：

```yaml
services:
  ctfd:
    environment:
      - CTFD_VISUAL_URL=http://visual:8088
      - CTFD_VISUAL_TOKEN=換成你的token
    volumes:
      - ./CTFd_visual/ctfd_plugin/ctfd_visual:/opt/CTFd/CTFd/plugins/ctfd_visual:ro
  visual:
    image: python:3.12-slim
    working_dir: /app
    command: python server.py
    volumes:
      - ./CTFd_visual:/app:ro
    ports:
      - "8088:8088"
```

外掛回報的事件：開啟題目、Flag 正確 / 錯誤、查看提示、下載附件。其他選項：

- `CTFD_VISUAL_INCLUDE_ADMINS=1`：連管理員的操作也顯示（預設不顯示）
- `CTFD_VISUAL_SYNC=0`：不主動同步題目清單，題目被玩家碰到才會出現在畫面上

外掛只在比賽開始後同步題目，隱藏題目與尚未解鎖（有前置條件）的題目不會主動送出。

### 3. 監控題目服務的流量（擇一或併用）

**封包監聽** — 適合 pwn / nc 類題目，或題目直接對外開 port：

```bash
pip install scapy
sudo python3 collectors/sniffer.py --server http://127.0.0.1:8088 --token <ingest_token> --ports 31337,8001-8010 --iface eth0
```

要在看得到玩家真實 IP 的對外網卡上跑；port 與題目的對應寫在 `config.json` 的 `port_map`。

**讀 access log** — 適合 web 題掛在 nginx 等反向代理後面：

```bash
python3 collectors/nginx_tail.py --server http://127.0.0.1:8088 --token <ingest_token> --map /var/log/nginx/web1.access.log="Baby Login"
```

每行第一欄必須是來源 IP（nginx 預設格式即可），`--map` 可重複指定多個 log。

### 自己送事件

任何來源都可以直接打 API：

```bash
curl -X POST http://127.0.0.1:8088/api/ingest -H "X-Visual-Token: <ingest_token>" -H "Content-Type: application/json" -d '{"events":[{"type":"traffic","ip":"203.0.113.7","port":31337,"count":5}]}'
```

事件欄位：

| 欄位 | 說明 |
| --- | --- |
| `type` | `view` `download` `hint` `traffic` `fail` `solve`，或只用來建立 IP 對應的 `seen` |
| `ip` | 來源 IP |
| `user` | 選用，`{"name": ..., "team": ...}`；沒給就用 `ip` 查對應 |
| 題目 | `challenge`（物件 `{id,name,category,value}` 或名稱字串）、`challenge_id`、`port`、`host` 擇一 |
| `count` | `traffic` 事件代表的請求數（預設 1） |

## 注意事項

- **同一個對外 IP 多人共用**（例如同一間教室的 NAT）時，題目服務的流量會算在該 IP 最近一次登入的使用者身上。
- 狀態都在記憶體裡，重啟伺服器後統計會歸零（題目清單與解題數會由外掛重新同步）。
- 動態開題（每隊一個容器、port 不固定）目前沒有自動對應，需要自己把「port → 題目」的事件送進 `/api/ingest`。
- 儀表板本身沒有登入機制；要對外公開請設定 `view_key` 或放在有驗證的反向代理後面。
- CTFd 外掛是依照 CTFd 3.x 的 API 寫的，上線前請先在測試環境確認事件有正常送出。
