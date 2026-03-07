const repoRoot = new URL("../", import.meta.url);
const rootConfig = new URL("../deno.json", import.meta.url);
const rootConfigPath = fileUrlToPath(rootConfig);

type CommandSpec = {
  cmd: string;
  args: string[];
  cwd: string;
};

function logStep(message: string) {
  console.log(`==> ${message}`);
}

async function runCommand({ cmd, args, cwd }: CommandSpec) {
  const command = new Deno.Command(cmd, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await command.output();
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd} ${args.join(" ")}`);
  }
}

async function commandExists(cmd: string, args: string[] = ["--version"]) {
  try {
    const result = await new Deno.Command(cmd, {
      args,
      stdout: "null",
      stderr: "null",
    }).output();
    return result.code === 0;
  } catch {
    return false;
  }
}

function fileUrlToPath(url: URL) {
  const decoded = decodeURIComponent(url.pathname);
  if (Deno.build.os === "windows") {
    return decoded.replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\");
  }
  return decoded;
}

async function getPnpmLauncher() {
  if (await commandExists("pnpm")) {
    return { cmd: "pnpm", baseArgs: [] };
  }
  if (await commandExists("corepack")) {
    return { cmd: "corepack", baseArgs: ["pnpm"] };
  }
  if (await commandExists("npx")) {
    return { cmd: "npx", baseArgs: ["pnpm"] };
  }
  throw new Error("Could not find pnpm, corepack, or npx on PATH");
}

async function pnpm(workspaceDir: URL, args: string[]) {
  const launcher = await getPnpmLauncher();
  await runCommand({
    cmd: launcher.cmd,
    args: [...launcher.baseArgs, ...args],
    cwd: fileUrlToPath(workspaceDir),
  });
}

async function buildPackage(dir: URL) {
  const packageJsonUrl = new URL("./package.json", dir);
  const packageJson = JSON.parse(await Deno.readTextFile(packageJsonUrl));
  if (packageJson?.scripts?.build == null) {
    console.log(`==> Skip ${packageJson.name ?? packageJsonUrl.pathname} (no build script)`);
    return;
  }

  logStep(`Build ${packageJson.name ?? packageJsonUrl.pathname}`);
  await runCommand({
    cmd: "npm",
    args: ["run", "build"],
    cwd: fileUrlToPath(dir),
  });
}

async function buildExplicitPackages(workspaceRoot: URL, packagePaths: string[]) {
  for (const packagePath of packagePaths) {
    await buildPackage(new URL(packagePath, workspaceRoot));
  }
}

const uikitRoot = new URL("./submodules/uikit/", repoRoot);
const uikitPackage = new URL("./packages/uikit/", uikitRoot);
const xrRoot = new URL("./submodules/xr/", repoRoot);
const uikitBuildTargets = [
  "./packages/msdfonts/",
  "./packages/pub-sub/",
  "./packages/uikit/",
  "./packages/react/",
];
const xrBuildTargets = [
  "./packages/pointer-events/",
  "./packages/xr/",
  "./packages/react/xr/",
];

logStep("Install uikit workspace dependencies");
await pnpm(uikitRoot, ["install"]);

logStep("Generate uikit flex setter");
await runCommand({
  cmd: "deno",
  args: ["run", "-A", "--config", rootConfigPath, "scripts/flex-generate-setter.ts"],
  cwd: fileUrlToPath(uikitPackage),
});

logStep("Build uikit packages");
await buildExplicitPackages(uikitRoot, uikitBuildTargets);

logStep("Install xr workspace dependencies");
await pnpm(xrRoot, ["install"]);

logStep("Build xr packages");
await buildExplicitPackages(xrRoot, xrBuildTargets);
