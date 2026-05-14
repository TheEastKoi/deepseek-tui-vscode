# DeepSeek TUI Token 消耗优化方案

## 当前 Token 消耗分析

DeepSeek TUI 的 Token 消耗主要来自以下方面：

| 消耗源 | 占比估计 | 说明 |
|--------|---------|------|
| **系统提示 + 工具定义** | 30-40% | 每次轮次都会发送完整工具目录（~20+ 工具的描述 + schema） |
| **工具调用结果** | 25-35% | 文件内容、搜索结果等大量文本进入历史 |
| **历史对话累积** | 20-30% | 多轮对话的历史上下文 |
| **思考 (Thinking)** | 5-10% | DeepSeek V4 的扩展思考输出 |

## 优化方案

### 方案 1：工具描述压缩（预期节省 15-25%）

**原理**：工具描述和 input_schema 是重复发送的固定开销。通过裁剪冗余描述、压缩 schema、移除不必要的字段来减少每次轮次的固定 token 开销。

**修改文件**：`crates/tui/src/tools/registry.rs`

**具体修改**：

```rust
// 在 ToolSpec trait 中添加压缩方法
impl ToolRegistry {
    /// 生成压缩版工具目录（用于生产轮次）
    pub fn to_condensed_api_tools(&self) -> Vec<CondensedTool> {
        self.tools.values().map(|tool| {
            let spec = tool.spec();
            CondensedTool {
                name: spec.name().to_string(),
                // 只保留核心描述（截断到 200 字符）
                description: truncate_to(spec.description(), 200),
                // 压缩 input_schema：移除 description 字段中的冗余文本
                input_schema: compress_schema(&spec.input_schema()),
                // 完全移除 output_schema（模型通常不需要）
                output_schema: None,
            }
        }).collect()
    }
}

// 修改 turn_loop.rs 中的消息构建，根据上下文压力选择
fn build_message_request(&self, condensed: bool) -> MessageRequest {
    if condensed {
        request.set_tools(self.tool_registry.to_condensed_api_tools());
    } else {
        request.set_tools(self.tool_registry.to_api_tools());
    }
}
```

**策略**：
- 前 3 轮使用完整工具定义（让模型理解工具）
- 之后切换为压缩版（模型已记住工具用途）
- 或当上下文使用率 >60% 时自动切换

### 方案 2：选择性工具注册（预期节省 10-15%）

**原理**：并非所有工具在每个任务中都需要。根据上下文动态过滤不需要的工具。

**修改文件**：`crates/tui/src/tools/registry.rs` + `crates/tui/src/core/engine/turn_loop.rs`

```rust
// 添加工具热度追踪
struct ToolUsageTracker {
    usage_counts: HashMap<String, u32>,
    last_used: HashMap<String, Instant>,
}

impl ToolUsageTracker {
    /// 返回当前轮次应该暴露的工具列表
    fn get_active_tools(&self) -> Vec<String> {
        let mut active: Vec<String> = self.tools.keys()
            .filter(|name| {
                let count = self.usage_counts.get(*name).copied().unwrap_or(0);
                let last = self.last_used.get(*name).copied().unwrap_or(Instant::now());
                // 最近 3 轮内用过 + 总使用次数 >0
                count > 0 && last.elapsed() < Duration::from_secs(300)
            })
            .cloned()
            .collect();
        
        // 始终保留核心工具（shell, file_read, file_write）
        active.extend(["exec_shell", "file_read", "file_write"]);
        active.sort();
        active.dedup();
        active
    }
}
```

**动态策略**：
- 阶段 1（前 5 轮）：暴露所有工具
- 阶段 2（5 轮后）：仅暴露最近使用过的工具 + 核心工具
- 当模型需要新工具时，通过 tool_search/skill 机制动态加载

### 方案 3：结构化工具结果压缩（预期节省 20-30%）

**原理**：工具返回的大段文本（文件内容、搜索结果）直接进入对话历史。通过摘要化、截断、结构化来压缩。

**修改文件**：`crates/tui/src/core/engine/dispatch.rs`

```rust
fn compress_tool_result(result: &ToolResult, max_len: usize) -> ToolResult {
    match &result {
        ToolResult::FileContent { path, content } if content.len() > max_len => {
            let summary = summarize_content(content, max_len);
            ToolResult::FileContent {
                path: path.clone(),
                content: summary,
                truncated: true,
                original_size: content.len(),
            }
        }
        ToolResult::SearchResults { results } => {
            let compressed = results.iter()
                .take(10)  // 最多返回 10 条
                .map(|r| compress_entry(r))
                .collect();
            ToolResult::SearchResults { results: compressed }
        }
        _ => result.clone(),
    }
}

/// 使用 LLM 生成内容摘要（仅在上下文压力高时触发）
async fn summarize_content(content: &str, max_len: usize) -> String {
    if content.len() <= max_len {
        return content.to_string();
    }
    // 提取标题、关键结构（函数签名、类定义）、前 N 行
    let lines: Vec<&str> = content.lines().collect();
    let mut summary = String::new();
    
    // 保留前 30 行
    for line in lines.iter().take(30) {
        summary.push_str(line);
        summary.push('\n');
    }
    
    if lines.len() > 30 {
        summary.push_str(&format!("... ({} more lines truncated)", lines.len() - 30));
    }
    
    if summary.len() > max_len {
        summary.truncate(max_len);
        summary.push_str("... (truncated)");
    }
    
    summary
}
```

### 方案 4：主动上下文压缩（预期节省 10-15%）

**原理**：DeepSeek TUI 已有周期管理器（cycle_manager），但默认被动触发。改为主动压缩策略。

**修改文件**：`crates/tui/src/core/engine/turn_loop.rs`

```rust
fn should_compact(&self, session: &Session) -> bool {
    let usage_ratio = session.current_tokens() as f64 / session.max_tokens() as f64;
    let turn_count = session.turn_count();
    
    // 当满足以下任一条件时触发压缩：
    // 1. token 使用率超过 50%
    // 2. 每 5 轮自动压缩一次
    // 3. 上次工具调用结果超过 2K tokens
    usage_ratio > 0.50 || turn_count % 5 == 0
}

/// 智能摘要压缩：保留关键决策，压缩冗余历史
async fn smart_compact(session: &mut Session) {
    let messages = session.get_messages();
    let mut compacted = Vec::new();
    
    for (i, msg) in messages.iter().enumerate() {
        match msg.role {
            Role::User => {
                // 保留用户的命令/问题，压缩补充说明
                if msg.content.len() > 200 {
                    compacted.push(Message {
                        role: Role::User,
                        content: truncate_to(&msg.content, 200),
                    });
                } else {
                    compacted.push(msg.clone());
                }
            }
            Role::ToolResult => {
                // 工具结果仅保留摘要（如果 >500 字符）
                if msg.content.len() > 500 {
                    compacted.push(Message {
                        role: Role::ToolResult,
                        content: format!("{{result_id: {}, summary: ... ({} bytes raw)}}", 
                            msg.id, msg.content.len()),
                    });
                } else {
                    compacted.push(msg.clone());
                }
            }
            Role::System => {
                // 系统提示仅在必要时发送
                if i == messages.len() - 1 || compacted.is_empty() {
                    compacted.push(msg.clone());
                }
            }
            _ => compacted.push(msg.clone()),
        }
    }
    
    session.replace_messages(compacted);
}
```

### 方案 5：子代理降级策略（预期节省 10-20%）

**原理**：将复杂任务拆给子代理时，子代理默认继承父级的完整工具集。改为角色裁剪。

**修改文件**：`crates/tui/src/tools/subagent.rs`

```rust
/// 根据子代理角色裁剪工具集
fn get_role_tools(role: SubagentRole) -> Vec<&'static str> {
    match role {
        SubagentRole::Explore => vec!["grep_files", "file_search", "file_read", "list_dir"],
        SubagentRole::Review => vec!["file_read", "grep_files", "diff"],
        SubagentRole::Implementer => vec!["file_read", "file_write", "apply_patch", "exec_shell"],
        SubagentRole::General => vec![], // 所有工具
        _ => vec![],
    }
}
```

此外，为子代理使用**更便宜的模型**（如 `deepseek-v4-flash`），因为子代理通常不需要 Pro 模型的推理能力。

### 方案 6：前缀缓存保活（预期节省 5-10%）

**原理**：DeepSeek V4 的 KV 缓存有前缀亲和性。连续轮次之间如果提示前缀不变，可以复用缓存。

```rust
/// 确保轮次间系统提示前缀稳定
fn stabilize_prefix(session: &Session, tools: &ToolRegistry) -> Vec<Message> {
    let prefix = build_system_prefix(); // 模型 + 基础设置
    let tool_defs = tools.get_sorted_tool_definitions();
    
    // 工具目录哈希用于验证缓存完整性
    let prefix_hash = hash(&(prefix, tool_defs));
    
    if session.last_prefix_hash() == Some(prefix_hash) {
        // 缓存可用，只发送增量更新
        vec![Message::system(prefix)]
    } else {
        // 缓存失效，发送完整提示
        session.set_prefix_hash(prefix_hash);
        vec![Message::system(format!("{}\n\n## Tools\n\n{}", prefix, tool_defs))]
    }
}
```

## 优化方案总结

| 方案 | 预期节省 | 实现难度 | 风险 |
|------|---------|---------|------|
| **1. 工具描述压缩** | 15-25% | ⭐ 低 | 低（模型可能理解错误） |
| **2. 选择性工具注册** | 10-15% | ⭐⭐ 中 | 中（模型可能找不到工具） |
| **3. 工具结果压缩** | 20-30% | ⭐⭐ 中 | 低（摘要保留关键信息） |
| **4. 主动上下文压缩** | 10-15% | ⭐⭐⭐ 高 | 中（压缩可能丢失上下文） |
| **5. 子代理降级+Flash** | 10-20% | ⭐ 低 | 低（子代理独立运行） |
| **6. 前缀缓存保活** | 5-10% | ⭐⭐ 中 | 低（只是优化缓存命中） |

## 建议实施顺序

```
Phase 1 (立即见效, 低风险):
  ── 方案 5: 子代理使用 Flash 模型 + 角色工具裁剪
  ── 方案 1: 工具描述压缩（截断 + 精简 schema）

Phase 2 (持续优化, 中等风险):
  ── 方案 3: 大工具结果自动压缩/摘要
  ── 方案 6: 前缀缓存保活

Phase 3 (深度优化, 需测试):
  ── 方案 2: 动态工具注册（工具热度追踪）
  ── 方案 4: 主动智能上下文压缩
```

## 预期综合效果

实施全部方案后，预计 token 消耗降低 **50-70%**，具体取决于使用模式：

| 场景 | 优化前（轮次/次） | 优化后（轮次/次） | 节省 |
|------|-----------------|-----------------|------|
| 简单问答 | ~3K | ~1.5K | 50% |
| 文件读写 | ~8K | ~3K | 62% |
| 多轮编码 | ~50K | ~18K | 64% |
| 子代理任务 | ~100K | ~30K | 70% |
