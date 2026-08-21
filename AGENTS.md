# Coding Usage Bar 维护说明

Coding Usage Bar 是独立开源项目，也是本工具的唯一事实源。它读取本机 Claude Code / Codex 已产生的 coding plan usage，计算燃烧节奏，并通过 SwiftBar 菜单栏和系统通知提醒用户。

功能、文档、发布和 issue 一律在本仓维护，不依赖或回写其他仓库。

## 设计边界

- 不处理登录态，不托管凭据，不把 API key 上传到任何中间服务；GLM、DeepSeek、MiniMax 的 key 只从本地配置读取并直接发送给对应 Provider API。
- Kimi 的 key 优先读 `~/.coding-usage-bar/config.json` 的 `kimi.apiKey`；为空时回退到 `~/.config/claude-lanes/config.env` 中 `CONFIG_<n>_BASE_URL` 指向 kimi.com 的 lane（用其 `AUTH_TOKEN` 和 base URL），不硬编码 lane 编号。
- 不主动请求 Claude/Codex 的内部 usage backend；v1 只使用本机已有 usage 结果。
- Codex 数据源是 `~/.codex` session/rollout JSONL 中的 `payload.rate_limits`。
- Claude 数据源是 `coding-usage-bar ingest claude-statusline` 写入的 `~/.coding-usage-bar/claude/latest.json`。
- Claude Code 已有 `statusLine.command` 归用户所有；安装器不能覆盖用户脚本。
- 如果用户没有 Claude status line，安装器可以创建 Coding Usage Bar 管理的最小 status line。
- 如果用户已有 Claude status line 且未接入 Coding Usage Bar ingest，安装器必须交互式请求确认，并说明会写入 Coding Usage Bar wrapper、保存原命令元数据、更新 Claude settings。用户确认后才可接入；用户拒绝或非交互环境必须跳过修改，输出手动接入步骤，并说明 Claude burn-rate 分析、Claude 通知和 Claude 菜单栏数据会缺失，Codex 不受影响。
- 通过 wrapper 接入已有 Claude status line 时，卸载必须恢复用户原始 `statusLine.command`，不能直接删除用户原有配置。
- 通过 `npx coding-usage-bar install` 安装时，Claude status line 不能依赖 PATH 中存在全局 `coding-usage-bar`；脚本必须调用 `~/.coding-usage-bar/app/dist/cli.js` 这份稳定副本。

## 运行与分发

- npm 包名和 CLI 命令名都是 `coding-usage-bar`。
- 用户入口是 `npx coding-usage-bar install`。
- 日常命令是 `coding-usage-bar doctor` 和 `coding-usage-bar status`。
- 普通 commit 不自动发布。只有明确准备 Release 时才更新版本、发布 npm 并创建 GitHub Release。
- provider 监控范围由 `~/.coding-usage-bar/config.json` 的 `providers` 控制，默认 `["codex", "claude", "glm", "deepseek", "minimax", "kimi"]`；临时覆盖可用 `CODING_USAGE_BAR_PROVIDERS=codex,claude`。
- v1 完整支持 macOS launchd；Windows 只保留通知/调度设计，不承诺可用。
- 安装器必须把当前构建产物复制到 `~/.coding-usage-bar/app/`，launchd 只能指向该稳定副本，不能指向 npx 临时缓存。
- 安装器必须创建用户级 CLI shim：`~/.local/bin/coding-usage-bar -> ~/.coding-usage-bar/app/dist/cli.js`，否则 `coding-usage-bar doctor/status` 不能作为日常命令直接使用。
- 安装器必须检查 SwiftBar；macOS 上缺失时通过 Homebrew cask 安装 SwiftBar，然后安装/更新 Coding Usage Bar SwiftBar 插件并启动 SwiftBar。
- SwiftBar 插件目录必须读取 SwiftBar 当前 `PluginDirectory`，不能硬编码 `~/Library/Application Support/SwiftBar/Plugins`。用户可能已经把插件目录设到别处。
- 重复安装必须覆盖两个入口：`npx --no-install coding-usage-bar install` 更新 `~/.coding-usage-bar/app`；已安装后的 `coding-usage-bar install` 不能删除正在运行的 `~/.coding-usage-bar/app`，只能跳过 runtime 自复制并刷新 CLI shim、SwiftBar 插件和 launchd。
- 安装器必须复制 `assets/` 到 `~/.coding-usage-bar/app/assets/`；静态图标只作为 fallback。`terminal-notifier` 的主要视觉表达应使用运行时生成的动态数据卡片。
- 重复执行 `coding-usage-bar install` 必须完整安装最新代码，并重启 launchd agent，不能只更新文件不重启。
- `~/.coding-usage-bar/status.json` 是展示层唯一稳定数据入口。CLI、未来 watch、Menu Bar app、iTerm badge 都应读取该结构，不要重复实现采集逻辑。
- `coding-usage-bar status` 默认读取 `~/.coding-usage-bar/status.json`；只有 `--refresh`、`--fixtures` 或 daemon 才应触发本机 usage 采集。
- Menu Bar v1 使用 SwiftBar 插件作为薄展示层：`coding-usage-bar menubar render` 只读 `status.json`，`coding-usage-bar menubar install` 只安装 wrapper 插件，不采集 provider 数据。`coding-usage-bar uninstall` 只删除本工具管理的插件，不卸载 SwiftBar 本体。

## 已知踩坑：展示层不能越权采集

- 不要为了“实时”让 `coding-usage-bar status`、`coding-usage-bar menubar render`、SwiftBar 渲染函数或未来 GUI 直接读取 `~/.codex`、Claude status line cache 之外的原始源。
- 正确分层是：producer 读取原始源并写 `~/.coding-usage-bar/status.json`；display 只读 `~/.coding-usage-bar/status.json`。
- 允许触发采集的入口只有 `coding-usage-bar daemon --once`、launchd daemon、`coding-usage-bar status --refresh`、`coding-usage-bar ingest claude-statusline` 这类 producer 命令。
- SwiftBar 插件如果需要更实时，应该先执行 `coding-usage-bar daemon --once` 更新 `status.json`，再执行 `coding-usage-bar menubar render`；不要把采集逻辑塞进 `renderMenuBar()`。
- `loadDisplayStatusSnapshot()` 在 `status.json` 不存在时不能 fallback 到采集原始源；应返回 `STATUS_MISSING`，提示用户运行 producer。
- 如果发现 stale，先检查 producer 是否生成了新的 `status.json`，以及 collector 是否能从 session 数据源读到最新 `rate_limits`；不要用“让展示层自己采集”绕过问题。
- Codex collector 属于 producer 侧，可以优化扫描范围和排序。它应只扫描 `~/.codex/sessions` 与 `~/.codex/archived_sessions`，不要递归整个 `~/.codex`，避免读到 `.tmp`、插件 fixture 或其他非 session JSONL。
- 必须保留回归测试覆盖这个边界：缺少 `status.json` 时，display 入口不采集原始源；非 session JSONL 不会被 Codex collector 当作 usage 来源。

## 燃烧策略

- `low` 是默认档，保守保护 7d 额度。
- `high` 是激进档，但仍受 7d 总预算约束。
- 不鼓励每个 5h 窗口打满；核心目标是在 7d 总预算下让 5h 不空转。
- 样本不足时状态为 `RAW`，只能展示原始 usage 和 limit risk，不能假装给动态建议。

## 菜单栏图标与插件保护

- `titleImageValue` 使用 AppKit/JXA 渲染复合标题图像，每个 provider 有独立标识和文字段。Provider 标识资产不适用 MIT License，必须登记在 `THIRD_PARTY_NOTICES.md`；缺少资产时由 `PROVIDER_ICON_FALLBACK` 的 SF Symbol 兜底，不能让整个复合标题退化成挤在一起的静态图。
- 任何涉及 `menubar.ts`、`install.ts`、`daemon.ts`、`cli.ts` 的代码变更，在执行完 `npm test` 和 `coding-usage-bar install` 后，**必须验证 SwiftBar 插件文件仍然存在**：
  1. 读取 SwiftBar 当前 `PluginDirectory`：`defaults read com.ameba.SwiftBar PluginDirectory`
  2. 确认 `<PluginDirectory>/coding-usage-bar.1m.js` 文件存在且可执行
  3. 如果文件丢失，立即执行 `coding-usage-bar menubar install` 恢复
- 不要假设 `coding-usage-bar install` 写入的插件文件在 SwiftBar 重启后仍然保留。SwiftBar 可能在插件执行出错时清除或跳过插件文件。每次验证流程结束前都要重新检查。
- SwiftBar 插件模板中 `swiftbar.refreshOnOpen` 必须是 `false`。该选项为 `true` 时，SwiftBar 会在每次展开 dropdown 时重新执行插件脚本（重跑 node + 多次 osascript 渲染图标/进度条 + base64 编码），用户点击菜单栏会感到明显卡顿。dropdown 里有 `Refresh now` 项 + SwiftBar 1 分钟自调度，refreshOnOpen 关闭后体验无损。
- dropdown 的全部 provider 视觉内容必须合成为**单张复合卡片图**（`renderUsageCard`），全菜单 `image=` 项恒为 2（标题 + 卡片）。SwiftBar 在输出任意字节变化时整体重建菜单，重建成本随带图菜单项**数量**增长、与字节量无关（实测：17 个小图 = 每次数据刷新 6-8 秒 WindowServer 100%+ 风暴；标题 + 单卡 200KB = ≤2 秒单采样点波澜）。禁止回退到逐行小图；交互行（Refresh/Collapse/issues）保持纯文本。
- 菜单栏和 dropdown 的图像**禁止使用 SwiftBar 的 `image=light,dark` 逗号双图语法**：该语法的明暗选择随 SwiftBar 版本漂移（2.1 之前 dropdown 双图有 #399 bug，2.1.x 的修复把三元写反了——亮色菜单反而取 dark 图，白字贴在亮菜单上不可读）。正确做法是渲染时用 `systemPrefersDark()`（读 `defaults read -g AppleInterfaceStyle`，可被 `CODING_USAGE_BAR_APPEARANCE=light|dark` 覆盖）自选变体，只输出**单张**图——单图在所有 SwiftBar 版本上行为一致。外观切换靠下一次 1 分钟渲染跟进。
- 卡片文字由 install 时 `bakeGlyphAtlases`（一次性 osascript/AppKit，SF monospacedDigit 字形烘焙到 `~/.coding-usage-bar/glyphs/`）提供，运行时渲染进程绝不 spawn osascript/AppKit。字形图集缺失或损坏时，dropdown 必须退化为**零图纯文本行**（ANSI meter + SF Symbol 图标），用 `coding-usage-bar menubar bake-glyphs` 修复。回归测试必须覆盖：卡片模式 dropdown 恰好 1 个 image 项、fallback 模式 0 个 image 项、输出 byte-stable。

## Provider usage 解析原则

- 每个 provider 的 collector 必须**完整读取 API 返回的 usage 信号**。不能只解析一类信号就把另一种信号当 0 处理。
- MiniMax 的 `/v1/token_plan/remains` 对每个 model 返回两套信号：count 维度（`current_*_usage_count` / `current_*_total_count`，适用于 video 等配额计数型）和 percent 维度（`current_*_remaining_percent`，0-100，适用于 general 这种信用消耗型）。`general` 的 `total_count` 永远是 0，必须从 `100 - remaining_percent` 推出 used%；如果只看 count 维度，credit-based 账户会永远显示 0%。
- 同样的原则适用于其它可能扩展 percent 字段的 provider：解析时优先取真实信号，不要因为一种信号缺省就 0% 兜底，而要看另一种信号是否给出真实值。
- GLM 的 `TOKENS_LIMIT` 在零用量新窗口时**整个省略 `nextResetTime`**（与 Kimi 省略零值 `used` 同款坑）：不能对该字段裸调 `new Date(...).toISOString()`（抛 `Invalid time value` 会毁掉整次 live 采集），也不能因缺 reset time 丢弃真实的 0% 信号。窗口识别按 shape（unit 3 + number 5 = 5h，unit 6 + number 1 = 周窗口），不能只按 nextResetTime 排序；reset time 缺省时用 observedAt 兜底（展示为 reset due）。
- 解析逻辑变动必须同步加测试覆盖两种信号（count > 0、percent-only、两者都缺）。

## 验证

修改本工具后至少运行：

```bash
npm ci
npm test
npm run build
npx --no-install coding-usage-bar doctor --dry-run
npx --no-install coding-usage-bar status --fixtures
npx --no-install coding-usage-bar menubar render
npm pack --dry-run
```

每次 `coding-usage-bar install` 后必须确认 SwiftBar 插件文件存在：
```bash
PLUGINDIR=$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || echo "$HOME/Library/Application Support/SwiftBar/Plugins")
ls -la "$PLUGINDIR/coding-usage-bar.1m.js"
```

如果文件不存在，执行 `coding-usage-bar menubar install` 恢复后再继续验证。

安装器变更必须先用临时 `HOME`、临时 SwiftBar 插件目录和隔离 npm prefix 做端到端安装验证，不能让测试读写用户真实的 `~/.claude`、`~/.coding-usage-bar` 或 SwiftBar 插件。真实安装和 npm 发布属于外部状态变更，必须得到用户明确确认。验证后不要提交 `node_modules/`、`dist/` 或 `.tgz`。

## Kimi 月度配额冻结（billing cycle freeze）

- Kimi 有三层配额：5h 滚动窗口、周配额（`/v1/usages` 顶层 `usage`，从订阅日起每 7 天刷新）、月度 billing-cycle 总额。月度总额用尽时所有 chat 请求返回 403 `access_terminated_error`，但 `/v1/usages` 的 5h/周窗口照常显示有余量——这两个数字是准确的，不要"修正"它们。
- 月度总额的进度数字不存在于任何 API key 可访问的端点：`totalQuota` 对购买型账号（`subType: TYPE_PURCHASE`）是空对象，社区实测（quotas crate）即使非空也只是二进制冻结标志（used=1、remaining 粘滞、limit 无意义）；官方 kimi-cli 的 `/usage` 也不解析它；准确数字只在登录态网页 console（kimi.com/code/console）。
- `collectKimiUsage` 用零成本探测检测冻结：POST chat/completions 带不存在的 model 名 + `max_tokens:1`。限额门在 model 校验之前执行，冻结时返回 403 `access_terminated_error`（0 token、0 配额消耗），健康时返回 404 model not found（不产生 usage）。只有 403 且 `error.type === "access_terminated_error"` 才判定冻结。
- 冻结时在 `ProviderUsage.blocked` 标记 reason；`usage.windows` 的 5h/7d 数值必须保持原样，展示层只把该 provider 的 bars 渲染成灰色（MUTED_COLOR）并显示 Blocked/Frozen。探测请求失败（网络/超时）绝不能影响 usage 采集，静默保持未冻结状态。
- 该机制为 Kimi 独有，不要给其他 provider 引入 blocked 探测或渲染分支。

## 发布门禁

任何 `npm publish` 之前必须依次通过：

1. `npm test` 全绿。
2. `npm pack` 后安装到隔离 prefix，验证 `coding-usage-bar --help`、`doctor --dry-run`、`status --fixtures` 和 `menubar render`。
3. 在用户明确确认后执行真实安装，验证 runtime、CLI shim、SwiftBar 插件和 launchd 周期任务。
4. `npm publish` 后从 registry 重新安装同一版本并重复最小真实用例。
5. 提交版本变更、推送并创建同版本 GitHub Release。
