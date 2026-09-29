# 音遇 · 上线手册（EdgeOne 前端 + Docker 服务端 + 双端自动更新）

## 架构总览

```
玩家浏览器 ──HTTPS──▶ 腾讯 EdgeOne Pages（前端静态 + CDN，自动构建）
      │
      ├─ /colyseus/*、/songs/* ──▶ edge-functions/ 边缘函数反代 ──HTTP──▶ 你的服务器 Docker :2567
      │
      └─（有已备案域名时的替代方案）WSS ──▶ nginx TLS 反代 2567
```

推一次 main 到 GitHub：**EdgeOne 自动重新构建前端发布，Actions 自动 SSH 到你的服务器拉代码重建容器**——双端同时更新，全程无手工操作。

---

## 一、前端：腾讯 EdgeOne Pages（约 10 分钟）

1. [EdgeOne 控制台](https://console.cloud.tencent.com/edgeone) → Pages → 创建项目 → **导入 Git 仓库** → 授权并选中本仓库
2. 构建配置：
   - **构建命令**：`cd client && npm ci && npm run build`
   - **输出目录**：`client/dist`
   - **自动部署**：推到 `main` 自动构建（默认行为，确认开启）
3. **服务端反代（免域名备案方案，当前采用）**：
   - EdgeOne Pages **没有**"反代设置"的控制台开关——反代就是**仓库根目录 `edge-functions/` 文件夹**
     （中国站文档 [127416](https://cloud.tencent.com/document/product/1552/127416) 的约定；国际站叫 `functions/`，别混），
     文件路径即路由（`edge-functions/colyseus/[[default]].js` → `/colyseus/*`），推上去随构建自动部署。
   - 目标服务器 IP 写死在两个函数文件顶部的 `TARGET` 里，服务器换 IP 时改这里。
   - 什么都不用配就能生效；**部署完成后务必实测 WebSocket 握手**（见检查单）。
4. 环境变量（可选）：`VITE_SERVER_URL` 只有在你走"独立 wss 域名"方案时才设；
   同源反代方案**不要设**，客户端会自动用 `同源/colyseus`。
5. 绑定自己的域名（可选但推荐）：Pages → 域名管理 → 添加 `你的游戏域名.com`

> 客户端地址逻辑（已写进代码）：`VITE_SERVER_URL` > 同源 `/colyseus` > 开发态 `hostname:2567`。

## 二、服务端：自己的服务器 + Docker

### 1) 服务器首次准备（一次性）

```bash
# 以 Ubuntu/Debian 为例；已有 docker 可跳过
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && relogin

# 拉代码（存储盘 /www）
mkdir -p /www && cd /www
git clone https://github.com/ShiYioo/children-of-melody.git yinyu
cd yinyu/server

# 环境变量（docker-compose 读同目录 .env）
# ALLOW_ORIGINS 必须写 EdgeOne 分配的前端域名（形如 https://xxx.edgeone.app），
# 否则玩家会被 onAuth 的来源白名单拦下
cat > .env <<'EOF'
TRUST_PROXY=1
ALLOW_ORIGINS=https://你的项目名.edgeone.app
EOF

# 先跑起来（裸 2567，验证通了再套 nginx）
docker compose up -d --build
curl http://127.0.0.1:2567/   # 200 = OK
```

### 2) nginx TLS 反代（可选——仅当你有**已备案**域名、想甩开 EdgeOne 反代时）

同源反代方案不需要这一节。要走独立 `wss.你的域名.com` 才用得上：
**宝塔面板**（/www 一般就是宝塔）：网站 → 添加站点（`ws.你的域名.com`）→ SSL 里用 Let's Encrypt 签证书 →
配置文件里把 `deploy/nginx.conf.example` 的 `location /` 段抄进去（Upgrade/Connection 头是 WebSocket 的关键，宝塔默认模板没有）。
**手动 nginx**：配置放 `/etc/nginx/sites-available/yinyu`，改 `server_name` 和证书路径，`certbot --nginx` 一条命令搞定证书。

### 3) 服务器上的曲库持久化

`docker-compose.yml` 已把 `./songs` 挂进容器——玩家上传的歌重启不丢。备份就是备份这个目录。

## 三、双端自动更新（GitHub Actions）

仓库已带 `.github/workflows/deploy-server.yml`：**push main 且 server/ 有改动 → SSH 部署**。

你要做的只是在 GitHub 仓库设置里加 4 个 Secrets（Settings → Secrets and variables → Actions）：

| Secret | 值 | 说明 |
|---|---|---|
| `DEPLOY_HOST` | `1.2.3.4` | 服务器 IP |
| `DEPLOY_USER` | `root` 或专用用户 | SSH 用户名 |
| `DEPLOY_SSH_KEY` | 私钥全文 | `ssh-keygen -t ed25519` 生成，公钥追加到服务器 `~/.ssh/authorized_keys` |
| `DEPLOY_PATH` | `/www/yinyu` | 服务器上仓库路径（存储盘 /www） |

前端侧不需要任何配置——EdgeOne 的 Git 集成本来就是 push 即构建。

### 更新流程（日常）

```bash
git push origin main
# EdgeOne：1~2 分钟后前端生效
# Actions：服务器拉代码 → docker compose up -d --build → 健康检查
# 查看部署状态：GitHub 仓库 → Actions 标签页
```

前端-only 的改动（没碰 server/）不会触发服务器重启——Actions 有 paths 过滤。

## 四、上线前检查单

- [ ] `client && npm run build` 本地通过
- [ ] `node scripts/attack-test.mjs` 四项全绿（本地对着 dev 服务器跑）
- [ ] EdgeOne 构建成功且**没有设** `VITE_SERVER_URL`（同源反代方案）
- [ ] 反代实测：浏览器控制台 `new WebSocket("wss://你的域名/colyseus")` 能看到握手（101/服务端响应），HTTP 实测 `curl https://你的域名/songs/list?owner=x` 返回 JSON
- [ ] 服务器 `.env` 里 `ALLOW_ORIGINS` 包含 EdgeOne 的前端域名
- [ ] `TRUST_PROXY=1`（在 EdgeOne 反代后）
- [ ] Actions 的 4 个 Secrets 配好，Actions 页面跑一次全绿
- [ ] 手机 4G 网络访问一次前端域名（验证 EdgeOne CDN 生效）

## 五、已内置的防护（代码层）

- **全消息限流**：Colyseus 原生 `maxMessagesPerSecond=60`（合法峰值 ~35/s），超限自动断开
- **NaN/Infinity 坐标拦截**：pos/furn/track 全字段 `Number.isFinite` 显式校验
- **瞬移检查**：位移 >40 m/s 丢弃；坐标夹取岛界与 y∈[0,40]
- **IP 并发连接上限 8** + **来源站点白名单**（`ALLOW_ORIGINS`）
- **逐消息限频**：聊天 0.9s/80 字、表情 0.3s 白名单、音符 20/s、献花 3s、牵手距离校验
- **上传**：20MB/文件 + 魔数校验 + 每 IP 10 分钟 3 首 + 全库 2GB/500 首
- 自测：`cd client && node scripts/attack-test.mjs`

## 六、内网/局域网语音（getUserMedia 安全上下文）

浏览器只在 HTTPS 或 localhost 开放麦克风。内网 HTTP 访问时每台设备一次性设置：
`chrome://flags` 搜 `unsafely-treat-insecure-origin-as-secure` → 填入访问地址 → 重启浏览器。
游戏内点麦克风会弹出完整指引。正式上线（HTTPS）无此问题。

## 七、已知边界（诚实声明）

- 服务器单房间 64 人上限；超过要分房间（matchmaking 目前没有）
- 语音走服务器中继（32KB/说话者/秒），10 人同时开麦 ≈ 320KB/s 上行，注意带宽
- 没有管理后台：封禁、踢人、清曲库要 SSH 服务器操作
- 音频文件经 EdgeOne 边缘函数反代回源，服务器带宽要够；歌多后可考虑挂对象存储
- **边缘函数请求 body 上限 1MB**（EdgeOne 限制）：经反代的歌曲**上传**会失败（下载/播放不受影响）——
  上传要么直连服务器 IP（http 页面才可行），要么上对象存储，要么接受"上传只在局域网/直连环境可用"
