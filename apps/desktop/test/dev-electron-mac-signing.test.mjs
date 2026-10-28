import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as devElectron from "../../../scripts/dev-electron.mjs";

const MACHO_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]);
const FAT_MACHO = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]);

function write(path, contents = MACHO_64) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function createElectronBundle(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-mac-sign-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "PI-Desktop.app");
  const paths = {
    app,
    main: join(app, "Contents", "MacOS", "PI-Desktop"),
    helperBinary: join(
      app,
      "Contents",
      "Frameworks",
      "Electron Helper.app",
      "Contents",
      "MacOS",
      "Electron Helper",
    ),
    helperBundle: join(app, "Contents", "Frameworks", "Electron Helper.app"),
    frameworkBinary: join(
      app,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Electron Framework",
    ),
    frameworkHelper: join(
      app,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Helpers",
      "chrome_crashpad_handler",
    ),
    frameworkBundle: join(app, "Contents", "Frameworks", "Electron Framework.framework"),
    dylib: join(app, "Contents", "Frameworks", "libffmpeg.dylib"),
    resource: join(app, "Contents", "Resources", "icudtl.dat"),
  };
  write(paths.main);
  write(paths.helperBinary, FAT_MACHO);
  write(paths.frameworkBinary);
  write(paths.frameworkHelper);
  write(paths.dylib);
  write(paths.resource, Buffer.from("not a mach-o binary"));
  return paths;
}

function recordCommands() {
  const calls = [];
  return {
    calls,
    runCommand: (command, args) => calls.push([command, ...args]),
  };
}

test("signAdHocMacBundle signs nested code before the app bundle", (t) => {
  const paths = createElectronBundle(t);
  const { calls, runCommand } = recordCommands();

  devElectron.signAdHocMacBundle({
    bundlePath: paths.app,
    identifier: "net.aiuo.pi-desktop.dev",
    runCommand,
  });

  assert.ok(calls.length > 0, "expected codesign invocations");
  const signedPaths = calls.map((call) => call.at(-1));
  const position = (path) => {
    const index = signedPaths.indexOf(path);
    assert.notEqual(index, -1, `expected ${path} to be signed`);
    return index;
  };
  const appPosition = position(paths.app);

  for (const nested of [
    paths.helperBinary,
    paths.frameworkBinary,
    paths.frameworkHelper,
    paths.dylib,
    paths.helperBundle,
    paths.frameworkBundle,
  ]) {
    assert.ok(position(nested) < appPosition, `${nested} must be signed before the app bundle`);
  }
  assert.ok(
    position(paths.helperBinary) < position(paths.helperBundle),
    "helper executable must be signed before its bundle",
  );
  assert.ok(
    position(paths.frameworkBinary) < position(paths.frameworkBundle),
    "framework binary must be signed before its bundle",
  );
  assert.ok(
    position(paths.frameworkHelper) < position(paths.frameworkBinary),
    "framework helper code must be signed before the framework executable",
  );

  assert.equal(signedPaths.at(-1), paths.app);
  assert.ok(
    calls.every((call) => call[0] === "codesign" && !call.includes("--deep")),
    "must not rely on codesign --deep",
  );
  assert.ok(calls.at(-1).includes("--identifier"));
  assert.ok(calls.at(-1).includes("net.aiuo.pi-desktop.dev"));
});

test("signAdHocMacBundle skips files that are not Mach-O binaries", (t) => {
  const paths = createElectronBundle(t);
  const { calls, runCommand } = recordCommands();

  devElectron.signAdHocMacBundle({ bundlePath: paths.app, runCommand });

  const signedPaths = calls.map((call) => call.at(-1));
  assert.ok(!signedPaths.includes(paths.resource));
});
