/**
 * A link on a page. Both fields are escaped by `renderPage`, so pass them
 * raw. `href` must be an http(s) URL or a path on this host; a link with
 * any other href is left off the page.
 */
export interface PageLink {
  href: string;
  label: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escaping makes an href a safe attribute value, not a safe destination:
// `javascript:` and the like are refused here by scheme. A path must start
// with a single slash, so `//host` cannot leave this host either.
function isSafeHref(href: string): boolean {
  // Browsers drop ASCII control characters when following a link, so
  // "/\t/evil.example" would collapse into scheme-relative "//evil.example".
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(href)) {
    return false;
  }
  if (/^\/(?![/\\])/.test(href)) {
    return true;
  }
  try {
    const { protocol } = new URL(href);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

// A small static page for the browser steps of sign-in: no script, and every
// value escaped. Exported for unit testing.
export function renderPage(page: { title: string; paragraphs: string[]; links?: PageLink[] }): string {
  const paragraphs = page.paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('\n');
  const links = (page.links ?? [])
    .filter(l => isSafeHref(l.href))
    .map(l => `<p><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></p>`)
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(page.title)}</title>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(page.title)}</h1>`,
    paragraphs,
    links,
    '</body>',
    '</html>',
  ]
    .filter(Boolean)
    .join('\n');
}
