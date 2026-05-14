# DeepSeek TUI VS Code Extension - 修改记录

## 2026-05-14: 初始改造（从 Continue fork）

### 品牌重命名（continue → deepseek）

| 文件 | 修改 |
|------|------|
| `extensions/vscode/package.json` | publisher: Continue → TheEastKoi, displayName 改为 DeepSeek TUI |
| `extensions/vscode/package.json` | 所有 continue.* 配置键 → deepseek.* |
| `extensions/vscode/package.json` | 所有 continue.* 命令 ID → deepseek.* |
| `extensions/vscode/package.json` | 视图 ID: continue.continueGUIView → deepseek.deepseekGUIView |
| `extensions/vscode/package.json` | 视图容器: continue → deepseek |
| `core/control-plane/env.ts` | EXTENSION_NAME: "continue" → "deepseek" |
| `core/util/ca.ts` | win32 平台改用 require() + fallback 解决 ESM 兼容问题 |

### 构建系统

| 文件 | 修改 |
|------|------|
| `.vscode/launch.json` | 新增，指向 `extensions/vscode/` |
| `.vscode/tasks.json` | 新增 |
| `build_ext.js` | 新增：一键构建 GUI + 扩展 + 安装到 VS Code |
| `gui/vite.config.ts` | 移除了 Sentry 插件（堵塞构建） |

---

## GUI 空白/插件激活失败 — 完整排查与修复记录

### 现象

点击左侧 DeepSeek TUI 图标后，侧边栏显示"正在加载..."（转圈），无任何 UI 内容。扩展图标能显示，但 WebView 内容出不来。

### 根本原因（多重连锁问题）

| 序号 | 问题 | 影响 | 修复位置 |
|------|------|------|---------|
| ① | **Vite 开发模式** — `ContinueGUIWebviewViewProvider.ts` 检测到 `ExtensionMode.Development` 时尝试加载 `http://localhost:5173`，但开发服务器未运行 | WebView 白屏 | `ContinueGUIWebviewViewProvider.ts` — 移除开发模式判断，始终加载构建产物 |
| ② | **GUI 路径错误** — 代码写死 `gui/assets/index.js`，但 Vite 输出在 `gui/dist/assets/`，构建脚本复制时多套了一层 `assets/assets/` | GUI 文件实际路径不对 | `build_ext.js` — 修正复制逻辑：只复制 `dist/assets/*` 到 `gui/assets/` |
| ③ | **xhr-sync-worker.js** — jsdom 使用 `require.resolve("./xhr-sync-worker.js")` 相对路径查找，但运行时目录不同 | 激活时报模块找不到 | `build_ext.js` — 构建后 patch 替换为 `null` |
| ④ | **system-ca 静态 import** — `core/util/ca.ts` 顶部静态 `import { systemCertsAsync } from "system-ca"` 导致模块加载时就需要解析 native 模块 | 激活失败 | `ca.ts` — 改为动态 `import()` 并 try/catch |
| ⑤ | **所有 npm 包标记为 external** — `build_ext.js` 将除 `@continuedev/*`, `core` 外的所有依赖都设为 external，但运行时这些包不在安装目录 | 不断出现 `Cannot find module 'xxx'`（node-fetch, follow-redirects, posthog-node 等） | `build_ext.js` — 只 external `vscode` + native C++ 模块，其余全部内联打包 |
| ⑥ | **Native 模块的 JS 依赖缺失** — native 模块（如 `sqlite3` → `bindings` → `file-uri-to-path`）被 external 后，它们的 JS 依赖链没跟着复制 | 运行时缺少 `file-uri-to-path`, `win-export-certificate-and-key` 等 | `build_ext.js` — 递归解析 native 模块的 package.json 依赖链，复制全部依赖（6→61个包） |

### 排查流程

```
插件图标出现但空白
  ├─ 主窗口 DevTools Console 搜 "Error activating" → 显示具体缺失模块
  │
  ├─ [缺失 xhr-sync-worker.js]  → 构建后 patch require.resolve → null
  ├─ [缺失 system-ca]           → 改为动态 import + try/catch
  ├─ [缺失 node-fetch/follow-redirects/posthog-node]
  │     └─ 发现根因：所有 npm 包被标记为 external
  │        └─ 修复：只 external vscode + native 模块，其余打包
  ├─ [缺失 file-uri-to-path]    → native 模块的递归依赖复制
  └─ [缺失 win-export-certificate-and-key] → optionalDependencies 也要复制
```

### 最终构建策略

| 类型 | 处理方式 |
|------|---------|
| `vscode` | 始终 external（VS Code API） |
| Native C++ 模块（sqlite3, win-ca, mac-ca, system-ca, bindings 等） | external + 递归复制依赖链到安装目录 |
| 其余所有 npm 包 | 全部内联打包进 extension.js（51MB） |
| GUI 前端 | Vite 构建到 `gui/dist/` → 复制 `assets/*` 到 `extensions/vscode/gui/assets/` |

### 修改的文件

| 文件 | 变更 |
|------|------|
| `build_ext.js` | 新增完整脚本：Vite 构建 → esbuild 扩展构建 → post-build patch → 递归复制 native 依赖 → 安装到 VS Code |
| `extensions/vscode/src/ContinueGUIWebviewViewProvider.ts` | 移除开发模式逻辑，标题改为 DeepSeek TUI |
| `extensions/vscode/src/ContinueConsoleWebviewViewProvider.ts` | 同上 |
| `core/util/ca.ts` | 静态 import → 动态 import + try/catch |
| `core/llm/llms/TransformersJsEmbeddingsProvider.ts` | 修复 `import.meta.url` CJS 警告 |
