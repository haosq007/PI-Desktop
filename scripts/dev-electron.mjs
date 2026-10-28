#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "PI-Desktop";
const DEV_BUNDLE_ID = "net.aiuo.pi-desktop.dev";
const BRANDING_SCHEMA = "v4";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_ROOT = join(ROOT, "apps", "desktop");

function resolvePackagePath(packageName) {
  const require = createRequire(join(DESKTOP_ROOT, "package.json"));
  return require.resolve(`${packageName}/package.json`);
}

function resolveElectronInstallation() {
  const packagePath = resolvePackagePath("electron");
  const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
  const require = createRequire(join(DESKTOP_ROOT, "package.json"));
  const executable = require("electron");
  return {
    executablePath: executable,
    version,
  };
}

function setPlistString(plistPath, key, value) {
  execFileSync("plutil", ["-replace", key, "-string", value, plistPath]);
}

const MACHO_MAGICS = new Set([
  0xcafebabe, // universal, 32-bit offsets
  0xcafebabf, // universal, 64-bit offsets
  0xbebafeca, // universal, reversed byte order
  0xbfbafeca,
  0xfeedface, // 32-bit
  0xfeedfacf, // 64-bit
  0xcefaedfe, // 32-bit, reversed byte order
  0xcffaedfe, // 64-bit, reversed byte order
]);

function isMachOFile(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    return bytesRead === header.length && MACHO_MAGICS.has(header.readUInt32BE(0));
  } finally {
    closeSync(descriptor);
  }
}

function collectSigningTargets(bundlePath) {
  const targets = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (/\.(app|framework|xpc)$/.test(entry.name)) targets.push(entryPath);
        walk(entryPath);
      } else if (entry.isFile() && isMachOFile(entryPath)) {
        targets.push(entryPath);
      }
    }
  };
  walk(bundlePath);
  // codesign seals a bundle's nested code, so sign deepest targets first and
  // leave the outer app bundle for last.
  targets.sort((left, right) => right.split(sep).length - left.split(sep).length);
  return targets;
}

export function signAdHocMacBundle({ bundlePath, identifier, runCommand = execFileSync }) {
  // codesign rejects a bundle while nested code is unsigned, and `--deep`
  // re-signing is unreliable on Electron frameworks, so sign every nested
  // binary and bundle bottom-up before sealing the top-level bundle.
  for (const target of collectSigningTargets(bundlePath)) {
    runCommand("codesign", ["--force", "--sign", "-", target]);
  }
  const args = ["--force", "--sign", "-"];
  if (identifier) args.push("--identifier", identifier);
  args.push(bundlePath);
  runCommand("codesign", args);
}

export function prepareMacDevelopmentBundle({
  electronExecutable,
  electronVersion,
  iconPath,
  trayIconPath,
  trayIconMacPath,
  cacheRoot,
  sign = true,
}) {
  const sourceBundle = dirname(dirname(dirname(electronExecutable)));
  const brandingHash = createHash("sha256");
  for (const [name, path] of [
    ["application icon", iconPath],
    ["tray icon", trayIconPath],
    ["macOS tray icon", trayIconMacPath],
  ]) {
    if (!existsSync(path)) {
      throw new Error(`Development bundle ${name} is missing: ${path}`);
    }
    brandingHash.update(name).update("\0").update(readFileSync(path));
  }
  const brandingHashPrefix = brandingHash.digest("hex").slice(0, 12);
  const cacheKey = `${electronVersion}-${brandingHashPrefix}-${BRANDING_SCHEMA}`;
  const targetRoot = join(cacheRoot, cacheKey);
  const targetBundle = join(targetRoot, `${APP_NAME}.app`);
  const targetExecutable = join(
    targetBundle,
    "Contents",
    "MacOS",
    APP_NAME,
  );
  const markerPath = join(targetRoot, "ready.json");
  const targetResources = join(targetBundle, "Contents", "Resources");
  const targetTrayIcon = join(targetResources, "tray-icon.png");
  const targetTrayIconMac = join(targetResources, "tray-icon-mac.png");

  if (
    existsSync(markerPath) &&
    existsSync(targetExecutable) &&
    existsSync(targetTrayIcon) &&
    existsSync(targetTrayIconMac)
  ) {
    return targetExecutable;
  }
  if (existsSync(targetRoot)) rmSync(targetRoot, { recursive: true, force: true });

  mkdirSync(cacheRoot, { recursive: true });
  const stagingRoot = join(cacheRoot, `${cacheKey}.staging-${process.pid}`);
  const stagingBundle = join(stagingRoot, `${APP_NAME}.app`);
  rmSync(stagingRoot, { recursive: true, force: true });

  try {
    cpSync(sourceBundle, stagingBundle, {
      recursive: true,
      verbatimSymlinks: true,
    });

    const contents = join(stagingBundle, "Contents");
    const macos = join(contents, "MacOS");
    const resources = join(contents, "Resources");
    const sourceExecutable = join(macos, "Electron");
    const brandedExecutable = join(macos, APP_NAME);
    renameSync(sourceExecutable, brandedExecutable);
    copyFileSync(iconPath, join(resources, "icon.icns"));
    copyFileSync(trayIconPath, join(resources, "tray-icon.png"));
    copyFileSync(trayIconMacPath, join(resources, "tray-icon-mac.png"));

    const plistPath = join(contents, "Info.plist");
    setPlistString(plistPath, "CFBundleDisplayName", APP_NAME);
    setPlistString(plistPath, "CFBundleName", APP_NAME);
    setPlistString(plistPath, "CFBundleExecutable", APP_NAME);
    setPlistString(plistPath, "CFBundleIdentifier", DEV_BUNDLE_ID);
    setPlistString(plistPath, "CFBundleIconFile", "icon.icns");

    if (sign) {
      signAdHocMacBundle({
        bundlePath: stagingBundle,
        identifier: DEV_BUNDLE_ID,
      });
    }

    writeFileSync(
      join(stagingRoot, "ready.json"),
      `${JSON.stringify({ electronVersion, brandingHash: brandingHashPrefix })}\n`,
    );
    renameSync(stagingRoot, targetRoot);
    return targetExecutable;
  } catch (error) {
    const cacheWonRace =
      (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") &&
      existsSync(markerPath) &&
      existsSync(targetExecutable) &&
      existsSync(targetTrayIcon) &&
      existsSync(targetTrayIconMac);
    rmSync(stagingRoot, { recursive: true, force: true });
    if (cacheWonRace) return targetExecutable;
    throw error;
  }
}

function run() {
  const env = { ...process.env, PI_DESKTOP_DEV: "1" };
  // Electron 43+ downloads its platform binary when its package is resolved.
  // electron-vite requires the resulting path.txt marker on every platform.
  const electron = resolveElectronInstallation();
  if (process.platform === "darwin") {
    env.ELECTRON_EXEC_PATH = prepareMacDevelopmentBundle({
      electronExecutable: electron.executablePath,
      electronVersion: electron.version,
      iconPath: join(DESKTOP_ROOT, "build", "icon.icns"),
      trayIconPath: join(DESKTOP_ROOT, "build", "icon.png"),
      trayIconMacPath: join(DESKTOP_ROOT, "build", "tray-icon-mac.png"),
      cacheRoot: join(ROOT, ".cache", "electron-dev"),
    });
  }

  const electronVitePackage = resolvePackagePath("electron-vite");
  const electronViteCli = join(
    dirname(electronVitePackage),
    "bin",
    "electron-vite.js",
  );
  const child = spawn(
    process.execPath,
    [electronViteCli, "dev", ...process.argv.slice(2)],
    {
      cwd: DESKTOP_ROOT,
      env,
      stdio: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
