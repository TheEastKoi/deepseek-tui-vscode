# DeepSeek TUI → VS Code 插件移植方案

## 一、可行性评估

### 难度评级：★★★★☆（高难度）

| 维度 | 评级 | 说明 |
|------|------|------|
| **代码移植量** | ★★★★★ | Rust → TypeScript 全量重写，无代码复用可能 |
| **架构适配** | ★★★★☆ | TUI 即时模式 → VS Code WebView + 协议通信 |
| **API 对接** | ★★☆☆☆ | DeepSeek API 直接可用，OpenAI 兼容 |
| **工具系统** | ★★★☆☆ | Shell/文件/搜索工具需适配 VS Code 环境 |
| **UI 复杂度** | ★★★★☆ | TUI 组件 → React/WebView 组件需全部重写 |

### 核心结论

**不可以简单移植，必须完全重写**。但架构可以借鉴，工具系统可以适配。

原因：DeepSeek TUI 是 Rust 二进制，VS Code 插件是 TypeScript + Node.js 运行时，两者的运行时环境完全不同。

---

## 二、可行方案架构

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Extension                      │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐   │
│  │ WebView UI   │  │ Extension    │  │ Language       │   │
│  │ (React/Ink)  │◄─┤ Host Process ├─►│ Server (LSP)   │   │
│  └─────────────┘  └──────┬───────┘  └───────────────┘   │
│                          │                               │
│                    ┌─────┴──────┐                        │
│                    │  工具引擎   │                        │
│                    │ (TypeScript)│                        │
│                    └─────┬──────┘                        │
└──────────────────────────┼──────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       ┌──────────┐ ┌──────────┐ ┌──────────┐
       │ Shell    │ │ VS Code  │ │ DeepSeek │
       │ (pty)    │ │ API 文件  │ │ API      │
       └──────────┘ └──────────┘ └──────────┘
```

### 推荐方案：TypeScript 全量重写

| 组件 | 技术选型 | 说明 |
|------|---------|------|
| **插件骨架** | VS Code Extension API | `vscode.ExtensionContext` + 命令注册 |
| **UI 渲染** | React + VS Code WebView | 用 WebView 实现类 TUI 界面 |
| **状态管理** | Zustand / Valtio | 轻量级状态管理 |
| **LLM API** | OpenAI SDK (Node.js) | DeepSeek API 完全兼容 |
| **Shell 执行** | `node-pty` | VS Code 内置终端或独立 pty |
| **文件操作** | VS Code `workspace.fs` | 利用 VS Code 文件 API |
| **搜索** | ripgrep-js / vscode API | 代码搜索 |
| **MCP 协议** | `@modelcontextprotocol/sdk` | 原生支持 |

---

## 三、需要解决的问题和难点

### 难点 1：TUI → WebView 界面重写

**问题**：DeepSeek TUI 使用 ratatui（Rust 即时模式终端框架），在终端中绘制字符界面。VS Code 插件使用 WebView（HTML/CSS/JS）。

| TUI 组件 | WebView 替代方案 | 难度 |
|---------|-----------------|------|
| Markdown 渲染 | `react-markdown` + 语法高亮 | 低 |
| Diff 视图 | VS Code 内置 DiffEditor | 低 |
| 文件树 | `@vscode/webview-ui-toolkit` Tree | 中 |
| 命令面板 | VS Code QuickPick API | 低 |
| 流式输出渲染 | WebView 实时更新 + 虚拟滚动 | 中 |
| 权限对话框 | VS Code 原生对话框 / WebView Modal | 中 |
| 会话侧边栏 | VS Code TreeView + WebView Panel | 高 |

**核心矛盾**：TUI 的所有组件是文本终端输出的字符图形，WebView 需要改为 HTML 元素。没有一行 TUI 渲染代码能复用。

**解决方案**：
- 使用 VS Code 的 `WebviewPanel` 作为主对话界面
- 侧边栏使用 `TreeView` 实现（会话列表、文件树）
- 编辑器使用 VS Code 内置编辑器（文件查看、Diff）
- 输入框使用 WebView 内的富文本或 CodeMirror

### 难点 2：Node-pty Shell 执行

**问题**：DeepSeek TUI 使用 Rust 的 `std::process::Command` + crossterm 管理 shell 进程。VS Code 插件运行在 Node.js 沙箱中。

| 方案 | 优点 | 缺点 |
|------|------|------|
| `node-pty` | 跨平台，支持伪终端 | 需要原生编译，安装复杂 |
| VS Code 内置 Terminal API | 无需额外依赖 | 无法直接捕获输出流，交互受限 |
| Node `child_process` | 简单直接 | 没有 pty，部分命令行为异常 |

**推荐方案**：`node-pty` + 终端复用器模式。

```typescript
// 核心伪终端管理器
class PtyManager {
    private terminals: Map<string, IPty> = new Map();
    
    spawn(shellPath: string, cwd: string): string {
        const pty = spawn(shellPath, [], {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd,
            env: process.env as Record<string, string>,
        });
        
        const id = uuid();
        this.terminals.set(id, pty);
        
        pty.onData((data: string) => {
            this.emitOutput(id, data);
        });
        
        return id;
    }
    
    async execCommand(id: string, cmd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const pty = this.terminals.get(id);
            let output = '';
            const handler = (data: string) => { output += data; };
            pty.onData(handler);
            pty.write(cmd + '\n');
            setTimeout(() => {
                pty.offData(handler);
                resolve(output);
            }, TIMEOUT);
        });
    }
}
```

**风险**：
- Windows 上 `node-pty` 依赖 MSVC 编译环境
- `electron-rebuild` 可能失败
- 权限管理（禁止危险命令）需要重写

### 难点 3：工具系统适配

**问题**：DeepSeek TUI 的 20+ 个工具需要重写为 VS Code API 调用。

| 工具 | 原实现（Rust） | 新实现（TypeScript + VS Code） | 难度 |
|------|-------------|-------------------------------|------|
| `file_read` | `std::fs::read_to_string` | `vscode.workspace.fs.readFile` | 低 |
| `file_write` | `std::fs::write` | `vscode.workspace.fs.writeFile` | 低 |
| `apply_patch` | 自定义 patch 引擎 | VS Code ApplyEdit + Snippet | 中 |
| `exec_shell` | `std::process::Command` | `node-pty` + cwd 管理 | 高 |
| `grep_files` | `ripgrep` crate | `@vscode/ripgrep` 或 vscode API | 低 |
| `file_search` | `walkdir` crate | `glob` npm 包 | 低 |
| `git_diff` | `git2` crate | VS Code Git API / `simple-git` | 中 |
| `diff_render` | 自定义 diff 渲染 | VS Code DiffEditor API | 低 |
| `mcp_tools` | Rust MCP 客户端 | `@modelcontextprotocol/sdk` | 中 |
| `sub_agent` | Rust async 任务 | TypeScript Worker/子进程 | 高 |

### 难点 4：会话持久化

**问题**：DeepSeek TUI 使用 SQLite（`crates/state`）存储会话数据。

**解决方案**：
```typescript
// VS Code 插件可以使用多种存储
class SessionStore {
    private db: Database;
    
    constructor(context: vscode.ExtensionContext) {
        // 方案 A: VS Code 内置 Memento（轻量，适合少量数据）
        this.globalState = context.globalState;
        this.workspaceState = context.workspaceState;
        
        // 方案 B: SQLite via better-sqlite3（适合大量数据）
        const dbPath = path.join(context.globalStorageUri.fsPath, 'sessions.db');
        this.db = new Database(dbPath);
    }
}
```

**选择**：如果对话历史较大，推荐 SQLite（`better-sqlite3` + `electron-rebuild`）。
如果对话量少，使用 `context.globalState` 即可。

### 难点 5：权限 / 安全模型

**问题**：DeepSeek TUI 的 ExecPolicyEngine（分层规则 + Bash 元数感知）需要完整重写。

```typescript
class PermissionEngine {
    private rules: PermissionRule[] = [];
    
    async check(shellCmd: string, tool: string): Promise<PermissionDecision> {
        // 1. 拒绝规则（始终优先）
        for (const rule of this.denyRules) {
            if (rule.matches(shellCmd)) return PermissionDecision.DENY;
        }
        
        // 2. 信任规则（自动通过）
        for (const rule of this.trustRules) {
            if (rule.matches(shellCmd)) return PermissionDecision.ALLOW;
        }
        
        // 3. 需审批
        return PermissionDecision.ASK;
    }
}
```

**直接复用**：可以把 DeepSeek TUI 的 `execpolicy` crate 逻辑翻译为 TypeScript，规则模型完全一致。

### 难点 6：Agent 循环重写

**问题**：DeepSeek TUI 的 `turn_loop.rs`（~2000 行状态机）需要重写。

**推荐结构**：
```typescript
class AgentLoop {
    private session: SessionManager;
    private tools: ToolRegistry;
    private llm: LLMClient;
    
    async run(prompt: string, mode: 'plan' | 'agent' | 'yolo') {
        const messages = await this.buildPromptWithContext(prompt);
        
        while (this.shouldContinue()) {
            const response = await this.llm.chat(messages, { tools: this.tools.definitions() });
            
            for (const block of response.blocks) {
                if (block.type === 'tool_use') {
                    const result = await this.tools.execute(block.name, block.input);
                    messages.push({ role: 'tool', content: result });
                } else if (block.type === 'text') {
                    this.emitOutput(block.text);
                }
            }
            
            if (this.exceedsBudget()) {
                await this.compress();
            }
        }
    }
}
```

---

## 四、工期安排

### 总体工期预估：12-16 周（3-4 个月）

```
Phase 0: 准备期  (1 周)
├── 搭建 VS Code 插件脚手架
├── 配置 TypeScript + ESLint + Prettier
├── 配置 WebView 构建链（Vite/Webpack）
├── 配置 node-pty + better-sqlite3 原生模块
└── CI/CD 配置（vsce 打包 + 发布）

Phase 1: 核心引擎  (3 周)
├── LLM Client（DeepSeek API 对接）
│   ├── OpenAI 兼容 SDK 封装
│   ├── 流式响应处理
│   └── 重试 + 错误处理
├── Agent 循环引擎
│   ├── turn_loop 状态机
│   ├── tool_use 检测/执行
│   └── 轮次管理
└── 会话持久化
    ├── SQLite 数据库
    ├── CRUD API
    └── 恢复/分叉

Phase 2: 工具系统  (3 周)
├── 文件工具（read/write/edit）
├── Shell 工具（node-pty 集成）
├── 搜索工具（grep + glob）
├── Git 工具
├── Web 工具（fetch + search）
├── 子代理工具
├── MCP 集成
└── 权限/审批引擎

Phase 3: UI 开发  (3 周)
├── WebView 主界面
│   ├── 对话列表（虚拟滚动）
│   ├── Markdown 渲染
│   ├── Thinking 块渲染
│   ├── 流式输出
│   └── 输入框（CodeMirror）
├── VS Code 侧边栏
│   ├── 会话列表
│   ├── 文件树
│   └── 任务队列
├── 命令面板集成
├── 快捷键绑定
└── 主题适配

Phase 4: 集成与测试  (2 周)
├── TUI 快捷键映射为 VS Code 命令
├── 内置终端集成（可选）
├── LSP 诊断集成
├── 单元测试（核心引擎）
├── 集成测试（工具执行）
└── 手动测试 + bug 修复

Phase 5: 发布准备  (1 周)
├── README + 文档
├── Marketplace 发布
├── 许可证
└── MVP 版本（v0.1.0）
```

---

## 五、技术方案对比

### 方案 A：纯 TypeScript 重写（推荐）

```
优点:
  ├── 完全控制，无历史包袱
  ├── VS Code API 原生集成
  ├── 发布 MarketPlace 方便
  └── 社区贡献门槛低（TS 比 Rust 受众广）

缺点:
  ├── 全部代码需重写（~3-4 个月）
  └── 边缘 case 需要大量测试
```

### 方案 B：Rust → WebAssembly

```
优点:
  ├── 复用核心引擎编译为 WASM
  └── 性能接近原生

缺点:
  ├── VS Code API 仍需 TS 包装
  ├── WASM 调试困难
  ├── node-pty 无法 WASM
  └── 生态不成熟
```

### 方案 C：Rust 守护进程 + VS Code 前端

```
优点:
  ├── 复用全部 Rust 代码
  ├── 核心逻辑不变
  └── 工具系统不改

缺点:
  ├── 需要维护两个进程
  ├── IPC 通信复杂
  ├── 用户安装需编译 Rust（噩梦）
  ├── 跨平台分发困难
  └── 不推荐
```

---

## 六、各阶段输出物

| 阶段 | 可运行版本 | 功能 |
|------|-----------|------|
| Phase 0+1 | v0.1.0-alpha | CLI 模式 + DeepSeek API 对话 |
| Phase 2 | v0.2.0-alpha | CLI 模式 + 工具执行 + Shell |
| Phase 3 | v0.3.0-beta | WebView UI + 侧边栏 |
| Phase 4 | v0.4.0-rc | 快捷键 + LSP + 测试 |
| Phase 5 | v0.1.0 | Marketplace 发布版 |

---

## 七、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| node-pty 编译失败 | 中 | 高 | 预编译 binary，使用 `@vscode/node-pty` |
| WebView 性能问题（长对话） | 高 | 中 | 虚拟列表，CheerpJ 流式渲染 |
| VS Code API 更新破坏兼容 | 低 | 低 | 小版本锁定，自动化测试 |
| DeepSeek API 变更 | 低 | 高 | API 抽象层，多重 provider |
| 插件审核被拒 | 中 | 高 | 确保符合 Marketplace 政策 |
| 与 TUI 版本功能对不齐 | 中 | 中 | 先锁定 TUI v0.8.33 的功能集 |

---

## 八、团队建议

| 角色 | 人数 | 技能要求 |
|------|------|---------|
| TypeScript 全栈 | 1-2 人 | VS Code Extension、React |
| Rust 开发者（顾问） | 0-1 人 | 理解原 TUI 架构 |
| QA | 1 人 | 终端工具测试经验 |
| 工期 | 3-4 月（1-2 人） | |

如果有 1 个熟练的 VS Code 插件开发者全职投入，**约 3 个月** 可发布 MVP 版本。
如果有 2 人合作（前端 + 后端），**约 2 个月** 可完成。

---

## 九、可借鉴项目：Continue（continuedev/continue）

**Continue**（https://github.com/continuedev/continue）是一个开源的 AI 编码助手 VS Code 插件，**33.2k stars**，**Apache 2.0 许可**，TypeScript 编写。它的架构与你要做的 DeepSeek VS Code 插件高度重合，**约 60-70% 的代码可以直接借鉴**。

### Continue 的架构

```
continue-repo/
├── core/               ← 核心引擎（通用，不依赖 VS Code）
│   ├── tools/          ← 工具定义 + 实现
│   ├── llm/            ← LLM 客户端（多 provider）
│   ├── config/         ← 配置系统
│   ├── context/        ← 上下文收集
│   ├── diff/           ← Diff 引擎
│   └── edit/           ← 代码编辑
├── extensions/         ← 平台适配层
│   ├── vscode/         ← VS Code 插件（薄壳）
│   └── intellij/       ← JetBrains 插件
├── gui/                ← React WebView 界面
│   └── src/
│       ├── components/  ← UI 组件
│       ├── hooks/       ← React Hooks
│       └── redux/       ← 状态管理
```

### 可直接借鉴的部分

#### 1. `core/tools/` — 工具系统（复用率 100%）

Continue 的工具系统设计非常成熟：

```
core/tools/
├── definitions/        ← 工具定义（名称 + schema + description）
│   ├── readFile.ts
│   ├── runTerminalCommand.ts
│   ├── globSearch.ts
│   ├── fetchUrlContent.ts
│   └── ...
├── implementations/    ← 工具实现
│   ├── readFile.ts
│   ├── runTerminalCommand.ts
│   ├── globSearch.ts
│   ├── fetchUrlContent.ts
│   └── ...
├── builtIn.ts          ← 内置工具注册
├── callTool.ts         ← 工具调用分发
└── index.ts            ← 入口
```

**借鉴方式**：
- 工具定义的 `Tool` 类型定义直接复用
- 工具注册模式（`getBaseToolDefinitions()` + `getConfigDependentToolDefinitions()`）直接模仿
- 但需要将 `BashTool` / `ShellTool` 替换为更细粒度的 DeepSeek TUI 工具模式

#### 2. `core/llm/` — LLM 客户端层（复用率 80%）

Continue 已经支持 DeepSeek 作为 provider 之一，LLM 客户端可以继承/修改：

- 流式响应处理
- 重试逻辑
- Token 计数
- 多 provider 路由

**需要修改**：适配 DeepSeek V4 的 Thinking 模式（扩展思考块）、V4 特有的 API 参数。

#### 3. `gui/src/components/` — WebView 界面（复用率 50%）

Continue 的 React 组件库包括了：

| 组件 | 能否复用 | 修改需求 |
|------|---------|---------|
| `ChatBox`（对话列表） | ✅ 可复用 | 基础上修改 |
| `InputBox`（输入框） | ✅ 可复用 | 基础上修改 |
| `MarkdownRenderer` | ✅ 可复用 | 需支持 DeepSeek Thinking 块 |
| `StepContainer`（工具调用展示） | ✅ 可复用 | 需适配多工具并行 |
| `HistorySidebar`（历史列表） | ✅ 可复用 | 微调 |
| `FileTree` | ✅ 可复用 | 微调 |

**需要自研的组件**：
- DeepSeek V4 的流式 Thinking 块渲染
- 审批/权限对话框（DeepSeek 三层审批）
- Plan → Agent → YOLO 模式切换器
- 子代理状态监控面板

#### 4. `extensions/vscode/` — VS Code 集成层（复用率 70%）

| 文件 | 借鉴方式 |
|------|---------|
| `extension.ts` | 入口模板，直接复用 |
| `activation/activate.ts` | 激活流程，参考修改 |
| `VsCodeIde.ts` | VS Code IDE 接口实现，核心复用 |
| `commands.ts` | 命令注册，直接复用模式 |
| `webviewProtocol.ts` | WebView 通信协议，可根据需要调整 |
| `diff/` | Diff 编辑器集成，直接复用 |
| `terminal/` | 终端集成，参考修改 |

### VS Code 插件架构对比

```
Continue 的做法：                    DeepSeek 插件的做法（借鉴）：
┌──────────────────┐                ┌──────────────────┐
│ VS Code Extension│                │ VS Code Extension│
│  (薄壳 500 行)    │                │  (薄壳 500 行)    │
├──────────────────┤                ├──────────────────┤
│ Core (TypeScript) │                │ Core (TypeScript) │
│  - 工具系统        │  ──借鉴──→     │  - 工具系统        │
│  - LLM 客户端      │                │  - DeepSeek V4    │
│  - 配置管理        │                │  - 三层审批引擎    │
│  - Diff/Edit       │                │  - 容量控制器      │
├──────────────────┤                ├──────────────────┤
│ React GUI (WebView)│                │ React GUI (WebView)│
│  - 对话界面        │  ──借鉴──→     │  - 对话界面        │
│  - 输入框          │                │  - Thinking 块     │
│  - 历史列表        │                │  - 审批对话框      │
└──────────────────┘                └──────────────────┘
```

### 工期修正（利用 Continue 代码库）

| 阶段 | 原预估 | 利用 Continue 后 |
|------|--------|-----------------|
| Phase 1: 核心引擎 | 3 周 | **1-2 周** (复用 LLM 层 + 工具框架) |
| Phase 2: 工具系统 | 3 周 | **2 周** (复用实现 + 修改定义) |
| Phase 3: UI 开发 | 3 周 | **2 周** (复用组件 + 新增 Thinking 渲染) |
| Phase 4: 集成测试 | 2 周 | **1-2 周** |
| Phase 5: 发布 | 1 周 | **1 周** |
| **总计** | **12 周** | **7-9 周** |

### 如何开始

```bash
# 1. Fork Continue 仓库
# 到 https://github.com/continuedev/continue 点 Fork

# 2. Clone 到本地
cd /e/git_code
git clone https://github.com/TheEastKoi/continue.git

# 3. 修改 package.json 和 extension 名称
# core/package.json → name: "deepseek-tui-core"
# extensions/vscode/package.json → name: "deepseek-tui-vscode"

# 4. 核心修改点：
#    - 不动的: gui/src/components/ (大部分 UI 组件)
#    - 不动的: core/tools/ (工具系统框架)
#    - 不动的: core/llm/ (LLM 客户端，加 DeepSeek V4 支持)
#    - 要改的: 工具定义改为细粒度的 DeepSeek TUI 风格
#    - 要改的: 审批引擎改为 ExecPolicyEngine 三层模式
#    - 要改的: GUI 加 Thinking 块渲染 + 权限对话框
#    - 要改的: 加子代理角色系统
```

### 推荐策略：基于 Continue Fork，增量修改

```
Week 1-2:  Fork + 上手中
  ├── Fork continuedev/continue
  ├── 理解核心架构（core/, gui/, extensions/vscode/）
  ├── 将 LLM provider 切换到 DeepSeek V4
  └── 跑通基础对话

Week 3-4:  工具系统改造
  ├── 将 Continue 的工具定义改为 DeepSeek TUI 的细粒度风格
  ├── 实现三层审批引擎（Plan/Agent/YOLO）
  └── 实现容量控制器（可选）

Week 5-6:  GUI 改造
  ├── DeepSeek V4 Thinking 块渲染
  ├── 审批对话框
  ├── 模式切换器（Plan/Agent/YOLO）
  └── 子代理监控面板

Week 7-8:  测试 + 调优 + 发布
  ├── 集成测试
  ├── token 优化
  ├── README + 文档
  └── VS Code Marketplace 发布 v0.1.0
```

### 总结：Continue 是完美的起点

**为什么 Continue 是最佳借鉴对象：**

1. **同样的定位** — AI 编码助手 VS Code 插件，功能完全对标
2. **同样的技术栈** — TypeScript + React + VS Code API
3. **成熟的三层架构** — `core/`（跨平台） + `extensions/vscode/`（适配） + `gui/`（界面）
4. **Apache 2.0 许可** — 可自由修改和商用
5. **33k stars** — 社区验证过的成熟设计
6. **支持多 LLM provider** — 加入 DeepSeek V4 支持即可

**不同点**（需要修改的部分）：
- Continue 的 `BashTool` 是单一强大工具 → DeepSeek 的细粒度多工具
- Continue 的审批简单 → DeepSeek 的三层 ExecPolicyEngine
- Continue 无需 Thinking 渲染 → DeepSeek V4 需要 Thinking 块
- Continue 无容量预测 → DeepSeek 有 Capacity Controller
