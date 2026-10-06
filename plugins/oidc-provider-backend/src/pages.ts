/** A link on a page: `href` is used as is, `label` is escaped. */
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

// A small static page for the browser steps of sign-in: no script, and every
// value escaped. Exported for unit testing.
export function renderPage(page: { title: string; paragraphs: string[]; links?: PageLink[] }): string {
  const paragraphs = page.paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('\n');
  const links = (page.links ?? [])
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
