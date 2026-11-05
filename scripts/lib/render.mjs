// The single renderer: now.json -> now.md. Heading-free list, one bullet per
// item, absolute date, title as the link. No emojis, no relative times.
//
// Empty is valid and renders exactly one line, never an empty heading.

export const NOW_START = '<!-- now starts -->';
export const NOW_END = '<!-- now ends -->';
export const EMPTY_LINE = '_Nothing in flight._';

function escapeTitle(title) {
  return String(title)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .trim();
}

export function renderMarkdown(snapshot) {
  const lines = [NOW_START];
  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    lines.push(EMPTY_LINE);
  } else {
    for (const item of snapshot.items) {
      lines.push(`- ${item.date} · [${escapeTitle(item.title)}](${item.url})`);
    }
  }
  lines.push(NOW_END);
  return `${lines.join('\n')}\n`;
}
