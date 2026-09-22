# 音遇 · 上线手册

## 一次完整的上线流程

```bash
# 1) 构建（产物 client/dist 由服务器直接静态托管）
cd client && npm ci && npm run build

# 2) 装依赖 + 启动（pm2 守护：崩溃自动拉起、开机自启）
cd ../server && npm ci
npm i -g pm2
TRUST_PROXY=1 ALLOW_ORIGINS=https://your-domain.com pm2 start npm --name yinyu -- run dev
pm2 save && pm2 startup   # 按提示执行一次，开机自启
```

> `run dev` 是 nodemon/tsx 直跑。要更稳可自行加 `npm run build` 产物启动方式；
> 当前 scripts 里 dev 即入口，pm2 守护下与生产等价。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 服务器端口 | 2567 |
| `TRUST_PROXY` | `1` = 部署在 nginx 等反代后，信任 X-Forwarded-For（直连时该头可被伪造绕过 IP 限频，**别开**） | 关 |
| `ALLOW_ORIGINS` | 逗号分隔的 WebSocket 合法来源，如 `https://your-domain.com`。留空时放行同 host 与 localhost（开发） | 开发模式 |

## 已经内置的防护（代码层）

- **全消息限流**：Colyseus 原生 `maxMessagesPerSecond=60`（合法峰值 ~35/s），超限自动断开
- **NaN/Infinity 坐标拦截**：pos/furn/track 全部字段 `Number.isFinite` 显式校验（NaN 会让比较全为 false 绕过速度检查，且广播毒死客户端）
- **瞬移检查**：位移 >40 m/s 丢弃；坐标夹取在岛界与 y∈[0,40]
- **IP 并发连接上限 8**（NAT 友好）+ **来源站点白名单**（防第三方网站盗连 WebSocket）
- **逐消息限频**：聊天 0.9s/80 字、表情 0.3s 白名单、音符 20/s、献花 3s、牵手邀请 15s 过期+距离校验
- **上传**：20MB/文件 + 魔数校验（防伪装可执行文件）+ 每 IP 10 分钟 3 首 + 全库 2GB/500 首
- **字符串**：名字/聊天/歌名/URL 全部截断+控制字符清洗；URL 仅 http(s) 且 ≤500 字符

自测：服务器跑着时 `cd client && node scripts/attack-test.mjs`（NaN 洪水/消息洪水/超长聊天/恶意 URL 四类攻击，应全部通过且服务器存活）。

## nginx 层（见 nginx.conf.example）

- TLS（Let's Encrypt）+ HTTP/2 + 强制跳转
- WebSocket upgrade 反代 + 300s 读超时
- 单 IP 并发连接限 8、非上传路径 body 限 64k、上传路径 25m + 请求速率限制

## 上线前检查单

- [ ] `client && npm run build` 通过
- [ ] `node scripts/attack-test.mjs` 全绿
- [ ] 服务器只监听 127.0.0.1（或防火墙只放行 nginx）——外网直连 2567 会绕过所有 nginx 限速
- [ ] `TRUST_PROXY=1` 已设（在 nginx 后）
- [ ] `ALLOW_ORIGINS=https://你的域名` 已设
- [ ] pm2 save + startup 已执行
- [ ] 备份/监控：`pm2 logs yinyu`、磁盘（曲库 2GB 上限）

## 内网/局域网语音（ getUserMedia 的安全上下文限制）

浏览器只在 **HTTPS 或 localhost** 下开放麦克风 API。内网用 `http://192.168.x.x:5173` 访问时
`navigator.mediaDevices` 直接不存在（不是浏览器不支持语音）。每台设备一次性设置：

1. 地址栏输入 `chrome://flags`
2. 搜索 `unsafely-treat-insecure-origin-as-secure`
3. 填入 `http://192.168.x.x:5173`（你的实际访问地址），启用并重启浏览器

Edge 同理（`edge://flags`）。正式上线用 HTTPS 域名则完全无此问题。
游戏内点麦克风会给出这条指引的完整文案。

## 已知边界（诚实声明）

- 管理后台还没有：封禁名单、踢人指令、曲库清理都要 SSH 上服务器操作
- 房间是单岛单房（64 人上限）；扩容需要分房间/分岛
- 语音是 P2P WebRTC（服务器只转信令），NAT 严格的玩家可能连不上，没有 TURN 兜底
