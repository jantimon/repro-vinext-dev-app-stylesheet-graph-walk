// Starts a fresh vinext dev server per run, requests `/`, and times the load of
// `virtual:vinext-pages-client-assets`, which walks the import graph of `_app` and every page
// Usage: node scripts/measure.mjs [--runs 7] [--sizes 500,2000,5000] [--profile]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS_ID = "\0virtual:vinext-pages-client-assets";

if (process.env.REPRO_CHILD) await child();
else parent();

function parent() {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  const runs = Number(arg("runs", 7));
  const sizes = arg("sizes", "500,2000,5000").split(",").map(Number);
  const profile = process.argv.includes("--profile");
  const results = [];

  for (const size of sizes) {
    spawnSync("node", ["scripts/generate.mjs", String(size)], { cwd: root, stdio: "inherit" });
    // warm-up run fills node_modules/.vite so dependency optimization is not measured
    runChild("vinext", false);
    if (profile) {
      const { profileSummary } = runChild("vinext", true);
      console.log(`${size} modules, CPU profile of the first request (sync time under collectModuleDependencies):`);
      for (const [name, ms] of Object.entries(profileSummary)) console.log(`  ${name}: ${ms} ms`);
    }
    for (const mode of ["vinext", "skip-walk"]) {
      const samples = [];
      for (let run = 0; run < runs; run++) samples.push(runChild(mode, false));
      results.push({ size, mode, samples });
      const m = (key) => median(samples.map((s) => s[key]));
      console.log(
        `${size} modules, ${mode}: first HTML ${m("firstHtmlMs")} ms, walk ${m("walkMs")} ms` +
          ` (${m("walkReads")} files read, readFileSync ${m("walkReadMs")} ms), walk after edit ${m("walkAfterEditMs")} ms,` +
          ` ${samples[0].stylesheetLinks} stylesheet links`,
      );
    }
    const links = results.filter((r) => r.size === size).map((r) => r.samples[0].stylesheetHrefs.join("\n"));
    console.log(`  same stylesheet links in the same order with and without the walk: ${links[0] === links[1]}`);
  }

  fs.mkdirSync(path.join(root, "results"), { recursive: true });
  for (const result of results) for (const sample of result.samples) delete sample.stylesheetHrefs;
  fs.writeFileSync(path.join(root, "results/measure.json"), JSON.stringify(results, null, 2));
  console.log("\nwrote results/measure.json");
}

function runChild(mode, profile) {
  const { stdout, status, stderr } = spawnSync("node", ["scripts/measure.mjs"], {
    cwd: root,
    env: { ...process.env, REPRO_CHILD: "1", REPRO_MODE: mode, REPRO_PROFILE: profile ? "1" : "" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (status !== 0) throw new Error(stderr);
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

function median(values) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

async function child() {
  const { createServer } = await import("vite");
  const { default: vinext } = await import("vinext");
  const mode = process.env.REPRO_MODE;

  const walks = [];
  let walk = null;
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function (...args) {
    if (!walk || process.env.REPRO_PROFILE) return readFileSync.apply(this, args);
    const start = performance.now();
    const result = readFileSync.apply(this, args);
    const duration = performance.now() - start;
    if (new Error().stack.includes("collectModuleDependencies")) {
      walk.reads++;
      walk.readMs += duration;
    }
    return result;
  };

  const plugins = (await vinext()).flat(Infinity).filter(Boolean);
  const configPlugin = plugins.find((plugin) => plugin.name === "vinext:config");
  const load = configPlugin.load.handler;
  configPlugin.load.handler = async function (id, ...rest) {
    if (id !== ASSETS_ID) return load.call(this, id, ...rest);
    if (mode === "skip-walk") {
      return `export default ${JSON.stringify({ clientEntry: "/@id/__x00__virtual:vinext-client-entry", crossOrigin: "" })};`;
    }
    walk = { environment: this.environment?.name, reads: 0, readMs: 0 };
    const start = performance.now();
    try {
      return await load.call(this, id, ...rest);
    } finally {
      walk.ms = performance.now() - start;
      walks.push(walk);
      walk = null;
    }
  };

  const session = process.env.REPRO_PROFILE ? await startProfile() : null;

  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins,
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

  let start = performance.now();
  const html = await (await fetch(url)).text();
  const firstHtmlMs = performance.now() - start;
  const firstWalks = walks.length;

  const profileSummary = session ? await stopProfile(session) : null;

  start = performance.now();
  await (await fetch(url)).text();
  const secondHtmlMs = performance.now() - start;

  const leaf = path.join(root, "components/m1.jsx");
  const source = readFileSync(leaf, "utf8");
  fs.writeFileSync(leaf, `${source}\n`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await (await fetch(url)).text();
  fs.writeFileSync(leaf, source);

  await server.close();

  const stylesheetHrefs = [...html.matchAll(/<link rel="stylesheet"[^>]* href="([^"]+)"/g)].map((match) => match[1]);
  const first = walks.slice(0, firstWalks);
  const sum = (list, key) => list.reduce((total, w) => total + w[key], 0);
  console.log(
    JSON.stringify({
      mode,
      firstHtmlMs,
      secondHtmlMs,
      walkCount: first.length,
      walkEnvironments: first.map((w) => w.environment),
      walkMs: mode === "skip-walk" ? null : sum(first, "ms"),
      walkReads: mode === "skip-walk" ? null : sum(first, "reads"),
      walkReadMs: mode === "skip-walk" ? null : sum(first, "readMs"),
      walkAfterEditMs: mode === "skip-walk" ? null : sum(walks.slice(firstWalks), "ms"),
      stylesheetLinks: stylesheetHrefs.length,
      profileSummary,
      stylesheetHrefs,
    }),
  );
}

async function startProfile() {
  const { Session } = await import("node:inspector/promises");
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 100 });
  await session.post("Profiler.start");
  return session;
}

async function stopProfile(session) {
  const { profile } = await session.post("Profiler.stop");
  fs.mkdirSync(path.join(root, "profiles"), { recursive: true });
  const size = fs.readdirSync(path.join(root, "components")).filter((file) => file.endsWith(".jsx")).length;
  fs.writeFileSync(path.join(root, `profiles/first-request-${size}.cpuprofile`), JSON.stringify(profile));
  session.disconnect();
  return summarizeProfile(profile, "collectModuleDependencies");
}

function summarizeProfile(profile, functionName) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const isUnder = (id) => {
    for (let current = id; current !== undefined; current = parents.get(current)) {
      if (nodes.get(current).callFrame.functionName === functionName) return true;
    }
    return false;
  };
  const group = (name) => {
    if (name === "readFileUtf8" || name === "fs.readFileSync") return "readFileSync";
    if (name === "jsonParseAst" || name === "parseAst") return "parseAst";
    return "resolve and other";
  };
  const summary = { total: 0, readFileSync: 0, parseAst: 0, "resolve and other": 0 };
  profile.samples.forEach((id, index) => {
    if (!isUnder(id)) return;
    const ms = (profile.timeDeltas[index + 1] ?? 0) / 1000;
    summary.total += ms;
    summary[group(nodes.get(id).callFrame.functionName)] += ms;
  });
  return Object.fromEntries(Object.entries(summary).map(([name, ms]) => [name, Math.round(ms)]));
}
