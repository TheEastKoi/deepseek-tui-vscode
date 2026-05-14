const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const root = __dirname;
const extDir = path.join(root, 'extensions', 'vscode');
const outDir = path.join(extDir, 'out');

// ===== Step 1: Build GUI (Vite) =====
console.log('\n=== Step 1: Building GUI ===');
const guiDir = path.join(root, 'gui');
const guiOutputDir = path.join(extDir, 'gui', 'assets');

// Run Vite build
const { execSync } = require('child_process');
const node = process.execPath;
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (fs.existsSync(vite)) {
  try {
    execSync(`"${node}" "${vite}" build`, {
      cwd: guiDir,
      stdio: 'pipe',
      timeout: 120000,
    });
    console.log('✅ GUI build completed');
  } catch (e) {
    console.error('⚠️ GUI build failed:', e.stderr ? e.stderr.toString().slice(0, 300) : e.message);
    console.log('⚠️ Using existing GUI files if available');
  }
} else {
  console.log('⚠️ Vite not found at', vite);
}

// Copy GUI files from gui/dist/ to extensions/vscode/gui/assets/
const guiDistDir = path.join(guiDir, 'dist');
if (fs.existsSync(guiDistDir)) {
  // Copy assets subdirectory content to gui/assets/
  const guiDistAssets = path.join(guiDistDir, 'assets');
  if (fs.existsSync(guiDistAssets)) {
    // Clean old assets first
    if (fs.existsSync(guiOutputDir)) {
      fs.rmSync(guiOutputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(guiOutputDir, { recursive: true });
    const entries = fs.readdirSync(guiDistAssets, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(guiDistAssets, entry.name);
      const destPath = path.join(guiOutputDir, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(srcPath, destPath, { recursive: true });
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
    console.log('✅ GUI assets copied to', path.relative(root, guiOutputDir));
  }
} else {
  console.log('⚠️ No GUI dist found at', guiDistDir);
}

// ===== Step 2: Build Extension (esbuild) =====
console.log('\n=== Step 2: Building Extension ===');

// Create .buildTimestamp.ts if missing
const tsPath = path.join(extDir, 'src', '.buildTimestamp.ts');
if (!fs.existsSync(tsPath)) {
  fs.writeFileSync(tsPath, 'const buildTimestamp = "' + Date.now() + '";\nexport default buildTimestamp;\n');
  console.log('Created .buildTimestamp.ts');
}
fs.mkdirSync(outDir, { recursive: true });

const extPkg = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8'));

// Native modules that must be external (C++ addons)
const nativeModules = [
  'sqlite3', 'bindings', 'node-gyp', 'node-gyp-build',
  'mac-ca', 'win-ca', 'system-ca',
  'onnxruntime', 'onnxruntime-node', '@onnxruntime/*',
  'keytar', 'node-pty', 'spawn-sync',
  'utf-8-validate', 'bufferutil', 'fsevents',
];

// External = only vscode and native C++ modules (everything else must be bundled)
const external = [
  'vscode',
  ...nativeModules,
];

console.log('External modules:', external.length);

esbuild.build({
  entryPoints: [path.join(extDir, 'src', 'extension.ts')],
  outfile: path.join(outDir, 'extension.js'),
  bundle: true,
  external,
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  logLevel: 'warning',
  loader: { '.node': 'copy' },
  assetNames: '[name]-[hash]',
  nodePaths: [
    path.join(root, 'node_modules'),
    path.join(extDir, 'node_modules'),
  ],
  plugins: [{
    name: 'local-packages',
    setup(build) {
      const localPackages = {
        '@continuedev/fetch': path.join(root, 'packages', 'fetch', 'src', 'index.ts'),
        '@continuedev/llm-info': path.join(root, 'packages', 'llm-info', 'src', 'index.ts'),
        '@continuedev/openai-adapters': path.join(root, 'packages', 'openai-adapters', 'src', 'index.ts'),
        '@continuedev/config-yaml': path.join(root, 'packages', 'config-yaml', 'dist', 'index.js'),
        '@continuedev/config-types': path.join(root, 'packages', 'config-types', 'src', 'index.ts'),
        '@continuedev/terminal-security': path.join(root, 'packages', 'terminal-security', 'src', 'index.ts'),
      };
      for (const [pkg, targetPath] of Object.entries(localPackages)) {
        if (fs.existsSync(targetPath)) {
          build.onResolve({ filter: new RegExp('^' + pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }, () => {
            return { path: targetPath };
          });
        }
      }
    }
  }],
}).then(() => {
  const stats = fs.statSync(path.join(outDir, 'extension.js'));
  console.log('✅ Extension build SUCCESS:', (stats.size / 1024 / 1024).toFixed(1), 'MB');

  // Patch: Replace require.resolve('./xhr-sync-worker.js') with null
  const jsPath = path.join(outDir, 'extension.js');
  let jsContent = fs.readFileSync(jsPath, 'utf8');
  const patched = jsContent.replace(
    /require\.resolve\(['"]\.\/xhr-sync-worker\.js['"]\)/g,
    'null',
  );
  if (patched !== jsContent) {
    fs.writeFileSync(jsPath, patched, 'utf8');
    console.log('🔧 Patched require.resolve("./xhr-sync-worker.js") → null');
  }

  // ===== Step 3: Copy native modules (needed at runtime) =====
  console.log('\n=== Step 3: Copying native modules ===');
  const vscodeExtDir = path.join(
    process.env.USERPROFILE || process.env.HOME || 'C:/Users/59805',
    '.vscode', 'extensions', 'theeastkoi.deepseek-tui-vscode-0.1.0',
  );

  // Remove old installation
  if (fs.existsSync(vscodeExtDir)) {
    fs.rmSync(vscodeExtDir, { recursive: true, force: true });
  }

  // Create extension directory
  fs.mkdirSync(vscodeExtDir, { recursive: true });
  fs.mkdirSync(path.join(vscodeExtDir, 'out'), { recursive: true });
  
  // Copy built extension
  fs.cpSync(outDir, path.join(vscodeExtDir, 'out'), { recursive: true });
  
  // Copy package.json
  fs.copyFileSync(
    path.join(extDir, 'package.json'),
    path.join(vscodeExtDir, 'package.json'),
  );

// Copy native module node_modules for runtime
const nmDir = path.join(vscodeExtDir, 'node_modules');

// Recursively resolve and copy all dependencies of external native modules
const copiedPkgs = new Set();

function resolveAndCopyPkg(pkgName, depth = 0) {
  if (copiedPkgs.has(pkgName) || depth > 5) return;
  const srcDir = path.join(root, 'node_modules', pkgName);
  if (!fs.existsSync(srcDir)) return;
  
  const destDir = path.join(nmDir, pkgName);
  if (!fs.existsSync(destDir)) {
    fs.cpSync(srcDir, destDir, { recursive: true, force: true });
    copiedPkgs.add(pkgName);
    console.log(`${'  '.repeat(depth)}📦 ${pkgName}`);
  } else {
    copiedPkgs.add(pkgName);
    return;
  }

  // Read package.json to find sub-dependencies
  const pkgJsonPath = path.join(srcDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const allDeps = {
        ...(pkgJson.dependencies || {}),
        ...(pkgJson.peerDependencies || {}),
        ...(pkgJson.optionalDependencies || {}),
      };
      for (const dep of Object.keys(allDeps)) {
        resolveAndCopyPkg(dep, depth + 1);
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
}

// Start with the native modules we need
const nativePkgs = ['sqlite3', 'win-ca', 'mac-ca', 'system-ca', 'bindings', 'node-gyp-build'];
console.log(`Resolving dependencies for ${nativePkgs.length} native packages...`);
for (const pkg of nativePkgs) {
  resolveAndCopyPkg(pkg);
}
console.log(`✅ Copied ${copiedPkgs.size} packages total`);

  // Copy media (icon, etc.)
  const vscodeMediaDir = path.join(vscodeExtDir, 'media');
  if (fs.existsSync(path.join(extDir, 'media'))) {
    fs.cpSync(path.join(extDir, 'media'), vscodeMediaDir, { recursive: true });
  }

  // Copy GUI assets to install directory
  const vscodeGuiDir = path.join(vscodeExtDir, 'gui');
  if (fs.existsSync(guiOutputDir)) {
    fs.mkdirSync(path.join(vscodeGuiDir, 'assets'), { recursive: true });
    fs.cpSync(guiOutputDir, path.join(vscodeGuiDir, 'assets'), { recursive: true });
    // Copy HTML files too
    if (fs.existsSync(path.join(extDir, 'gui', 'index.html'))) {
      fs.copyFileSync(path.join(extDir, 'gui', 'index.html'), path.join(vscodeGuiDir, 'index.html'));
    }
    if (fs.existsSync(path.join(extDir, 'gui', 'indexConsole.html'))) {
      fs.copyFileSync(path.join(extDir, 'gui', 'indexConsole.html'), path.join(vscodeGuiDir, 'indexConsole.html'));
    }
    console.log('✅ GUI assets installed to', path.relative('C:/Users/59805/.vscode/extensions', vscodeExtDir));
  }

  console.log('✅ Extension installed to', vscodeExtDir);
  console.log('\n🎉 Build + Install complete! Reload VS Code to use DeepSeek TUI.');
}).catch(e => {
  console.error('Build ERROR:', e.message);
  process.exit(1);
});
