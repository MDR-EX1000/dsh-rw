# dsh-rw 2.0.4 验收记录

本地验收日期：2026-11-25（Asia/Shanghai）。验收结束时未推送、未安装，当时运行包仍为 2.0.3。本记录描述本地测试结果；发布和安装按后续用户授权执行，当前加载版本以 `rw_info` 为准。

## 修复范围

1. SFTP 获取、业务操作和清理有 deadline/AbortSignal；关闭或缺少回调会终结等待，不依靠遗弃工具 Promise。
2. 每个操作 Scope 释放自己的 SFTP subsystem；断连/旧 generation 事件不误清除新连接状态。
3. 已派发的写入、rename、删除、patch 或 command 不自动重放；超时/取消/丢失结果明确标记 unknown。
4. Native bash foreground/background 输出补齐映射后的 `cwd`；正文保留实际远程上下文。
5. persistent shell 的预算包含初始化、排队与执行，取消后的 queued command 不晚执行。
6. 后台 launch 的取消信号贯穿 connect/open/dispatch；未派发与派发后未知结果分开报告，已证明 PID 只做有限的所有权核验清理。
7. Watch poll 每次获取新 lease，不复用已结束 Scope 的 facade；深层取消/超时不被吞成成功扫描。
8. Remote picker 取消贯穿 request body 和晚阶段 main resolver/registry/preference 更新，不做新的取消后 mutation。

## 最终结果

| 验收项 | 结果 |
|---|---|
| 完整 Vitest suite | **28 files / 741 tests passed** |
| 当前真实 Native bash output contract | **9 tests passed**，捕获安装定义 0.2.2-rc.5，`executionAttempts=0` |
| 真实 ssh2 loopback transport | **4 tests passed**，只用 127.0.0.1 ephemeral port、内存密钥和 fake 文件协议 |
| 复核后的故障组重复运行 | **87 tests × 3 rounds passed** |
| TypeScript | `pnpm run typecheck` passed |
| 构建 | `pnpm run build` passed |
| JavaScript syntax | `pnpm run lint` passed |
| Diff whitespace | `git diff --check` passed |
| 独立只读审查 | 两个 P1、一个 P2 修复后复核，范围内无剩余阻塞项 |
| 运行包隔离 | 开发目录与安装目录不同，关键文件 inode 不共享；最终 `rw_info` 仍为 **2.0.3** |

## 高信号回归

- 10 个 SFTP 方法不返回 callback；readFile 复合关闭流程遗失 final callback。
- 已派发写入响应丢失只执行一次，结果 unknown，不做自动 replay。
- 取消一个已获取的 facade 不关闭另一个正常 facade；两者均正确释放。
- shared connect 的一个等待者取消不终止其他等待者。
- late open/late success、无 exit-status、旧 ready/error/close generation 竞态。
- caller/body 必须等 provider **20ms teardown**，不是 Promise race 后假装已停止。
- shell 排队时取消/超时不关闭前序命令，也不晚执行已取消项。
- background launch 在 ready gate 中取消后，迟到 readiness 不产生业务命令 dispatch。
- 第二个 main-directory resolver 取消/超时、registry.create/setTitle 后取消，都不继续更新后续本地状态。
- 不结束的 POST body 在 Scope deadline 到达时通过真实 Readable stream destroy 终结。
- 删除旧 DTO 的 `cwd` 后，真实 Native validator 拒绝；新输出通过默认、workdir、非零退出、timeout/signal、截断和 background 校验。

## 独立审查补出的边界

- launch 原先为等 PID 而没有传入 job cancellation signal，会造成取消后迟到派发；现在 signal 已贯穿，post-dispatch PID 未证明时明确 unknown/failed。
- default main resolver 原先 catch 全部错误，可能吞掉取消后继续 registry/lastAlias 写入；现在保持取消，并在每项新 mutation 前后做活动检查。
- POST body 原先仅等 async iterator，没有接入操作预算；现在监听 Scope signal 并关闭流，不丢弃读取 Promise。

## 仍然明确的限制

- 没有访问任何用户 SSH 主机，没有重跑归档会话的编辑/补丁，没有启动或停止研究/GPU 作业。
- Loopback 是真实 SSH 协议的隔离测试，不等于已覆盖真实代理、DNS、跨机器网络拥塞或长期压力。
- ssh2 在 callback 前不暴露 exec/SFTP channel。此阶段超时/取消可能必须退役 **exact shared Client**，影响同代其他 RPC；它们会终结并报告 unknown，替换代不受影响。
- 本地 facade 关闭不声称能撤销已经发生的远端写入，也不等待远端 ACK。
- 高阶 SFTP `readFile` 仍整文件缓冲；时间/取消边界不是传输字节/内存上限。超大或无 EOF 特殊文件仍需另行设计读取契约。
- persistent shell 保留状态，但现有输出元数据仍使用 workspace anchor；不扩大动态 cwd 接口。
- TERM ACK 仅证明停止信号已被处理；输出 detail 明确说明远程进程退出尚未确认。

## 分发校验与安装来源

- 本地验收归档已校验 manifest 版本、41 个分发文件、IO 模块完整、无 tar symlink/hardlink。
- 验收归档 SHA256：`55ab5d4efb43e50042e04ab94d16cd641180bd4f9318dc2af6be6f14a56492ed`。
- 市场安装来源：`github:MDR-EX1000/dsh-rw`，读取仓库默认分支已提交的编译产物。
- 2026-11-26 发布前重新运行完整测试，仍为 **741/741 passed**。

本记录保留本地修复和验证结果，不把测试全绿当作生产环境绝对稳定的证明。发布后的安装来源、提交和实际加载版本，应通过市场更新检查与 `rw_info` 核实。
