# 多人网络第一阶段优化计划

> 状态：代码实施、本地验收与本地 A/B 完成；待生产上线前后对比  
> 最后更新：2026-08-03  
> 范围：协议 v3、120Hz 权威物理、60Hz 服务器 tick、20Hz 快照保持不变。

## 实施进度

- [x] 创建本地计划文档并建立进度追踪。
- [x] 建立零依赖运行指标、公开统计 API、受保护指标 API 与负载烟测。
- [x] 优化连接生命周期、会话索引、房内广播、Lobby 合并与 `server_stats` 合并。
- [x] 将私房 scrypt 改为异步有界队列，拆分游戏 tick 与维护循环并隔离单房异常。
- [x] 完成静态资源 ETag、条件请求、HEAD、Range、Brotli/gzip 与压缩 LRU。
- [x] 为 BGM 增加版本化 URL、版本音频长期缓存、失败诊断及恢复联网重试。
- [x] 完成客户端 HTTP 统计轮询、WebSocket 懒连接、输入调度、暂停与重连优化。
- [x] 更新部署文档，运行新增测试、现有全量测试、语法检查与负载烟测。
- [x] 记录本地隔离烟测基线并完成代码级第一阶段验收。
- [x] 使用 Git `HEAD` 与当前工作区完成关键场景本地 A/B，并记录带宽、响应性、调度和快照结果。
- [ ] 生产上线后对比上线前后的带宽、tick p99、事件循环 p99、Lobby 字节数和快照跳过率。

## 摘要

- 保持协议 v3、120Hz 权威物理、60Hz 服务器 tick、20Hz 快照不变。
- 本阶段只消除无游戏收益的连接、广播、阻塞和输入流量；不做快照量化、二进制协议、15Hz 快照或多进程分片。
- 默认采用现有单容器部署，不引入 Nginx、Prometheus 或新运行时依赖。

## 关键接口与默认配置

### `GET /api/stats`

- 返回 `{version, serverTime, onlineCount, rooms, activeRaces}`。
- `Cache-Control: public, max-age=5, stale-while-revalidate=10`。
- 不包含房间码、昵称、IP 或会话数据。

### `GET /api/metrics`

- 仅在设置 `METRICS_TOKEN` 时启用；未设置返回 404，错误令牌返回 401。
- 使用 `Authorization: Bearer <token>`，响应 `Cache-Control: no-store`。
- 输出进程、事件循环、tick、流量、快照、Lobby、背压和认证的累计计数及最近 60 秒 p50/p95/p99。
- `/healthz` 保持现有响应兼容，Docker 健康检查不变。

### 环境变量

```text
METRICS_TOKEN=""
METRICS_LOG_INTERVAL_MS=60000
TRUST_PROXY=false
AUTH_SCRYPT_CONCURRENCY=2
AUTH_SCRYPT_QUEUE_LIMIT=32
LOBBY_BROADCAST_DEBOUNCE_MS=100
MAINTENANCE_INTERVAL_MS=500
STATIC_COMPRESSION_CACHE_BYTES=16777216
```

- 客户端协议版本和消息结构不变。
- 客户端消息硬上限由 16KiB 收紧为 2KiB，并增加每连接 `64KiB/s、128KiB burst` 字节令牌桶；现有 120 条/秒消息限制保留。

## 实施变更

### 1. 可观测性与容量基线

- 建立零依赖运行指标收集器：
  - 进程：CPU、RSS、heap、external、arrayBuffers、事件循环延迟。
  - tick：次数、耗时、忙碌跳过、catch-up 步数、达到上限次数、房间异常。
  - 网络：按消息类型统计入站/出站数量和字节。
  - 快照：大小 p50/p95/max、发送数、背压跳过数、慢连接关闭数。
  - Lobby：构建次数、广播次数、接收人数和字节数。
  - 认证：尝试、限流、队列拒绝、scrypt 耗时。
- 每 60 秒输出一条结构化汇总日志；不得记录昵称、房间码、IP、恢复令牌。
- 增加只读负载烟测工具，覆盖 Lobby 放大、活动房间、慢连接、重连风暴和私房认证。

### 2. 连接与 Lobby 优化

- 标题页、单机菜单和单机比赛不再创建 WebSocket。
- 非多人页面改为每 15 秒请求 `/api/stats`：
  - 请求成功时显示在线人数和本次 HTTP RTT。
  - 请求失败时显示离线，但不自动打开 WebSocket。
- 进入多人 Lobby 时停止 HTTP 轮询，建立 WebSocket 并启动现有 5 秒 telemetry。
- 从多人 Lobby 返回标题时关闭 WebSocket、停止 telemetry 并恢复 HTTP 轮询。
- 房间或比赛中的 30 秒恢复流程保持不变；邀请链接仍等待权威 `lobby_state` 后再尝试加入。
- 网关维护：
  - `lobbySessions: Set`
  - `roomSessions: Map<roomCode, Set<session>>`
  - 会话绑定、离开、重连和关闭时原子更新索引。
- 房内广播只遍历对应房间集合；Lobby 广播只遍历 Lobby 集合。
- Room 状态仍立即发送给房内成员；Lobby 摘要通过字段比较判断是否真正变化。
  - `ready`、换装、普通 `race_loaded` 不再触发 Lobby 广播。
  - 创建、加入、离开、踢出、主机迁移、赛道变化、容量/状态变化仍触发。
- Lobby 变化在 100ms 窗口内合并，仍发送兼容的完整 `lobby_state`；同一 payload 只序列化一次。
- 新进入 Lobby 的客户端立即收到当前完整列表，不等待 debounce。
- `server_stats` 保留兼容，但连接/关闭事件在 250ms 内合并并共享序列化。

### 3. 事件循环、认证与房间调度

- 将私房密码生成和验证改为异步 `crypto.scrypt`，保持现有 salt、32 字节结果和 `timingSafeEqual`。
- `createRoom`、`joinRoom`、`quickMatch` 统一改为异步内部接口，所有网关调用显式 `await`。
- scrypt 使用全局有界队列：默认最多 2 个并发、32 个等待；队列满时返回稳定的 `server_busy`，不阻塞比赛 tick。
- 默认忽略 `X-Forwarded-For`；仅 `TRUST_PROXY=true` 时读取代理清洗后的首个地址。
- 将房间维护拆成：
  - 60Hz 同步游戏循环：只遍历已经创建模拟器的 countdown/racing 房间。
  - 500ms 维护循环：等待成员过期、空房 TTL、加载超时、结果超时和认证清理。
- 游戏 tick 不等待比赛创建 Promise；比赛启动独立跟踪。
- 每个房间单独 `try/catch`，单房异常只隔离/取消该房间，并对重复错误限频。
- 为每场比赛预分配并复用输入数组、ACK 顺序和 roster 索引，减少短命对象及排序。
- 没有房内接收者时继续权威模拟以支持恢复，但跳过周期快照构建；恢复时生成一次当前完整快照。

### 4. 静态资源传输

- 保持现有路径白名单与目录穿越防护。
- 为文件响应增加弱 ETag、Last-Modified 及条件请求：
  - `If-None-Match` 优先于 `If-Modified-Since`。
  - 命中时返回 304 且不读取文件内容。
- `index.html` 使用 `no-cache`；其他公开资源使用 `public, max-age=0, must-revalidate`，避免未指纹文件产生版本陈旧。
- 支持 `HEAD`。
- 支持单段字节 Range：正常返回 206 和 `Content-Range`；不可满足返回 416；Range 请求使用原始表示，不压缩。
- HTML、JS、CSS、JSON、SVG、TXT 在大于 1KiB 时支持 Brotli/gzip：
  - 优先 Brotli，其次 gzip。
  - 设置 `Vary: Accept-Encoding`。
  - 异步压缩结果按文件路径、mtime、大小和编码缓存，LRU 总量上限 16MiB。
  - MP3 及其他已压缩格式不二次压缩。
- 更新部署文档，说明后续接入 CDN/反向代理时的缓存、Range 和 WebSocket Upgrade 要求。

### 5. 客户端输入与重连

- 将输入网络发送从 120Hz 固定物理循环中拆出：
  - 物理预测继续按原固定步执行。
  - 每个渲染帧最多发送一条最新输入。
  - 正常比赛最高仍为 60Hz；帧卡顿时丢弃中间重复输入，不补发突发。
- `useItem`、漂移/回看按钮边沿及油门/刹车零值切换标记为紧急输入，在当前渲染帧发送。
- 输入序号和历史记录只在 WebSocket 实际接受发送后推进。
- 在线暂停：进入暂停立即发送一次中立输入；暂停期间每 500ms 发送一次中立保活；恢复时立即发送当前控制状态。
- 重连延迟加入可测试的 ±20% 随机抖动。
- WebSocket 连接增加 10 秒握手超时。
- Lobby 页面隐藏时重试间隔放宽到 20 秒；恢复可见后立即尝试。
- 房间/比赛重连仍使用现有短退避和 30 秒截止窗口，不降低恢复体验。

## 测试、验收与发布

### 测试范围

- API 与静态服务：验证 `/healthz` 兼容、公开 stats 无敏感字段、metrics 令牌控制；覆盖 304、HEAD、Brotli/gzip、206、416、If-Range 及路径安全。
- Lobby 与网关：两个房间消息不串流；快照和 Lobby payload 均只序列化一次；`ready`、换装和普通加载确认产生 0 次 Lobby 广播；100ms 内多个摘要变化只产生 1 次完整广播。
- 认证与调度：覆盖私房创建、正确/错误密码、队列满、可信代理；人工延迟 scrypt 期间其他房间持续 tick；单房模拟异常不影响其他房间；TTL 和恢复过期允许最多 500ms 维护误差。
- 客户端：标题和单机流程不创建 WebSocket；进入/退出多人正确切换 HTTP 轮询和 WebSocket；250ms 卡顿最多发送一条输入；暂停 10 秒最多约 21 条输入且不触发 1.5 秒 AI 接管；道具边沿不丢失、不重复；序号和 ACK 恢复正确；重连抖动、隐藏页退避及连接超时可注入测试。
- 完整运行现有测试、语法检查和新增负载烟测。

### 上线顺序

1. 创建并提交本地计划文档与指标框架，采集当前基线。
2. 上线静态缓存、会话索引和 Lobby 合并。
3. 上线异步认证及双循环调度。
4. 上线客户端懒连接、输入调度和重连优化。
5. 对比上线前后带宽、tick p99、事件循环 p99、Lobby 字节数和快照跳过率。

### 验收要求

- 物理 120Hz、快照 20Hz 及协议 v3 保持不变。
- 正常网络下操控、漂移、道具和火箭起步测试无退化。
- 无持续 `catchUpCapped`，无跨房饥饿。
- 标题/单机 WebSocket 连接数降为 0。
- 与 Lobby 摘要无关的房间操作不再产生大厅流量。

## 默认假设

- 按“完整第一阶段、代码内静态优化、JSON 指标和日志”执行。
- 本阶段不设置未经生产指标验证的全局连接数或比赛数硬上限。
- 不启用 `perMessageDeflate`。
- 不修改快照字段、快照频率、权威物理或客户端 100ms 插值策略。
- 本文件在每个子阶段完成后同步更新状态和实测结果。

## 实测记录

| 时间 | 阶段 | 命令/场景 | 结果 |
| --- | --- | --- | --- |
| 2026-08-03 | 计划初始化 | 创建本文件 | 完成 |
| 2026-08-03 | API/静态/服务端/客户端 | `npm test` | 282 项全部通过 |
| 2026-08-03 | 模块导入检查 | `npm run check` | 38 个模块全部通过 |
| 2026-08-03 | 隔离负载烟测 | `npm run smoke:multiplayer` | Lobby、活动房间、慢连接策略、重连风暴、私房认证全部通过 |
| 2026-08-03 | 烟测指标 | 8 Lobby 客户端、6 重连客户端、2 个房间（1 场活动比赛） | tick p99 0.730ms；catch-up capped 0；房间异常 0；Lobby 13097 bytes；快照 p95 797 bytes |
| 2026-08-03 | 本地 A/B：Lobby | 10 个观察者、24 次无关 ready 操作 | Lobby 流量 59520B → 0B |
| 2026-08-03 | 本地 A/B：重连 | 10 个观察者、24 个连接快速连入/断开 | `server_stats` 流量 35040B → 730B（-97.9%） |
| 2026-08-03 | 本地 A/B：认证 | 12 个并发私房创建和 20ms ping | ping p95 295.25ms → 1.15ms；认证完成时间 348.86ms → 179.80ms |
| 2026-08-03 | 本地 A/B：无人接收比赛 | 80 场可恢复比赛、5 秒采样 | CPU 时间 46ms → 16ms（约 -65.2%） |
| 2026-08-03 | 本地 A/B：快照兼容 | 6 场活动比赛、12 个接收者 | 每客户端 20.20Hz → 20.16Hz，保持约 20Hz |
| 2026-08-03 | 本地 A/B：静态资源 | 同一 JS 的 Brotli、条件请求和 Range | 首次 17528B → 4247B；复验 200/17528B → 304/0B |
| 2026-08-03 | BGM 缓存与恢复 | `node --test tests\\bgm.test.js tests\\audio-settings.test.js tests\\server.test.js tests\\main-online-wiring.test.js` | 46 项全部通过；版本音频一年 immutable、Range、联网恢复及失败诊断通过 |
| 2026-08-03 | BGM 优化全量回归 | `npm test`；`npm run check` | 285 项全部通过；38 个模块全部通过 |

> 注：完整方法、数据和限制见 `MULTIPLAYER_PHASE1_LOCAL_AB_REPORT.md`。上述数据是本机隔离合成场景的代码基线，不替代生产流量基线。生产上线前后对比项保持未勾选，需在真实并发与网络条件下使用 `/api/metrics` 和结构化日志完成。
