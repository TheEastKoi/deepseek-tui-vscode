---
name: deepseek-tui-debug
description: Debugging and troubleshooting workflow for the DeepSeek TUI VS Code extension (forked from Continue). Use when extension fails to activate, shows blank GUI, or encounters module resolution failures. Covers the build → install → diagnose → fix cycle.
---

# DeepSeek TUI Extension Debugging

The complete debugging workflow for the DeepSeek TUI VS Code extension. Project at `e:/git_code/deepseek-tui-vscode`.

## Architecture

```
deepseek-tui-vscode/
├── extensions/vscode/    # VS Code extension source
│   └── src/
│       ├── extension.ts           # Entry point: activate()
│       ├── activation/activate.ts  # Extension setup
│       ├── extension/VsCodeExtension.ts  # Constructor: registers providers, commands
│       ├── ContinueGUIWebviewViewProvider.ts  # Sidebar WebView
│       └── ContinueConsoleWebviewViewProvider.ts  # Console WebView
├── core/                 # Shared logic (llm, config, tools)
├── gui/                  # React frontend (Vite build)
└── packages/             # Internal @continuedev/* packages
```

## Build & Install

```bash
cd e:/git_code/deepseek-tui-vscode
D:/nodejs/node build_ext.js
```

The build script does:
1. **Build GUI**: Vite → `gui/dist/assets/` → copy to `extensions/vscode/gui/assets/`
2. **Build Extension**: esbuild → `extensions/vscode/out/extension.js` (bundle: 51MB)
3. **Post-build patch**: Replace `require.resolve("./xhr-sync-worker.js")` → null
4. **Copy native modules**: Recursively resolve & copy all dependencies of external native modules (61 packages)
5. **Install to VS Code**: Copy to `~/.vscode/extensions/theeastkoi.deepseek-tui-vscode-0.1.0/`

## Activation Chain

```
activate() [extension.ts:20]
  → setupCa() [core/util/ca.ts] (dynamic import system-ca, try/catch)
  → dynamicImportAndActivate() [extension.ts:14]
    → activateExtension() [activation/activate.ts:12]
      → new VsCodeExtension(context) [extension/VsCodeExtension.ts:178]
        → register sidebar WebView provider (line 266)
        → new Core() (line 294) — loads config, initializes LLMs
        → registerAllCommands() (line 423)
        → setup autocomplete, inline chat, etc.
```

If any step throws, the `.catch()` in `activate()` shows a warning popup.

## Diagnosing Activation Failure

When extension icon shows but sidebar is blank:

1. **Open VS Code Developer Tools**: `Ctrl+Shift+P` → `开发人员: 切换开发人员工具`
2. **Console tab → filter**: `Error activating` or `Activating extension`
3. **Read the stack trace**: It shows the exact missing module path

## Build Strategy

| Type | Handling |
|------|----------|
| `vscode` API module | Always external |
| Native C++ modules (`sqlite3`, `bindings`, `win-ca`, `mac-ca`, `system-ca`, etc.) | External + recursively copy dependency tree |
| All other npm packages | Bundled into extension.js |
| GUI (React) | Vite build, copy assets to `gui/assets/` |

## Common Error Patterns

See `references/common_issues.md` for the full list.

**Module not found during activation:**
```
Error activating extension: Error: Cannot find module 'xxx'
```
→ Check if it's a bundled npm dependency or a transitive dep of a native module.
→ If npm dep: ensure `xxx` is NOT in the external list (esbuild will bundle it).
→ If native dep: ensure `xxx` is either in `nativeModules` list or gets copied via recursive resolver.

**WebView blank but extension activated:**
→ Check `gui/assets/index.js` exists and has correct content.
→ Check webview URIs in `ContinueGUIWebviewViewProvider.ts` reference correct paths.

## Development Cycle

1. Edit source files
2. Run `D:/nodejs/node build_ext.js`
3. Close & reopen VS Code (or `Ctrl+Shift+P` → `开发人员: 重新加载窗口`)
4. Test

**Do NOT use F5 debugging** — the extension must be installed to `~/.vscode/extensions/` to load properly.
