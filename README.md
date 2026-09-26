# Omarchy Menu Omni (全能桌面启动器 & AI 网页桥接)

[English Documentation](README_en.md) | 简体中文文档

基于 [basecamp/omarchy](https://github.com/basecamp/omarchy)、[dzhibas/omarchy.dzhibas.menu](https://github.com/dzhibas/omarchy.dzhibas.menu) 与 [jesseburlamaque/omarchy-find](https://github.com/jesseburlamaque/omarchy-find) 构建。遵循 MIT 开源协议。

**Omarchy Menu Omni** 是专为 Linux / Omarchy 桌面环境打造的全能键盘驱动启动器。集应用启动、系统快捷操作、全盘文件/目录瞬时检索、即时计算器、以及 **零 API 费用的 Chrome 网页端 AI 对话/翻译桥接** 于一体。

![Omni application grid](preview.png)

---

## ✨ 核心特性

### 1. 全键盘流式操控
- `Super + Space`：一键唤醒搜索面板。
- 标签平滑切换：支持 `Tab` / `Shift+Tab` 循环切换，或使用 `Ctrl + 1~5` 直达指定栏目（保持当前输入不丢失）。
- 键盘导航：上下键选择结果，`Enter` 启动/打开，`Esc` 清空输入或退出。

| 栏目 (Tab) | 功能说明 |
| --- | --- |
| **全部 (All)** | 聚合视图：优先显示即时计算/回答，其次展示应用、系统操作、文件与目录匹配（各展示前 5 项） |
| **应用 (Apps)** | 已安装应用程序；支持 `Ctrl + G` 在优雅网格与紧凑列表之间无缝切换并记忆偏好 |
| **系统 (System)** | Omarchy 系统控制双栏视图：左侧类别列表，右侧操作项目；支持模糊搜索（如 `update omarchy`） |
| **文件 (Files)** | 用户主目录下文件名即时搜索；提供文件类型、排序规则及显示上限过滤 |
| **目录 (Folders)** | 文件夹快速定位与跳转；支持独立的一键过滤系统配置目录模式 |

---

### 2. 独家 AI 模式：Chrome 网页端零 Token 费用桥接
普通启动器调用大模型通常需要昂贵且繁琐的 API Key。**Omni 提供首创的 Chrome 网页端本地原生桥接**：
- **免 API 费用**：直接复用您在 Chrome 中已登录的网页会话，提问完全不消耗 API Token。
- **双引擎支持**：支持 **DeepSeek Web** (`chat.deepseek.com`) 与 **ChatGPT Web** (`chatgpt.com`)。
- **无缝流式输出**：采用打字机式平滑加速度渲染算法，拒绝突然爆屏卡顿；完美解析 Markdown 语法与代码块（带语法高亮与代码复制）。
- **多模型自由切换**：在 AI 模式下直接使用 `Tab` 或 `Ctrl + 数字` 在不同 AI 引擎之间无感切换。
- **兼容本地 CLI Agent**：除网页端桥接外，原生兼容 Claude、Codex、Agy、OpenCode、Pi 等命令行 Agent。

---

### 3. 本地文件一键引用与翻译（`@<文件路径>`）
专为阅读、代码审查与翻译场景设计的本地文件注入语法：
```text
ai 帮我翻译 @/download/english.txt
ai 请把 @~/Downloads/document.txt 翻译为中文
ai 帮我总结 @notes.md 中的核心要点
ai 解释这段代码 @main.py
```
- **智能路径解析**：
  - 自动识别用户意图：输入 `@/download/xxx` 或 `@download/xxx` 时，自动映射至用户实际的 `~/Downloads/xxx` 目录。
  - 纯文件名多级回退搜索：只写 `@filename.txt` 时，自动在 `Downloads`、`Desktop`、`Documents` 及用户主目录下搜索匹配。
  - 支持带空格路径：支持引号包裹，如 `@"~/Downloads/my document.txt"`。
- **中文与编码自适应**：
  - 自动适配 UTF-8、GB18030、GBK、Latin-1 等编码，老旧中文文件绝不乱码。
  - 动态 Markdown 围栏注入，大模型可完美区分指令与参考文档。
  - 安全容量保护：上限 500 KB，超出或文件不存在时立即在面板给出清晰中文提示，不盲目请求。
  - 防误触机制：普通邮箱（如 `user@example.com`）与日常社交 `@` 提及完全不受影响。

---

## 🚀 安装指南

### 第一步：安装启动器插件

在终端中执行 Omarchy 插件添加命令：
```bash
omarchy plugin add https://github.com/cuiyang/omarchy-menu-omni.git --enable --yes
```
*(注：如果需要手动安装，直接克隆本仓库至 `~/.config/omarchy/plugins/omarchy-menu-omni` 即可)*

### 第二步：安装 Chrome AI 网页桥接组件

若要使用 DeepSeek 或 ChatGPT 网页端零费用提问功能，请运行随附的安装脚本：
```bash
cd ~/.config/omarchy/plugins/omarchy-menu-omni
bash bridge/install.sh
```
> **安装脚本自动完成以下配置：**
> 1. 安装 `dsweb`、`omarchy-dsweb-host` 等命令行工具至 `~/.local/bin/`。
> 2. 配置 Chrome Native Messaging 原生消息宿主。
> 3. 安装 Systemd 用户 Socket 激活服务（按需运行，日常待机 **0 内存、0 CPU 占用**）。
> 4. 配置 Chrome 企业策略以自动安全加载扩展。

安装完成后：
1. 重启 Chrome 浏览器。
2. 在 Chrome 中打开并登录 [DeepSeek](https://chat.deepseek.com/) 或 [ChatGPT](https://chatgpt.com/) 保持该标签页存在即可。

---

## ⌨️ 常用快捷键速查

### 全局与搜索
- `Super + Space`：打开 / 隐藏启动器。
- `Super + Alt + Space`：直接打开应用程序网格视图。
- `Ctrl + G`：切换应用视图（网格 Grid ↔ 列表 List）。
- `Tab` / `Shift + Tab`：在 全部 / 应用 / 系统 / 文件 / 文件夹 之间循环切换。
- `Ctrl + 1 ~ 5`：快速跳至第 1 ~ 5 个栏目。
- `Esc`：清除当前搜索内容；若输入框为空则关闭启动器。

### 文件检索
- `Enter`：使用默认应用打开选中文件；可执行文件或脚本将安全打开其所在文件夹。
- `Alt + Enter`：直接打开选中文件所在文件夹。
- `Ctrl + C`：复制文件绝对路径到剪贴板。
- `Ctrl + T`：在当前选中目录中一键打开终端。
- `Ctrl + F`：切换文件类型过滤（全部、文档、图像、视频、音频、代码）。
- `Ctrl + S`：切换排序方式（相关度、最新、最旧、文件名、文件大小）。

### AI 对话模式
- 启动：输入 `ai <您的问题>` 或在输入 `/` 后选择 `ai`。
- 引用文件：输入 `ai 帮我翻译 @<文件路径>`。
- 切换模型：按 `Tab` 键即可在 DeepSeek Web、ChatGPT Web 及已安装的本地 CLI Agent 之间切换。
- 复制结果：点击卡片或按对应快捷键一键复制 AI 回答全文。

---

## 🛠️ 诊断与维护

如果需要检查 Chrome 桥接通信状态，可在终端运行：
```bash
# 查看桥接服务与 Chrome 连接状态
dsweb status

# 探测当前打开的 ChatGPT 标签页状态
dsweb -s gptweb probe

# 测试 ChatGPT 自动化输入与清空功能（不消耗真实对话）
dsweb -s gptweb selftest

# 命令行单独测试提问
dsweb -s dsweb ask "用一句话解释量子力学"
```

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
欢迎提交 Issue 与 Pull Request 共同改进！
