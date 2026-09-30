export interface ParsedQuery {
  text: string;
  query: string;
  tags: string[];
}

const TOKEN = /(?<=^|\s)tag:(?:"([^"]*)"|([^\s"]*))(\s|$)/gi;

const PENDING = /(?<=^|\s)tag:(?:"[^"]*|[^\s"]*)$/i;

function canonical(name: string): string {
  return name.trim().replace(/^#/, '').trim().toLowerCase();
}

export function parseQuery(value: string, commitTrailing = false): ParsedQuery {
  const tags: string[] = [];

  const text = value.replace(TOKEN, (match, quoted: string | undefined, bare: string | undefined, end: string) => {
    const name = canonical(quoted ?? bare ?? '');
    if (name === '' || (end === '' && !commitTrailing)) return match;
    if (!tags.includes(name)) tags.push(name);
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
