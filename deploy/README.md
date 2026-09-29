# 音遇 · 上线手册（EdgeOne 前端 + Docker 服务端 + 双端自动更新）

## 架构总览

```
玩家浏览器 ──HTTPS──▶ 腾讯 EdgeOne Pages（前端静态 + CDN，自动构建）
      │
      └──WSS──▶ 你的服务器（Docker 跑游戏服务端，nginx TLS 反代 2567）
```

推一次 main 到 GitHub：**EdgeOne 自动重新构建前端发布，Actions 自动 SSH 到你的服务器拉代码重建容器**——双端同时更新，全程无手工操作。

---

## 一、前端：腾讯 EdgeOne Pages（约 10 分钟）

1. [EdgeOne 控制台](https://console.cloud.tencent.com/edgeone) → Pages → 创建项目 → **导入 Git 仓库** → 授权并选中本仓库
2. 构建配置：
   - **构建命令**：`cd client && npm ci && npm run build`
   - **输出目录**：`client/dist`
   - **自动部署**：推到 `main` 自动构建（默认行为，确认开启）
3. **环境变量**（项目设置 → 环境变量 → 生产环境）：
   - `VITE_SERVER_URL` = `https://ws.你的域名.com`（服务端对外的 **HTTPS/WSS** 地址，末尾不带斜杠和端口）
   - 没有域名给服务器？用 `https://IP:端口` 也行但浏览器要求 WSS，必须先解决 TLS（见第二节）
4. 绑定自己的域名（可选但推荐）：Pages → 域名管理 → 添加 `你的游戏域名.com`

> 客户端地址逻辑（已写进代码）：`VITE_SERVER_URL` > 同源 > 开发态 `hostname:2567`。EdgeOne 构建时注入即可。

## 二、服务端：自己的服务器 + Docker

### 1) 服务器首次准备（一次性）

```bash
# 以 Ubuntu/Debian 为例；已有 docker 可跳过
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && relogin

# 拉代码
mkdir -p /opt && cd /opt
git clone https://github.com/ShiYioo/children-of-melody.git yinyu
cd yinyu/server

# 环境变量（docker-compose 读同目录 .env）
cat > .env <<'EOF'
TRUST_PROXY=1
ALLOW_ORIGINS=https://你的游戏域名.com
EOF

# 先跑起来（裸 2567，验证通了再套 nginx）
docker compose up -d --build
curl http://127.0.0.1:2567/   # 200 = OK
```

### 2) nginx TLS 反代（WebSocket 必须）

用仓库里的 `deploy/nginx.conf.example`：放到 `/etc/nginx/sites-available/yinyu`，改两个地方——
`server_name` 和证书路径（Let's Encrypt：`certbot --nginx -d ws.你的域名.com` 一条命令搞定）。

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
| `DEPLOY_PATH` | `/opt/yinyu` | 服务器上仓库路径 |

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
- [ ] EdgeOne 环境变量 `VITE_SERVER_URL` 已设且是 **https** 地址
- [ ] 服务器 `.env` 里 `ALLOW_ORIGINS` 包含 EdgeOne 的前端域名
- [ ] 服务器 2567 不直接暴露公网（防火墙只放行 nginx 的 80/443）
- [ ] `TRUST_PROXY=1`（在 nginx 后）
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
- 音频文件走你服务器不走 EdgeOne，CDN 压力不大但服务器带宽要够
