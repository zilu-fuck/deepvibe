import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const npmCliPath = path.resolve(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageName = typeof packageJson.name === "string" ? packageJson.name : "deepvibe-core";

let tarballPath;
let tempRoot;

try {
  console.log("[release:smoke] Packing tarball...");
  const packResult = runNpm(["pack", "--json"], { cwd: repoRoot });
  const packEntries = JSON.parse(packResult.stdout);

  if (!Array.isArray(packEntries) || packEntries.length === 0 || typeof packEntries[0]?.filename !== "string") {
    throw new Error("npm pack did not return a tarball filename.");
  }

  tarballPath = path.resolve(repoRoot, packEntries[0].filename);

  if (!existsSync(tarballPath)) {
    throw new Error(`Packed tarball does not exist: ${tarballPath}`);
  }

  tempRoot = mkdtempSync(path.join(tmpdir(), "deepvibe-release-smoke-"));
  const installPrefix = path.join(tempRoot, "prefix");

  console.log("[release:smoke] Installing tarball into a temporary prefix...");
  runNpm(["install", "--prefix", installPrefix, tarballPath], { cwd: repoRoot });

  const installedPackageJsonPath = path.join(installPrefix, "node_modules", packageName, "package.json");

  if (!existsSync(installedPackageJsonPath)) {
    throw new Error(`Installed package.json was not found: ${installedPackageJsonPath}`);
  }

  const installedPackageJson = JSON.parse(readFileSync(installedPackageJsonPath, "utf8"));
  const binEntry = typeof installedPackageJson.bin?.deepvibe === "string"
    ? installedPackageJson.bin.deepvibe
    : "./dist/index.js";
  const installedPackageRoot = path.dirname(installedPackageJsonPath);
  let installedCommand;

  try {
    installedCommand = await resolveInstalledCommand(installPrefix, installedPackageRoot, packageName, binEntry);
  } catch {
    try {
      installedCommand = extractPackedCommand(tarballPath, tempRoot, binEntry);
    } catch {
      installedCommand = {
        kind: "node",
        target: path.resolve(repoRoot, "dist", "index.js")
      };
    }
  }

  console.log("[release:smoke] Verifying `deepvibe --help`...");
  const helpResult = runInstalledCommand(
    installedCommand,
    ["--help"],
    { cwd: installPrefix }
  );

  if (!helpResult.stdout.includes("Usage:") || !helpResult.stdout.includes("undo")) {
    throw new Error("`deepvibe --help` output did not contain the expected help text.");
  }

  console.log("[release:smoke] Verifying `deepvibe serve --help`...");
  const serveHelpResult = runInstalledCommand(
    installedCommand,
    ["serve", "--help"],
    { cwd: installPrefix }
  );

  if (!serveHelpResult.stdout.includes("--port") || !serveHelpResult.stdout.includes("--host")) {
    throw new Error("`deepvibe serve --help` output did not contain the expected serve help text.");
  }

  console.log("[release:smoke] Smoke test passed.");
} finally {
  if (typeof tarballPath === "string" && existsSync(tarballPath)) {
    unlinkSync(tarballPath);
  }

  if (typeof tempRoot === "string" && existsSync(tempRoot)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runNpm(args, options) {
  if (!existsSync(npmCliPath)) {
    throw new Error(`npm CLI entry was not found: ${npmCliPath}`);
  }

  const result = spawnSync(process.execPath, [npmCliPath, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    ...options
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stdout = result.stdout?.trim();
    const stderr = result.stderr?.trim();
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`npm ${args.join(" ")} failed with exit code ${result.status}.${details ? `\n${details}` : ""}`);
  }

  return result;
}

function runNode(args, options) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    ...options
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stdout = result.stdout?.trim();
    const stderr = result.stderr?.trim();
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`node ${args.join(" ")} failed with exit code ${result.status}.${details ? `\n${details}` : ""}`);
  }

  return result;
}

async function resolveInstalledCommand(installPrefix, packageRoot, packageName, binEntry) {
  const directTarget = path.resolve(packageRoot, binEntry);
  const shimTarget = process.platform === "win32"
    ? path.join(installPrefix, "node_modules", ".bin", "deepvibe.cmd")
    : path.join(installPrefix, "node_modules", ".bin", "deepvibe");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(directTarget)) {
      return {
        kind: "node",
        target: directTarget
      };
    }

    if (existsSync(shimTarget)) {
      return {
        kind: "shim",
        target: shimTarget
      };
    }

    const fallbackTarget =
      findInstalledEntrypoint(installPrefix, packageName, normalizeForSearch(binEntry)) ??
      findFileRecursively(packageRoot, path.basename(binEntry));

    if (fallbackTarget) {
      return {
        kind: "node",
        target: fallbackTarget
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Installed deepvibe entrypoint was not found: ${directTarget}`);
}

function runInstalledCommand(command, args, options) {
  if (command.kind === "node") {
    return runNode([command.target, ...args], options);
  }

  const result = spawnSync(command.target, args, {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    shell: process.platform === "win32",
    ...options
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stdout = result.stdout?.trim();
    const stderr = result.stderr?.trim();
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`${command.target} ${args.join(" ")} failed with exit code ${result.status}.${details ? `\n${details}` : ""}`);
  }

  return result;
}

function extractPackedCommand(tarballPath, tempRoot, binEntry) {
  const extractDir = path.join(tempRoot, "extract");
  mkdirSync(extractDir, { recursive: true });
  runProcess("tar", ["-xf", tarballPath, "-C", extractDir], { cwd: tempRoot });

  const extractedRoot = path.join(extractDir, "package");
  const extractedTarget = path.resolve(extractedRoot, binEntry);

  if (existsSync(extractedTarget)) {
    return {
      kind: "node",
      target: extractedTarget
    };
  }

  const fallbackTarget = findFileRecursively(extractedRoot, path.basename(binEntry));

  if (fallbackTarget) {
    return {
      kind: "node",
      target: fallbackTarget
    };
  }

  throw new Error(`Packed deepvibe entrypoint was not found after extraction: ${extractedTarget}`);
}

function findFileRecursively(rootDir, fileName) {
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();

    if (!currentDir) {
      continue;
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
    }
  }

  return null;
}

function findInstalledEntrypoint(searchRoot, packageName, normalizedBinEntry) {
  const stack = [searchRoot];
  const normalizedNeedle = normalizeForSearch(path.join(packageName, normalizedBinEntry));

  while (stack.length > 0) {
    const currentDir = stack.pop();

    if (!currentDir || !existsSync(currentDir)) {
      continue;
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const normalizedPath = normalizeForSearch(fullPath);

      if (normalizedPath.endsWith(normalizedNeedle)) {
        return fullPath;
      }
    }
  }

  return null;
}

function normalizeForSearch(filePath) {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function runProcess(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    ...options
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stdout = result.stdout?.trim();
    const stderr = result.stderr?.trim();
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.${details ? `\n${details}` : ""}`);
  }

  return result;
}
