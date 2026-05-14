# DeepSeek TUI Agent 设计分析 —— 与 Claude Code 对比

## 一、整体架构对比

| 维度 | DeepSeek TUI (Rust) | Claude Code (TypeScript) |
|------|-------------------|-------------------------|
| **范式** | 即时模式（每帧重绘） | 声明式（React + Ink 虚拟 DOM） |
| **Agent 循环** | 显式 turn_loop 状态机 | AsyncGenerator queryLoop |
| **工具模型** | Trait + ToolRegistry | 模块化类 + 按名分发 |
| **状态管理** | App 状态机 + mpsc channel | React Context + 自定义 Store |
| **权限系统** | ExecPolicyEngine 分层规则 | canUseTool + PermissionMode |
| **子代理** | 持久化 agent_open/eval/close | AgentTool + AgentSwarms |
| **上下文管理** | 容量控制器 + 周期管理器 | 多层压缩（snip → microcompact → collapse → autocompact） |

## 二、DeepSeek TUI 的设计亮点

### 亮点 1：工具表面的精细化设计（Tool Surface）

**"专用工具优先于 exec_shell"** 是核心设计哲学。DeepSeek TUI 拆分了 20+ 细粒度工具（FileRead、FileWrite、ApplyPatch、Grep、Glob、Search、Shell 等），每个工具声明自己的 `ToolCapability`：

```rust
enum ToolCapability {
    ReadOnly,       // 自动审批
    WritesFiles,    // 建议审批
    ExecutesCode,   // 必需审批
    Network,        // 高权限
    Destructive,    // 需要明确批准
}
```

**优势**：细粒度使模型更可控。Claude Code 的 BashTool 是"万能工具"，Shell 脚本里的权限、路径、环境问题全抛给了模型。DeepSeek TUI 通过拆解让模型精确选择，每个工具的安全边界清晰。

### 亮点 2：三层分层执行策略（ExecPolicyEngine）

```
RulesetLayer::BuiltinDefault = 0   // 硬编码安全基线
RulesetLayer::Agent = 1             // 模型请求的策略变更
RulesetLayer::User = 2              // 用户在 config.toml 配置
```

**创新点**：
- **拒绝始终优先**：匹配拒绝前缀的命令直接阻止
- **Bash 元数感知**：`git status` 匹配 `git status -s`，但不匹配 `git push`
- **会话级审批缓存**：`ApprovedForSession` 避免重复审批

Claude Code 的权限模式更简单（default/plan/auto/bypass），DeepSeek 的层次化设计更适合企业安全审计场景。

### 亮点 3：容量控制器（Capacity Controller）

一个可选的**主动式上下文 Guardrail**，使用启发式公式估算运行失败风险：

```
H_hat = 0.35*a_complexity + 0.30*t_complexity + 0.20*ref_complexity + 0.15*ctx_pressure
C_hat = 模型常量（pro=3.5, flash=4.2）
slack = C_hat - H_hat
p_fail = sigmoid(-1.65*slack -0.85*min_slack +1.35*violation_ratio +0.70*volatility +0.28*drop -0.12)
```

干预等级：`low(<0.5) → 无干预 | medium(<0.62) → TargetContextRefresh | high → VerifyWithToolReplay`

Claude Code 没有类似的显式容量预测模型。

### 亮点 4：子代理角色系统

DeepSeek TUI 定义了 8 种子代理角色，每种有预设的工具白名单：

| 角色 | 写 | Shell | 用途 |
|------|----|-------|------|
| `general` | ✅ | ✅ | 默认任务 |
| `explore` | ❌ | 只读 | 代码探索 |
| `plan` | 最小 | 最小 | 策略输出 |
| `review` | ❌ | ❌ | 审计 |
| `implementer` | ✅ | ✅ | 执行变更 |
| `verifier` | ❌ | ✅(测试) | 验证 |
| `custom` | 按需 | 按需 | 自定义 |

Claude Code 的 AgentTool 没有类似的内置角色分类。

### 亮点 5：预缓存友好的工具注册表

```rust
fn to_api_tools(&self) -> Vec<Tool> {
    // 1. 排序工具名（确定性迭代）
    // 2. 记忆化序列化目录
    // 3. 启动后不变
}
```

确保每次启动时序列化结果字节相同，保护 DeepSeek 的 KV 前缀缓存。这是一个很细致的优化。

### 亮点 6：var_handle 大输出路由

工具的大体积输出（>阈值）自动写入支持存储，模型只看到符号句柄，通过 `handle_read` 按需检索。这避免了把几 MB 的输出塞进对话历史。

Claude Code 使用 `maxResultSizeChars` + 磁盘持久化来实现类似效果。

## 三、Claude Code 值得借鉴的设计

| 设计 | 说明 |
|------|------|
| **React/Ink UI** | 声明式组件树使 UI 复杂度可控，DeepSeek 的即时模式在 UI 约束上更困难 |
| **多层压缩流水线** | snip → microcompact → collapse → autocompact，渐进式上下文缩减 |
| **条件编译** | `bun:bundle` feature() 构建时死代码消除 |
| **状态按需订阅** | `useSyncExternalStore` + 选择器，组件仅订阅所需切片 |
| **依赖注入 QueryDeps** | 核心循环的所有外部依赖可注入，便于测试 |

## 四、结论

DeepSeek TUI 的 Agent 设计在与 Claude Code 的比较中，**工具表面精细化、分层执行策略、容量预测 Guardrail、子代理角色系统**是其最突出的差异化亮点。Claude Code 的**多级压缩流水线**和**React 声明式 UI** 则值得 DeepSeek TUI 借鉴。

DeepSeek TUI 更适合以下场景：
- 需要**细粒度权限控制**的企业环境
- 对**token 成本敏感**需要预测性容量管理
- 需要**子代理角色分工**的复杂任务编排

Claude Code 的优势在于：
- **UI 交互丰富度**（React 声明式）
- **消息压缩机制成熟度**（多级、渐进式）
- **生态系统**（插件、技能、IDE 集成）
