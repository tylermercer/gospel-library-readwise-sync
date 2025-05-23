import { turndown } from "./turndownwrapper.js";

export function getContentUrisForAnnotation(annotation) {
  // TODO combine URIs to fetch contents more intelligently? Would enable getting scripture references
  return annotation?.highlights?.map(h => h.uri) ?? [];
}

// words can be split by spaces or dashes. The 🌌 is placed around links by htmlToMarkdownWithPlaceholders() to
// ensure they count as separate words.
// NOTE: the capturing group is important, it lets us split on this regex and keep the separators in the resulting array
// TODO if any other word separators are discovered, add them here
const SeparatorRegex = /([🌌\s—–-]+)/g;

export function assembleHighlights(annotations, contents) {
  return annotations.map(a => {
    try {
      const id = a.annotationId;
      if (!id) {
        throw new Error('Missing annotationId on annotation')
      }
      const highlights = a?.highlights ?? [];
      const uris = getContentUrisForAnnotation(a);
      const contentObjs = uris.map(uri => {
        const c = contents[uri];
        if (!c) {
          console.error(`Missing contents for URI '${uri}'`, contents);
          throw new Error(`Missing contents for URI '${uri}'`)
        }
        return c
      });
      const source = contentObjs[0] ? getSourceInfo(a, contentObjs[0]) : undefined;
      const sourceLink = uris[0] ? uriToUrl(uris[0]) : undefined;
      const mdParts = contentObjs
        .flatMap(c => c.content)
        .map(c => c.markup)
        .map(htmlToMarkdownWithPlaceholders);
      const fullMd = mdParts
        .map(withoutPlaceholders)
        .join('\n\n');
      const highlightMd = mdParts.map((part, i) => {
        const h = highlights[i];
        // highlights are stored as word offsets in the passage (or -1 for the start or end)
        const startOffset = Math.max(h.startOffset - 1, 0); // h.startOffset is 1-indexed
        const endOffset = h.endOffset == -1 ? Number.POSITIVE_INFINITY : h.endOffset;
        // split by words (keeping the separators because of the capturing group)
        const parts = part.split(SeparatorRegex);
        const startIndex = wordOffsetToIndex(parts, startOffset);
        const endIndex = wordOffsetToIndex(parts, endOffset);
        const highlightPart = parts.slice(startIndex, endIndex).join('');
        return highlightPart;
      })
        .map(withoutPlaceholders)
        .map(s => s.trim())
        .join('\n\n');
      const noteMd = a.note?.content ? noteToMarkdown(a.note.content) : undefined;
      /** @type {string[]} tags */
      const tags = a.tags?.map(t => t.name) ?? [];
      if (!highlightMd) {
        console.warn(`Missing text for annotation ${id}`, { a, fullMd, highlightMd });
      }
      return {
        id,
        created: new Date(a.created),
        updated: new Date(a.lastUpdated),
        source,
        fullMd,
        highlightMd,
        noteMd,
        tags,
        sourceLink,
      }
    } catch (err) {
      // possibly a missing URI, if content was moved. Not sure how to recover from that. (😢)
      const uri = a.uri ?? a.highlights?.[0]?.uri ?? 'unknown'
      console.warn(`Failed to assemble highlight on ${uri} (possibly the content was moved 😢)`, a, err);
      return undefined;
    }
  }).filter(h => !!h?.highlightMd) // filter out errors and empty highlights
}

const knownSources = [
  {
    url: 'https://www.churchofjesuschrist.org/study/scriptures/bofm',
    title: 'Book of Mormon',
    author: 'The Church of Jesus Christ of Latter-day Saints',
    type: 'books',
  },
  {
    url: 'https://www.churchofjesuschrist.org/study/scriptures/nt',
    title: 'New Testament',
    author: 'The Church of Jesus Christ of Latter-day Saints',
    type: 'books',
  },
  {
    url: 'https://www.churchofjesuschrist.org/study/scriptures/ot',
    title: 'Old Testament',
    author: 'The Church of Jesus Christ of Latter-day Saints',
    type: 'books',
  },
  {
    url: 'https://www.churchofjesuschrist.org/study/scriptures/dc-testament',
    title: 'Doctrine and Covenants',
    author: 'The Church of Jesus Christ of Latter-day Saints',
    type: 'books',
  },
  {
    url: 'https://www.churchofjesuschrist.org/study/scriptures/pgp',
    title: 'Pearl of Great Price',
    author: 'The Church of Jesus Christ of Latter-day Saints',
    type: 'books',
  },
]

function getSourceInfo(annotation, contentObj) {
  const url = uriToUrl(annotation.uri);
  // check for known sources first - this groups BoM citations into one source, for example
  const source = knownSources.find(s => url.startsWith(s.url));
  if (source) {
    return source;
  }
  const author = contentObj.authorName || contentObj.publication;
  const title = contentObj.headline;
  return {
    url,
    author,
    title,
  };
}

function uriToUrl(uri) {
  return 'https://www.churchofjesuschrist.org/study' + uri;
}

function wordOffsetToIndex(wordsAndSeparators, wordOffset) {
  let offset = 0;
  let index = 0;
  let inLink = false;
  while (offset < wordOffset && index < wordsAndSeparators.length) {
    const p = wordsAndSeparators[index++];
    if (!inLink && p.match(SeparatorRegex)?.[0] !== p) {
      // only count it if it's not a separator
      offset++;
    }
    // don't count link URLs as multiple words
    if (p.includes('](')) {
      inLink = true;
    }
    if (inLink && p.includes(')')) {
      inLink = false;
    }
  }
  return index;
}

function htmlToMarkdownWithPlaceholders(html) {
  return turndown(html, {
    // filter out <sup> tags
    // we include a 🦶 placeholder here (filtered out later) with separators around it so that
    // each footnote will count as a separate word
    // (lol one day this will show up in an actual highlight and this will break)
    'no-sups': {
      filter: 'sup',
      replacement: () => '🌌🦶🌌',
    },
    // for links, add fake word separators around them, because that's how word counting works.
    // also filter out footnote links, and expand links within GL
    'add-fake-word-separator-after-links': {
      filter: 'a',
      replacement: (content, node) => {
        const rawHref = node.getAttribute('href') || '';
        const fullHref = rawHref.startsWith('/') ? `https://www.churchofjesuschrist.org/study${rawHref}` :
          rawHref.startsWith('#') ? '' :
            rawHref;
        const md = (!fullHref) ? content : `[${content}](${fullHref})`;
        return `🌌${md}🌌`;
      },
    }
  }, {
    // Readwise only supports a subset of Markdown, and requires asterisks to be used
    emDelimiter: '*',
    strongDelimiter: '**',
  });
}

function withoutPlaceholders(md) {
  const cleaned = md
    .replaceAll('🦶', '')
    .replaceAll('🌌', '')
  return cleaned
}

function noteToMarkdown(noteHtml) {
  return turndown(noteHtml, {}, {
    emDelimiter: '*',
    strongDelimiter: '**',
  })
    .replace(/\n\s+\n/g, '\n\n') // remove extra blank lines
}
