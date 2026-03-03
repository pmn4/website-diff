# website-diff

Watch a website for changes; get alerted (and have the browser opened) when a diff is detected.

Uses [Playwright](https://playwright.dev/) to capture JS-rendered content—so it works with single-page apps, lazy-loaded menus, and other dynamic pages that `curl` + `htmlq` would miss.

## How it works

1. **Fetch** the page in a headless Chromium browser
2. **Extract** content via CSS selector, custom script, or inline `eval`
3. **Compare** with the previous run’s snapshot for that URL + extraction spec
4. **Loop** every N seconds until a change is detected
5. **Alert** by opening the URL in your default browser and showing a macOS system notification

## Requirements

- **Node.js** (v18+)
- **macOS** (uses `open` and `osascript` for alerts; Linux/Windows users would need to adjust the alert/browser commands)

## Installation

```bash
npm install
npx playwright install chromium
```

## Usage

### Basic

```bash
# Watch a page’s <nav> for changes; prompts for URL if omitted
node watch-nav.js https://example.com nav

# Or use the bash wrapper (same CLI)
./watch-nav.sh https://example.com nav
```

### Extraction modes

| Mode      | Example |
|-----------|---------|
| CSS selector | `node watch-nav.js https://example.com nav` |
| Custom script | `node watch-nav.js https://example.com --script ./examples/extract-menu.js` |
| Inline eval   | `node watch-nav.js https://example.com --eval "document.querySelector('nav').innerHTML"` |

### Options

| Option       | Description |
|--------------|-------------|
| `--interval N` | Seconds between checks (default: 60) |
| `--wait-ms N`  | Extra delay (ms) before extraction for slow-render pages |
| `--timeout N`  | Page load timeout in ms (default: 30000) |
| `--headless true\|false` | Run browser headlessly (default: true) |
| `-h`, `--help` | Show usage |

### Examples

```bash
# Watch every 30 seconds
node watch-nav.js https://example.com nav --interval 30

# Debug with visible browser and extra wait for heavy JS
node watch-nav.js https://example.com nav --headless false --wait-ms 3000

# Use a custom extractor for complex nav patterns
node watch-nav.js https://example.com --script ./examples/extract-menu.js
```

## Config & state

Stored in `.watch/` (project directory):

- **`config`** — Last-used URL, selector/script/eval, interval, etc. (used as defaults for next run)
- **`state-<hash>.html`** — Snapshot of the extracted content per URL + extraction spec

## Custom extractors

With `--script`, provide a file that exports a function. The function runs in the browser context; `document` and the DOM are available. It must return the HTML string to diff:

```javascript
// examples/extract-menu.js
() => {
  const menu =
    document.querySelector('nav[aria-label="Main menu"]') ||
    document.querySelector("nav") ||
    document.querySelector('[role="navigation"]');
  return menu ? menu.outerHTML : "";
}
```

## License

MIT
