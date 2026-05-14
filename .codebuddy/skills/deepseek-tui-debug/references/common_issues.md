# Common Issues and Fixes

## Activation Failures (GUI Blank)

### 1. `Cannot find module 'system-ca'`

**Symptom:** Extension fails to activate, `mainThreadExtensionService.ts:108` shows error.

**Cause:** Static `import { systemCertsAsync } from "system-ca"` at top of `core/util/ca.ts` resolves native module at load time.

**Fix:** Remove static import, use dynamic `import()` inside try/catch.

File: `core/util/ca.ts`

```typescript
// BEFORE:
import { systemCertsAsync } from "system-ca";
export async function setupCa() { ... }

// AFTER: Remove the import line entirely
export async function setupCa() {
  try {
    const { systemCertsAsync } = await import("system-ca");
    // ...
  } catch (e) {
    console.warn("Failed to setup CA: ", e);
  }
}
```

---

### 2. `Cannot find module 'node-fetch'` / `follow-redirects` / `posthog-node`

**Symptom:** Multiple "Cannot find module" errors during activation.

**Cause:** These npm packages were marked as `external` in esbuild config, but they're not present in the VS Code extensions install directory at runtime.

**Fix:** Do NOT external npm packages. Only external `vscode` and native C++ modules.

File: `build_ext.js`

```javascript
// BEFORE:
const external = [
  'vscode',
  ...Object.keys(allDeps).filter(d => !d.startsWith('@continuedev/')),
  ...nativeModules,
];

// AFTER:
const external = [
  'vscode',
  ...nativeModules,
];
```

---

### 3. `Cannot find module 'file-uri-to-path'`

**Symptom:** sqlite3 fails to load because `bindings` can't find `file-uri-to-path`.

**Cause:** `sqlite3` (native, external) → requires `bindings` (native, external) → requires `file-uri-to-path` (JS, not copied). Only top-level native packages were copied, not their transitive JS dependencies.

**Fix:** Recursively resolve and copy all transitive dependencies of external native modules.

File: `build_ext.js`

```javascript
function resolveAndCopyPkg(pkgName, depth = 0) {
  if (copiedPkgs.has(pkgName) || depth > 5) return;
  // ...copy the package...
  
  // Read package.json for dependencies, peerDependencies, optionalDependencies
  const allDeps = {
    ...(pkgJson.dependencies || {}),
    ...(pkgJson.peerDependencies || {}),
    ...(pkgJson.optionalDependencies || {}),
  };
  for (const dep of Object.keys(allDeps)) {
    resolveAndCopyPkg(dep, depth + 1);
  }
}
```

---

### 4. `Cannot find module 'win-export-certificate-and-key'`

**Symptom:** `Failed to setup CA` error referencing `system-ca\src\impl.ts`.

**Cause:** `system-ca` has `win-export-certificate-and-key` in `optionalDependencies`. The copy step didn't read optionalDependencies.

**Fix:** Include `optionalDependencies` in the recursive resolver (same fix as issue #3).

---

### 5. `Cannot find module './xhr-sync-worker.js'`

**Symptom:** jsdom throws at runtime.

**Cause:** jsdom uses `require.resolve("./xhr-sync-worker.js")` relative to bundled file path.

**Fix:** Post-build patch in `build_ext.js`:

```javascript
const patched = jsContent.replace(
  /require\.resolve\(['"]\.\/xhr-sync-worker\.js['"]\)/g,
  'null',
);
```

Also ensure `'./xhr-sync-worker.js'` is NOT in the external list (otherwise esbuild won't inline it).

---

## GUI Issues

### 6. Blank sidebar (icon shows, panel is empty/loading)

**Symptom:** Sidebar opens but shows "正在加载..." or blank. No UI content.

**Possible causes & fixes in order of likelihood:**

| # | Cause | Check | Fix |
|---|-------|-------|-----|
| A | Extension activation failed | DevTools Console: filter `Error activating` | See issues #1–5 above |
| B | GUI assets copied to wrong path | Check `gui/assets/index.js` exists (NOT `gui/assets/assets/index.js`) | Fix `build_ext.js` copy logic |
| C | WebView tries localhost:5173 | Check for WebSocket errors in WebView DevTools | Remove development mode check from Provider |
| D | CSP / content security error | Open WebView DevTools (`Ctrl+Shift+P` → `Webview 开发人员工具`) | Check console errors |

**Verify GUI files:**
```bash
ls C:/Users/59805/.vscode/extensions/theeastkoi.deepseek-tui-vscode-0.1.0/gui/assets/
# Should show: index.js, index.css (NOT assets/ subdirectory)
```

---

### 7. GUI tries to connect to `localhost:5173`

**Symptom:** Sidebar shows "connecting..." or blank, WebSocket connection errors.

**Cause:** `ContinueGUIWebviewViewProvider.ts` has `if (inDevelopmentMode)` block that loads from Vite dev server.

**Fix:** Remove the dev mode check — always load from built files.

File: `extensions/vscode/src/ContinueGUIWebviewViewProvider.ts`

```typescript
// BEFORE:
if (context?.extensionMode === vscode.ExtensionMode.Development) {
  scriptUri = "http://localhost:5173/src/main.tsx";
} else {
  scriptUri = panel.webview.asWebviewUri(...).toString();
}

// AFTER:
// Always use built files, no dev mode check
scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "gui/assets/index.js")).toString();
```

---

## Build Issues

### 8. Vite build fails / hangs

**Symptom:** `gui/vite.config.ts` build fails.

**Causes & fixes:**

| Cause | Fix |
|-------|-----|
| Sentry plugin requires env vars | Remove `@sentry/vite-plugin` from vite.config.ts |
| Portal / network dependency | Remove portal plugin or add `--mode production` |
| Entry not found | Check `vite.config.ts` → `build.rollupOptions.input` points to correct file |

---

### 9. `import.meta.url` warning during esbuild build

**Symptom:**
```
▲ [WARNING] "import.meta" is not available with the "cjs" output format
```

**Cause:** Code uses `import.meta.url` but output format is CJS.

**Fix:** Replace with `__dirname` (available in CJS):

```typescript
// BEFORE:
path.dirname(new URL(import.meta.url).pathname)

// AFTER (CJS):
__dirname
```

File: `core/llm/llms/TransformersJsEmbeddingsProvider.ts`

---

## VS Code Installation

### 10. Extension still uses old version

**Symptom:** Changes don't take effect after rebuild.

**Cause:** Old installation at `~/.vscode/extensions/theeastkoi.deepseek-tui-vscode-0.1.0/` wasn't fully cleaned.

**Fix:** Delete before rebuilding:

```bash
rm -rf "C:/Users/59805/.vscode/extensions/theeastkoi.deepseek-tui-vscode-0.1.0"
```

Or just run `build_ext.js` which does this automatically.

---

### 11. "Not yet activated" status

**Symptom:** Extension icon exists but shows "Not yet activated" on hover.

**Cause:** `activate()` function was never called — extension load failed at module parsing stage (before `activate`).

**Fix:** Check the main DevTools Console for errors at parse time (usually a `SyntaxError` or `Cannot find module` at top-level import). Files most likely to cause this:
- `extension.ts` — top-level imports
- `core/util/ca.ts` — static `import from "system-ca"`
- Any file with misconfigured path resolution
