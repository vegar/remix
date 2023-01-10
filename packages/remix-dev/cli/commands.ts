import * as path from "path";
import { execSync } from "child_process";
import * as fse from "fs-extra";
import ora from "ora";
import prettyMs from "pretty-ms";
import * as esbuild from "esbuild";
import NPMCliPackageJson from "@npmcli/package-json";

import * as colors from "../colors";
import * as compiler from "../compiler";
import * as devServer from "../devServer";
import type { RemixConfig } from "../config";
import { readConfig } from "../config";
import { formatRoutes, RoutesFormat, isRoutesFormat } from "../config/format";
import { log } from "../logging";
import { createApp } from "./create";
import { getPreferredPackageManager } from "./getPreferredPackageManager";
import { setupRemix, isSetupPlatform, SetupPlatform } from "./setup";
import runCodemod from "../codemod";
import { CodemodError } from "../codemod/utils/error";
import { TaskError } from "../codemod/utils/task";
import { convertTSFileToJS } from "./migrate/migrations/convert-to-javascript/convertTSFilesToJS/convertTSFileToJS";

export async function create({
  appTemplate,
  projectDir,
  remixVersion,
  installDeps,
  useTypeScript,
  githubToken,
  debug,
}: {
  appTemplate: string;
  projectDir: string;
  remixVersion?: string;
  installDeps: boolean;
  useTypeScript: boolean;
  githubToken?: string;
  debug?: boolean;
}) {
  let spinner = ora("Creating your app…").start();
  await createApp({
    appTemplate,
    projectDir,
    remixVersion,
    installDeps,
    useTypeScript,
    githubToken,
    debug,
  });
  spinner.stop();
  spinner.clear();
}

type InitFlags = {
  deleteScript?: boolean;
};

export async function init(
  projectDir: string,
  { deleteScript = true }: InitFlags = {}
) {
  let initScriptDir = path.join(projectDir, "remix.init");
  let initScriptTs = path.resolve(initScriptDir, "index.ts");
  let initScript = path.resolve(initScriptDir, "index.js");

  if (await fse.pathExists(initScriptTs)) {
    await esbuild.build({
      entryPoints: [initScriptTs],
      format: "cjs",
      platform: "node",
      outfile: initScript,
    });
  }
  if (!(await fse.pathExists(initScript))) {
    return;
  }

  let initPackageJson = path.resolve(initScriptDir, "package.json");
  let isTypeScript = fse.existsSync(path.join(projectDir, "tsconfig.json"));
  let packageManager = getPreferredPackageManager();

  if (await fse.pathExists(initPackageJson)) {
    execSync(`${packageManager} install`, {
      cwd: initScriptDir,
      stdio: "ignore",
    });
  }

  let initFn = require(initScript);
  if (typeof initFn !== "function" && initFn.default) {
    initFn = initFn.default;
  }
  try {
    await initFn({ isTypeScript, packageManager, rootDirectory: projectDir });

    if (deleteScript) {
      await fse.remove(initScriptDir);
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      error.message = `${colors.error("🚨 Oops, remix.init failed")}\n\n${
        error.message
      }`;
    }
    throw error;
  }
}

export async function setup(platformArg?: string) {
  let platform: SetupPlatform;
  if (
    platformArg === "cloudflare-workers" ||
    platformArg === "cloudflare-pages"
  ) {
    console.warn(
      `Using '${platformArg}' as a platform value is deprecated. Use ` +
        "'cloudflare' instead."
    );
    console.log("HINT: check the `postinstall` script in `package.json`");
    platform = SetupPlatform.Cloudflare;
  } else {
    platform = isSetupPlatform(platformArg) ? platformArg : SetupPlatform.Node;
  }

  await setupRemix(platform);

  log(`Successfully setup Remix for ${platform}.`);
}

export async function routes(
  remixRoot?: string,
  formatArg?: string
): Promise<void> {
  let config = await readConfig(remixRoot);

  let format = isRoutesFormat(formatArg) ? formatArg : RoutesFormat.jsx;

  console.log(formatRoutes(config.routes, format));
}

export async function build(
  remixRoot: string,
  modeArg?: string,
  sourcemap: boolean = false
): Promise<void> {
  let mode = compiler.parseMode(modeArg ?? "", "production");

  log(`Building Remix app in ${mode} mode...`);

  if (modeArg === "production" && sourcemap) {
    console.warn(
      "\n⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️"
    );
    console.warn(
      "You have enabled source maps in production. This will make your " +
        "server-side code visible to the public and is highly discouraged! If " +
        "you insist, please ensure you are using environment variables for " +
        "secrets and not hard-coding them into your source!"
    );
    console.warn(
      "⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️\n"
    );
  }

  let start = Date.now();
  let config = await readConfig(remixRoot);
  fse.emptyDirSync(config.assetsBuildDirectory);
  await compiler.build(config, {
    mode,
    sourcemap,
    onCompileFailure: (failure) => {
      compiler.logCompileFailure(failure);
      throw Error();
    },
  });

  log(`Built in ${prettyMs(Date.now() - start)}`);
}

export async function watch(
  remixRootOrConfig: string | RemixConfig,
  modeArg?: string
): Promise<void> {
  let mode = compiler.parseMode(modeArg ?? "", "development");
  console.log(`Watching Remix app in ${mode} mode...`);

  let config =
    typeof remixRootOrConfig === "object"
      ? remixRootOrConfig
      : await readConfig(remixRootOrConfig);

  return devServer.liveReload(config, {
    mode,
    onInitialBuild: (durationMs) =>
      console.log(`💿 Built in ${prettyMs(durationMs)}`),
  });
}

export async function dev(remixRoot: string, modeArg?: string, port?: number) {
  let config = await readConfig(remixRoot);
  let mode = compiler.parseMode(modeArg ?? "", "development");
  return devServer.serve(config, mode, port);
}

export async function codemod(
  codemodName?: string,
  projectDir?: string,
  { dry = false, force = false } = {}
) {
  if (!codemodName) {
    console.error(colors.red("Error: Missing codemod name"));
    console.log(
      "Usage: " +
        colors.gray(
          `remix codemod <${colors.arg("codemod")}> [${colors.arg(
            "projectDir"
          )}]`
        )
    );
    process.exit(1);
  }
  try {
    await runCodemod(projectDir ?? process.cwd(), codemodName, {
      dry,
      force,
    });
  } catch (error: unknown) {
    if (error instanceof CodemodError) {
      console.error(`${colors.red("Error:")} ${error.message}`);
      if (error.additionalInfo) console.info(colors.gray(error.additionalInfo));
      process.exit(1);
    }
    if (error instanceof TaskError) {
      process.exit(1);
    }
    throw error;
  }
}

let clientEntries = ["entry.client.tsx", "entry.client.js", "entry.client.jsx"];
let serverEntries = ["entry.server.tsx", "entry.server.js", "entry.server.jsx"];
let entries = [...clientEntries, ...serverEntries];

export async function generateEntry(remixRoot: string, entry: string) {
  if (!entries.includes(entry)) {
    // @ts-expect-error available in node 12+
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/ListFormat#browser_compatibility
    let listFormat = new Intl.ListFormat("en", {
      style: "long",
      type: "conjunction",
    });

    let entriesArray = Array.from(entries);
    let list = listFormat.format(entriesArray);

    console.log(
      colors.error(`Invalid entry file. Valid entry files are ${list}`)
    );
    return process.exit(1);
  }

  let pkgJson = await NPMCliPackageJson.load(remixRoot);
  let deps = pkgJson.content.dependencies ?? {};

  let runtime = deps["@remix-run/deno"]
    ? "deno"
    : deps["@remix-run/cloudflare"]
    ? "cloudflare"
    : deps["@remix-run/node"]
    ? "node"
    : undefined;

  if (!runtime) {
    throw new Error(
      `Could not determine runtime. Please install one of the following: @remix-run/deno, @remix-run/cloudflare, @remix-run/node`
    );
  }

  let defaultsDirectory = path.resolve(__dirname, "..", "config", "defaults");
  let defaultEntryClient = path.resolve(defaultsDirectory, "entry.client.tsx");
  let defaultEntryServer = path.resolve(
    defaultsDirectory,
    `entry.server.${runtime}.tsx`
  );

  let isServerEntry = entry.startsWith("entry.server.");

  let contents = isServerEntry
    ? await createServerEntry(remixRoot, defaultEntryServer)
    : await createClientEntry(remixRoot, defaultEntryClient);

  let inputFile = isServerEntry ? defaultEntryServer : defaultEntryClient;
  let outputFile = path.resolve(remixRoot, "app", entry);

  // 3. if entry is js/jsx, convert to js
  // otherwise, copy the entry file from the defaults
  if (/\.jsx?$/.test(entry)) {
    let javascript = convertTSFileToJS({
      filename: inputFile,
      projectDir: remixRoot,
      source: contents,
    });
    await fse.writeFile(outputFile, javascript, "utf-8");
  } else {
    await fse.writeFile(outputFile, contents, "utf-8");
  }

  console.log(
    colors.blue(
      `Entry file ${entry} created at ${path.relative(remixRoot, outputFile)}.`
    )
  );

  return process.exit(0);
}

async function checkForEntry(remixRoot: string, entries: string[]) {
  for (let entryToCheck of entries) {
    let entryPath = path.resolve(remixRoot, "app", entryToCheck);
    let entryExists = await fse.pathExists(entryPath);
    if (entryExists) {
      console.log(
        colors.red(
          `Entry file ${path.relative(remixRoot, entryToCheck)} already exists.`
        )
      );
      return process.exit(1);
    }
  }
}

async function createServerEntry(remixRoot: string, inputFile: string) {
  await checkForEntry(remixRoot, serverEntries);
  let contents = await fse.readFile(inputFile, "utf-8");
  return contents;
}

async function createClientEntry(remixRoot: string, inputFile: string) {
  await checkForEntry(remixRoot, clientEntries);
  let contents = await fse.readFile(inputFile, "utf-8");
  return contents;
}
