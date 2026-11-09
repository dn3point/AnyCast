'use strict';
// Tiny, tolerant XML helpers. UPnP descriptions and SOAP replies from TVs are
// small and frequently not quite well-formed, so regex extraction is more
// forgiving here than a strict parser.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

function unescapeXml(value) {
  return String(value ?? '').replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    switch (e.toLowerCase()) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'amp': return '&';
      default:
        return e[1] === 'x' || e[1] === 'X'
          ? String.fromCodePoint(parseInt(e.slice(2), 16))
          : String.fromCodePoint(parseInt(e.slice(1), 10));
    }
  });
}

function tagRegex(name) {
  // Matches <name>, <ns:name>, <name attr="..."> ... </name> (non-greedy).
  return new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`,
    'gi',
  );
}

function findAll(xml, name) {
  return [...String(xml).matchAll(tagRegex(name))].map((m) => m[1]);
}

function findFirst(xml, name) {
  const m = tagRegex(name).exec(String(xml));
  return m ? m[1] : null;
}

function textOf(xml, name) {
  const raw = findFirst(xml, name);
  return raw == null ? null : unescapeXml(raw.trim());
}

module.exports = { escapeXml, unescapeXml, findAll, findFirst, textOf };
