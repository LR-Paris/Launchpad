// Match the slugify rules used by backend/inventory.js and Shuttle's catalog.ts.
export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Tiny markdown -> HTML for description previews. Handles the common cases
// (bold, italic, links, paragraphs, simple unordered lists). Not a real parser;
// safe because we escape angle brackets first and only emit a known tag set.
export function renderMarkdown(input) {
  if (!input) return '';
  const escaped = String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Lists: consecutive lines beginning with "- " become a <ul>
  const withLists = escaped.replace(
    /(?:^|\n)((?:- [^\n]+(?:\n|$))+)/g,
    (match, block) => {
      const items = block
        .split('\n')
        .filter(Boolean)
        .map(l => l.replace(/^- /, '').trim())
        .map(l => `<li>${l}</li>`)
        .join('');
      return `\n<ul>${items}</ul>`;
    },
  );

  // Inline: links, bold, italic, code
  let inline = withLists
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const safeUrl = /^(https?:|mailto:|\/)/.test(url) ? url : '#';
      return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphs from double newlines (split on \n\n, ignore lines already wrapped)
  return inline
    .split(/\n{2,}/)
    .map(p => (p.trim().startsWith('<ul>') ? p : `<p>${p.replace(/\n/g, '<br/>')}</p>`))
    .join('');
}

// Quick item validation — returns array of human-readable issue tags.
export function validateItem({ details = {}, photos = [] }) {
  const issues = [];
  const name = (details['Name.txt'] || '').trim();
  const desc = (details['Description.txt'] || '').trim();
  const cost = (details['ItemCost.txt'] || '').trim();
  if (!desc) issues.push('No description');
  const numericCost = parseFloat(cost);
  if (!cost || isNaN(numericCost) || numericCost <= 0) issues.push('No price');
  if (photos.length === 0) {
    issues.push('No photos');
  } else {
    const hasMain = photos.some(p => /^main\.(jpg|jpeg|png|webp)$/i.test(p.name));
    if (!hasMain) issues.push('No main photo');
  }
  if (!name) issues.push('No name');
  return issues;
}

// Filename sort with photos prefixed "01_", "02_", etc. coming first in order,
// then any unprefixed photos alphabetically. main.* always pinned first.
export function sortPhotos(photos) {
  return [...photos].sort((a, b) => {
    const aMain = /^main\./i.test(a.name) ? -1 : 0;
    const bMain = /^main\./i.test(b.name) ? -1 : 0;
    if (aMain !== bMain) return aMain - bMain;
    const aPrefix = a.name.match(/^(\d+)_/);
    const bPrefix = b.name.match(/^(\d+)_/);
    if (aPrefix && bPrefix) return parseInt(aPrefix[1]) - parseInt(bPrefix[1]);
    if (aPrefix && !bPrefix) return -1;
    if (!aPrefix && bPrefix) return 1;
    return a.name.localeCompare(b.name);
  });
}

// Compute the next "Copy of X" name that doesn't collide with existing items.
export function nextDuplicateName(existing, baseName) {
  const taken = new Set(existing.map(i => i.dirName.toLowerCase()));
  let candidate = `Copy of ${baseName}`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `Copy of ${baseName} (${n++})`;
  }
  return candidate;
}
