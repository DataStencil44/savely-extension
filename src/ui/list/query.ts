/**
 * `tag:` in the search box.
 *
 * Until now a tag filter could only be started by clicking a chip on a card,
 * which means it could only be reached for tags a visible card happened to
 * carry - and never from the keyboard. Typing `tag:rust` in the search field
 * leaves the field and becomes a filter chip instead: the same `state.tags` a
 * click fills, so there is one filter and not two ways of narrowing that could
 * disagree.
 *
 * A pure module - it takes what is in the field and says what should be in it,
 * what the full-text search should see, and which tags to add.
 */

export interface ParsedQuery {
  /** What the field should hold: the typing, minus the tokens that just became filters. */
  text: string;
  /**
   * What the full-text search should see: `text` minus a half-typed token.
   * Without this, `tag:ru` would be searched for as words and empty the list
   * between the colon and the space.
   */
  query: string;
  /** Tags to add to the filter: trimmed, lowercased, in the order they were typed. */
  tags: string[];
}

/**
 * A token is `tag:` plus a name, either bare (ends at the first space) or in
 * double quotes (a tag may contain spaces - the editor allows it). The
 * lookbehind keeps `mailto:tag:x` and the like out of it: a token starts a
 * word or it is not a token.
 */
const TOKEN = /(?<=^|\s)tag:(?:"([^"]*)"|([^\s"]*))(\s|$)/gi;

/** The same token, half typed, at the very end of the field. */
const PENDING = /(?<=^|\s)tag:(?:"[^"]*|[^\s"]*)$/i;

function canonical(name: string): string {
  // `#rust` and `rust` are the same tag - the chips are written with the hash,
  // so someone reading one off a card will type it that way.
  return name.trim().replace(/^#/, '').trim().toLowerCase();
}

/**
 * A token becomes a filter once it is finished - that is, once a space follows
 * it. `commitTrailing` (Enter) finishes the last one too, so a filter can be
 * applied without a trailing space.
 */
export function parseQuery(value: string, commitTrailing = false): ParsedQuery {
  const tags: string[] = [];

  const text = value.replace(TOKEN, (match, quoted: string | undefined, bare: string | undefined, end: string) => {
    const name = canonical(quoted ?? bare ?? '');
    // An unfinished token, or `tag:` with nothing after it, stays in the field.
    if (name === '' || (end === '' && !commitTrailing)) return match;
    if (!tags.includes(name)) tags.push(name);
    // The separator stays behind, or the words either side of the token would join.
    return end;
  });

  const collapsed = text.replace(/\s+/g, ' ').trim();
  const pending = PENDING.exec(collapsed);

  return {
    text: collapsed,
    query: pending === null ? collapsed : collapsed.slice(0, pending.index).trim(),
    tags,
  };
}
