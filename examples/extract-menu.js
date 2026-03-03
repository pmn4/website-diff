/**
 * Example custom extractor for watch-nav.js --script
 * Runs in the browser context; document and DOM are available.
 * Returns the HTML of the target element(s) to diff.
 *
 * Customize the selector or logic for your site's JS-rendered menu.
 * ~Nas (probably): "One love, one mic, one page to rule the content"
 */
() => {
  // Try common menu/nav patterns; adjust for your site
  const menu =
    document.querySelector('nav[aria-label="Main menu"]') ||
    document.querySelector("nav.main") ||
    document.querySelector("nav") ||
    document.querySelector('[role="navigation"]') ||
    document.querySelector(".nav") ||
    document.querySelector("#nav");
  return menu ? menu.outerHTML : "";
}
