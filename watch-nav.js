#!/usr/bin/env node
/**
 * Watch a website for changes; alert and open browser when diff detected.
 * Uses Playwright (headless browser) to capture JS-rendered content.
 * ~Nas (probably): "I never sleep, cause sleep is the cousin of fetch"
 */

import { chromium } from "playwright";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface, emitKeypressEvents } from "readline";
import { execSync } from "child_process";

// -----------------------------------------------------------------------------
// Config and defaults (stored in project dir, next to this script)
// -----------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, ".watch");
const CONFIG_FILE = resolve(CONFIG_DIR, "config");

// Sentinel: user pressed Shift+Enter to accept defaults for remaining prompts
const USE_ALL_DEFAULTS = Symbol("USE_ALL_DEFAULTS");

// Default values for config (interval 60 seconds = 1 min)
const DEFAULTS = {
  interval: 60,
  waitMs: 0,
  timeout: 30000,
  headless: true,
};

// -----------------------------------------------------------------------------
// Load config from file (key=value per line)
// -----------------------------------------------------------------------------
function loadConfig() {
  const config = {
    url: "",
    selector: "",
    script: "",
    eval: "",
    interval: String(DEFAULTS.interval),
    waitMs: String(DEFAULTS.waitMs),
    timeout: String(DEFAULTS.timeout),
    headless: String(DEFAULTS.headless),
  };
  if (!existsSync(CONFIG_FILE)) return config;
  const content = readFileSync(CONFIG_FILE, "utf-8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k in config) config[k] = v;
  }
  return config;
}

// -----------------------------------------------------------------------------
// Save config to file
// -----------------------------------------------------------------------------
function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const lines = [];
  const keys = ["url", "selector", "script", "eval", "interval", "waitMs", "timeout", "headless"];
  for (const k of keys) {
    if (config[k] !== undefined && config[k] !== "") lines.push(`${k}=${config[k]}`);
  }
  writeFileSync(CONFIG_FILE, lines.join("\n") + "\n");
}

// -----------------------------------------------------------------------------
// Prompt with Shift+Enter support: Shift+Enter = use default and skip remaining
// Returns USE_ALL_DEFAULTS when Shift+Enter detected
// -----------------------------------------------------------------------------
function promptWithShiftEnter(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let shiftEnter = false;

    // Enable keypress to detect Shift+Enter (only works when stdin is TTY)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      emitKeypressEvents(process.stdin);
      process.stdin.on("keypress", (str, key) => {
        if (key) {
          if (key.ctrl && key.name === "c") process.exit(130);
          if (key.shift && (key.name === "return" || key.name === "enter")) shiftEnter = true;
        }
      });
    }

    rl.question(question, (answer) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      rl.close();
      if (shiftEnter) {
        resolve(USE_ALL_DEFAULTS);
      } else {
        resolve(answer != null ? answer.trim() : "");
      }
    });
  });
}

// Simpler prompt (no Shift+Enter) for when we need a basic prompt
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer != null ? answer.trim() : "");
    });
  });
}

// -----------------------------------------------------------------------------
// Print usage and exit
// -----------------------------------------------------------------------------
function printUsage() {
  console.log(`
Usage: node watch-nav.js [URL] [CSS_SELECTOR] [options]
       node watch-nav.js [URL] --script <path> [options]
       node watch-nav.js [URL] --eval "<expression>" [options]

Options:
  --interval N     Seconds between checks (default: 60)
  --wait-ms N      Extra delay (ms) before extraction (for slow JS render)
  --timeout N      Page load timeout in ms (default: 30000)
  --headless       true|false (default: true); use false for debugging
  -h, --help       Show this help

Examples:
  node watch-nav.js https://example.com nav
  node watch-nav.js https://example.com --script ./examples/extract-menu.js
  node watch-nav.js https://example.com --eval "document.querySelector('nav').innerHTML"
  node watch-nav.js https://example.com nav --interval 60 --headless false --wait-ms 3000
`);
}

// -----------------------------------------------------------------------------
// Parse CLI args: URL, selector/script/eval, and flags
// -----------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  const opts = {
    url: "",
    selector: "",
    script: "",
    eval: "",
    interval: 0, // 0 = use config/default
    waitMs: -1, // -1 = use config/default
    timeout: -1,
    headless: null, // null = use config/default
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--interval") {
      opts.interval = parseInt(args[++i], 10) || DEFAULTS.interval;
    } else if (arg === "--wait-ms") {
      opts.waitMs = parseInt(args[++i], 10) || 0;
    } else if (arg === "--timeout") {
      opts.timeout = parseInt(args[++i], 10) || DEFAULTS.timeout;
    } else if (arg === "--headless") {
      opts.headless = args[++i].toLowerCase() !== "false";
    } else if (arg === "--script") {
      opts.script = args[++i];
    } else if (arg === "--eval") {
      opts.eval = args[++i];
    } else {
      positional.push(arg);
    }
  }

  opts.url = positional[0] || "";
  if (!opts.script && !opts.eval && positional[1]) {
    opts.selector = positional[1];
  }
  return opts;
}

// -----------------------------------------------------------------------------
// Compute state file hash (unique per URL + extraction spec)
// -----------------------------------------------------------------------------
function stateHash(url, selector, script, evalSpec) {
  let spec = url;
  if (selector) spec += `|selector:${selector}`;
  else if (script) spec += `|script:${script}`;
  else if (evalSpec) spec += `|eval:${evalSpec}`;
  return createHash("sha256").update(spec).digest("hex").slice(0, 16);
}

// -----------------------------------------------------------------------------
// Derive display host from URL for alert message
// -----------------------------------------------------------------------------
function displayHost(url) {
  let host = url.replace(/^[^:]+:\/\//, "").split("/")[0] || "";
  if (host.startsWith("www.")) host = host.slice(4);
  return host || url;
}

// -----------------------------------------------------------------------------
// Extract content from page using Playwright
// -----------------------------------------------------------------------------
async function extractWithPlaywright(opts) {
  const { url, selector, script, evalSpec, waitMs, timeout, headless } = opts;
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    // Extra delay for slow-render pages (e.g. heavy JS menus)
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }

    if (selector) {
      // Selector mode: wait for element, then extract outerHTML
      await page.waitForSelector(selector, { timeout });
      const content = await page.evaluate(
        (sel) => document.querySelector(sel)?.outerHTML ?? "",
        selector
      );
      await browser.close();
      return content;
    }

    if (script || evalSpec) {
      // Custom script/eval mode: wait for network idle, then run extraction
      await page.waitForLoadState("networkidle").catch(() => {});
      if (waitMs > 0) {
        // waitMs already applied above; if we got here without selector, waitMs might not have run
        // Actually we did run waitMs above. Good.
      }

      let content;
      if (script) {
        // Load script from file; it must be a function that returns the content
        const scriptPath = resolve(process.cwd(), script);
        const scriptContent = readFileSync(scriptPath, "utf-8");
        // Script can be: () => {...} or function() {...} — we wrap and eval
        const fn = new Function(`return (${scriptContent})`)();
        content = await page.evaluate(fn);
      } else {
        // Inline eval: string of JS that returns content
        const fn = new Function(`return (${evalSpec})`);
        content = await page.evaluate(fn);
      }

      await browser.close();
      return typeof content === "string" ? content : JSON.stringify(content ?? "");
    }

    await browser.close();
    return "";
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Sleep helper
// -----------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// Open URL in default browser (macOS; use arg array to avoid shell escaping)
// -----------------------------------------------------------------------------
function openBrowser(url) {
  execSync("open", [url], { stdio: "inherit" });
}

// -----------------------------------------------------------------------------
// Show macOS system alert (escape host for AppleScript string safety)
// -----------------------------------------------------------------------------
function showAlert(host) {
  const safe = String(host).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const msg = `display alert "Website Changed" message "${safe} has been updated."`;
  execSync("osascript", ["-e", msg], { stdio: "inherit" });
}

// -----------------------------------------------------------------------------
// Build the full command-line string for echo (so user can copy for next run)
// -----------------------------------------------------------------------------
function buildCommandLine(opts) {
  const argv = ["node", "watch-nav.js"];
  if (opts.url) argv.push(opts.url);
  if (opts.selector && !opts.script && !opts.eval) argv.push(opts.selector);
  if (opts.script) argv.push("--script", opts.script);
  if (opts.eval) argv.push("--eval", opts.eval);
  argv.push("--interval", String(opts.interval || DEFAULTS.interval));
  argv.push("--wait-ms", String(opts.waitMs ?? DEFAULTS.waitMs));
  argv.push("--timeout", String(opts.timeout || DEFAULTS.timeout));
  argv.push("--headless", opts.headless === false ? "false" : "true");
  // Simple shell-escaping for args that might need it
  return argv
    .map((a) => (/\s|["'$]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main() {
  const config = loadConfig();
  let opts = parseArgs();

  // Pre-fill script/eval from config when not provided via CLI
  // (avoids prompting for selector when using script/eval mode)
  if (!opts.selector && !opts.script && !opts.eval) {
    if (config.script) opts.script = config.script;
    else if (config.eval) opts.eval = config.eval;
    // Don't pre-fill selector — we always prompt for it with config.selector as default
  }

  // Track whether we need to prompt (any option missing from CLI)
  const needsPrompts =
    !opts.url ||
    (!opts.selector && !opts.script && !opts.eval) ||
    opts.interval === 0 ||
    opts.waitMs === -1 ||
    opts.timeout === -1 ||
    opts.headless === null;

  let useAllDefaults = false;

  if (needsPrompts) {
    // Prompt for each missing value; Shift+Enter = use defaults for rest
    const prompts = [
      {
        key: "url",
        question: `URL [${config.url || "(required)"}]: `,
        default: config.url,
        needed: () => !opts.url,
      },
      {
        key: "selector",
        question: `CSS selector (or leave empty to use --script/--eval from config) [${config.selector || "nav"}]: `,
        default: config.selector || "nav",
        needed: () => !opts.selector && !opts.script && !opts.eval,
      },
      {
        key: "interval",
        question: `Interval between checks (seconds) [${config.interval || DEFAULTS.interval}]: `,
        default: config.interval || String(DEFAULTS.interval),
        needed: () => opts.interval === 0,
      },
      {
        key: "waitMs",
        question: `Extra wait before extraction (ms, 0=none) [${config.waitMs ?? DEFAULTS.waitMs}]: `,
        default: config.waitMs ?? String(DEFAULTS.waitMs),
        needed: () => opts.waitMs === -1,
      },
      {
        key: "timeout",
        question: `Page load timeout (ms) [${config.timeout || DEFAULTS.timeout}]: `,
        default: config.timeout || String(DEFAULTS.timeout),
        needed: () => opts.timeout === -1,
      },
      {
        key: "headless",
        question: `Headless browser? (y/n) [${config.headless === "false" ? "n" : "y"}]: `,
        default: config.headless !== "false",
        needed: () => opts.headless === null,
      },
    ];

    for (const p of prompts) {
      if (!p.needed()) continue;
      if (useAllDefaults) {
        if (p.key === "selector") opts.selector = opts.script || opts.eval ? "" : p.default;
        else if (p.key === "headless") opts.headless = p.default === true || p.default === "y";
        else opts[p.key] = ["interval", "waitMs", "timeout"].includes(p.key) ? (parseInt(p.default, 10) || DEFAULTS[p.key]) : p.default;
        continue;
      }
      const answer = await promptWithShiftEnter(p.question);
      if (answer === USE_ALL_DEFAULTS) {
        useAllDefaults = true;
        if (p.key === "selector") opts.selector = opts.script || opts.eval ? "" : p.default;
        else if (p.key === "headless") opts.headless = p.default === true || p.default === "y";
        else opts[p.key] = ["interval", "waitMs", "timeout"].includes(p.key) ? (parseInt(p.default, 10) || DEFAULTS[p.key]) : p.default;
      } else {
        if (answer !== "") {
          if (p.key === "headless") opts.headless = !/^n|false$/i.test(answer);
          else if (["interval", "waitMs", "timeout"].includes(p.key)) opts[p.key] = parseInt(answer, 10) || DEFAULTS[p.key];
          else opts[p.key] = answer;
        } else {
          if (p.key === "selector" && (opts.script || opts.eval)) opts.selector = "";
          else if (p.key === "headless") opts.headless = p.default === true || p.default === "y";
          else opts[p.key] = ["interval", "waitMs", "timeout"].includes(p.key) ? (parseInt(p.default, 10) || DEFAULTS[p.key]) : p.default;
        }
      }
    }
  }

  // Resolve from config for any still-unset CLI args
  if (opts.interval === 0) opts.interval = parseInt(config.interval || String(DEFAULTS.interval), 10) || DEFAULTS.interval;
  if (opts.waitMs === -1) opts.waitMs = parseInt(config.waitMs ?? String(DEFAULTS.waitMs), 10) || 0;
  if (opts.timeout === -1) opts.timeout = parseInt(config.timeout || String(DEFAULTS.timeout), 10) || DEFAULTS.timeout;
  if (opts.headless === null) opts.headless = config.headless !== "false";

  // Final fallback: if still no extraction mode, use selector from config
  if (!opts.selector && !opts.script && !opts.eval) {
    opts.selector = config.selector || "nav";
  }

  // Validate
  if (!opts.url) {
    console.error("Error: URL is required.");
    process.exit(1);
  }
  if (!opts.selector && !opts.script && !opts.eval) {
    console.error("Error: CSS selector, --script, or --eval is required.");
    process.exit(1);
  }

  // Save config for next run
  saveConfig({
    url: opts.url,
    selector: opts.selector,
    script: opts.script,
    eval: opts.eval,
    interval: String(opts.interval),
    waitMs: String(opts.waitMs),
    timeout: String(opts.timeout),
    headless: String(opts.headless),
  });

  // Echo full command so user can copy for next run (skip prompts)
  const cmdLine = buildCommandLine(opts);
  console.log(`# Run again without prompts:\n${cmdLine}\n`);

  const hash = stateHash(opts.url, opts.selector, opts.script, opts.eval);
  const STATE_FILE = `${CONFIG_DIR}/state-${hash}.html`;
  mkdirSync(CONFIG_DIR, { recursive: true });

  const display_host = displayHost(opts.url);
  const intervalMs = opts.interval * 1000;
  let check_num = 0;

  // Main loop: fetch, extract, diff, log, repeat until change detected
  while (true) {
    check_num++;

    let content;
    try {
      content = await extractWithPlaywright(opts);
    } catch (err) {
      console.error(
        `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] Check #${check_num}: fetch/extract failed - ${err.message}`
      );
      await sleep(intervalMs);
      continue;
    }

    const prevExists = existsSync(STATE_FILE);

    if (!prevExists) {
      writeFileSync(STATE_FILE, content);
      console.log(
        `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] Check #${check_num}: baseline saved`
      );
    } else {
      const prev = readFileSync(STATE_FILE, "utf-8");
      if (prev !== content) {
        writeFileSync(STATE_FILE, content);
        console.log(
          `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] Check #${check_num}: CHANGE DETECTED`
        );
        break;
      }
      console.log(
        `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] Check #${check_num}: no change`
      );
    }

    await sleep(intervalMs);
  }

  openBrowser(opts.url);
  showAlert(display_host);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
