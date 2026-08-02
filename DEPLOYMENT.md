# Docker 部署说明

本项目由同一个 Node.js 进程提供网页、`/ws` WebSocket 联机服务和
`/healthz` 健康检查。默认 Docker Compose 配置会将 VPS 的 TCP `8888`
端口映射到容器内的 `5173` 端口。

## 1. VPS 准备

VPS 需要安装 Docker Engine、Git 和 Docker Compose 插件。确认以下命令可用：

```bash
docker --version
docker compose version
git --version
```

同时在云服务商安全组和 VPS 防火墙中开放入站 TCP `8888`。如果使用 UFW：

```bash
sudo ufw allow 8888/tcp
sudo ufw status
```

## 2. 首次部署

```bash
git clone https://github.com/semibluff888/turbo-legends.git
cd turbo-legends
docker compose up -d --build
```

检查容器和服务状态：

```bash
docker compose ps
docker compose logs --tail=100 turbo-legends
curl http://127.0.0.1:8888/healthz
```

健康检查应返回类似内容：

```json
{"status":"ok","uptimeSeconds":12,"rooms":0,"races":0,"connections":0}
```

然后访问：

```text
http://VPS的公网IP:8888/
```

网页和 WebSocket 使用相同的 IP 与端口，因此直连 IP 时不需要设置
`ALLOWED_ORIGINS`。

## 3. 更新版本

```bash
cd turbo-legends
git pull --ff-only
docker compose up -d --build
docker compose ps
```

查看实时日志：

```bash
docker compose logs -f --tail=100 turbo-legends
```

## 4. 停止或重启

```bash
docker compose restart turbo-legends
docker compose down
```

房间、比赛和断线重连令牌只保存在进程内存中。重新构建、重启或停止容器
都会清空当前房间和比赛，这是现有服务端的设计行为。项目不需要挂载数据卷。
Compose 已将容器日志限制为最多 3 个 10 MB 文件，避免长期运行无限占用磁盘。

## 5. 常见问题

- 公网打不开：检查 `docker compose ps`、VPS 防火墙和云服务商安全组是否都已
  放行 TCP `8888`。
- 页面能打开但联机失败：检查浏览器开发者工具中的 `/ws` 请求和容器日志；
  直连 IP 时请求地址应为 `ws://VPS_IP:8888/ws`。
- 容器反复重启：运行 `docker compose logs --tail=200 turbo-legends` 查看启动错误。
- 后续使用域名和 HTTPS 时，需要让反向代理同时转发普通 HTTP 请求和 `/ws` 的
  WebSocket Upgrade 请求。浏览器会自动从 `ws://` 切换为 `wss://`。

## 6. 当前部署边界

- 服务端是单进程、内存状态架构，只应运行一个副本；不能直接做多副本负载均衡。
- 游戏服务端以 60 Hz 模拟活跃比赛，VPS 容量应按同时活跃的房间数量进行压测后确定。
- 当前静态资源由 Node.js 直接提供，并统一使用 `Cache-Control: no-cache`。音频文件合计
  约 21 MB；访问量明显增大后，建议再通过 CDN 或反向代理优化静态资源缓存。
- 直接使用公网 HTTP 不加密传输。域名准备好后应启用 HTTPS。
