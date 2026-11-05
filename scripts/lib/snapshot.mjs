// Deterministic snapshot shape: total ordering, deduplication, the cut at five
// and the stable byte serialization.

export const SCHEMA_ID = 'now/v1';
export const MAX_ITEMS = 5;

// Total order required by the contract: date desc, then url asc. The title and
// source tie-breakers exist only so the order stays total even if two rows
// share date and url, which would otherwise make the output bytes ambiguous.
export function compareItems(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.url !== b.url) return a.url < b.url ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
}

export function isSortedTotal(items) {
  for (let index = 1; index < items.length; index += 1) {
    if (compareItems(items[index - 1], items[index]) > 0) return false;
  }
  return true;
}

function canonicalItem(item) {
  return {
    kind: item.kind,
    title: item.title,
    url: item.url,
    date: item.date,
    source: item.source,
  };
}

export function buildSnapshot({ items, asOf }) {
  const sorted = [...items].sort(compareItems);
  const seenUrls = new Set();
  const unique = [];
  for (const item of sorted) {
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    unique.push(item);
  }
  return {
    schema: SCHEMA_ID,
    asOf,
    items: unique.slice(0, MAX_ITEMS).map(canonicalItem),
  };
}

export function serializeSnapshot(snapshot) {
  const ordered = {
    schema: snapshot.schema,
    asOf: snapshot.asOf,
    items: snapshot.items.map(canonicalItem),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function formatAsOf(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
