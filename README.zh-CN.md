# Coding Usage Bar

[English](README.md) · [简体中文](README.zh-CN.md)

**在 macOS 菜单栏监控 Claude Code、Codex 和其他 AI 编程套餐用量。**

![Coding Usage Bar 在 macOS 菜单栏展示多个 AI 编程 Provider 的套餐用量](docs/assets/hero.png)

Coding Usage Bar 同时支持 Claude Code、OpenAI Codex、GLM（智谱 AI）、DeepSeek 和 MiniMax。它不只展示百分比，还会结合短周期和周额度判断当前节奏是偏慢、正常、偏快，还是已经接近限额。

Claude Code 与 Codex 的数据直接读取它们在本机产生的文件，不需要额外登录，也不会上传使用记录。GLM、DeepSeek 和 MiniMax 的 API Key 只保存在 `~/.coding-usage-bar/config.json`，并直接请求对应 Provider 的额度接口。

## 快速开始

```bash
npx coding-usage-bar install
coding-usage-bar doctor
coding-usage-bar status
```

安装器会创建：

- `~/.coding-usage-bar/app` 稳定运行副本
- `~/.local/bin/coding-usage-bar` 命令入口
- 每 5 分钟采集一次用量的 launchd 任务
- 写入 SwiftBar 当前插件目录的菜单栏插件

## 核心特点

- 一个菜单栏同时查看多个 AI 编程 Provider
- 按账户实际下发的滚动窗口分析使用节奏；部分 Codex 账户当前只提供 7d
- Claude Code、Codex 本地优先，不依赖额外遥测服务
- 展示层只读稳定的 `status.json`，不会在打开菜单时临时访问数据源
- 接近限额或燃烧节奏异常时发送系统通知

完整命令、Provider 配置和实现边界请查看[英文 README](README.md)。

交互式安装结束后，工具可能询问是否为 GitHub 仓库加 Star。该提示默认选择 No（`[y/N]`），只有用户明确输入 `y`/`yes` 且本机 GitHub CLI 已登录时才会修改远端账户状态。

## 开发验证

```bash
npm ci
npm test
npm run build
npm pack
```

## License

[MIT](LICENSE)

各 Provider 名称与商标归其权利人所有。本项目独立开发，与 Anthropic、OpenAI、智谱 AI、DeepSeek、MiniMax 无隶属或背书关系。Provider 标识仅用于识别，不适用项目 MIT License，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
