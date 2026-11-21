import { describe, expect, it } from 'vitest';
import { joinWithTrailingSpace, quoteForShell, quotePaths } from '@continuo-terminal/shell-quote';

describe('terminal-drag-drop shell quote TDD', () => {
  it('POSIX leaves bare-safe paths unchanged and adds trailing space at join time', () => {
    const r = quoteForShell('/Users/me/a.txt', 'posix');

    expect(r).toEqual({ ok: true, quoted: '/Users/me/a.txt' });
    expect(joinWithTrailingSpace(['/Users/me/a.txt'])).toBe('/Users/me/a.txt ');
  });

  it('POSIX single-quotes paths with spaces', () => {
    expect(quoteForShell('/Users/a b/c.txt', 'posix')).toEqual({
      ok: true,
      quoted: "'/Users/a b/c.txt'",
    });
  });

  it("POSIX escapes single quotes with the standard splice", () => {
    expect(quoteForShell("/Users/o'reilly.md", 'posix')).toEqual({
      ok: true,
      quoted: "'/Users/o'\\''reilly.md'",
    });
  });

  it('PowerShell uses single quotes, escapes single quotes by doubling, and never uses double quotes', () => {
    const r = quoteForShell("C:\\Users\\me\\o'reilly $HOME;`x.txt", 'powershell');

    expect(r).toEqual({
      ok: true,
      quoted: "'C:\\Users\\me\\o''reilly $HOME;`x.txt'",
    });
    if (r.ok) expect(r.quoted).not.toContain('"');
  });

  it('cmd uses double quotes and rejects unrepresentable double quote and percent paths', () => {
    expect(quoteForShell('C:\\Users\\me\\a b.txt', 'cmd')).toEqual({
      ok: true,
      quoted: '"C:\\Users\\me\\a b.txt"',
    });
    expect(quoteForShell('C:\\bad"name.txt', 'cmd')).toEqual({
      ok: false,
      reason: 'cmd_unrepresentable',
    });
    expect(quoteForShell('C:\\%TEMP%\\a.txt', 'cmd')).toEqual({
      ok: false,
      reason: 'cmd_unrepresentable',
    });
  });

  it('rejects control characters for all shell families', () => {
    for (const family of ['posix', 'powershell', 'cmd'] as const) {
      expect(quoteForShell('/tmp/evil\nrm', family)).toEqual({
        ok: false,
        reason: 'control_char',
      });
    }
  });

  it('rejects DEL as a control character', () => {
    expect(quoteForShell('/path/with\x7f.txt', 'posix')).toEqual({
      ok: false,
      reason: 'control_char',
    });
  });

  it('cmd rejects delayed-expansion bang paths as unrepresentable', () => {
    expect(quoteForShell('C:\\path!file', 'cmd')).toEqual({
      ok: false,
      reason: 'cmd_unrepresentable',
    });
  });

  it('quotePaths keeps quoted paths and reports skipped paths', () => {
    const r = quotePaths(['/tmp/a.txt', '/tmp/evil\nrm'], 'posix');

    expect(r).toEqual({
      quoted: ['/tmp/a.txt'],
      skipped: [{ path: '/tmp/evil\nrm', reason: 'control_char' }],
    });
  });

  it('joins multiple quoted paths with single spaces plus one trailing space', () => {
    expect(joinWithTrailingSpace(['/tmp/a.txt', "'/tmp/b c.txt'"])).toBe(
      "/tmp/a.txt '/tmp/b c.txt' ",
    );
    expect(joinWithTrailingSpace([])).toBe('');
  });

  it('preserves unicode verbatim without NFC or NFD coercion', () => {
    const nfc = '/tmp/café.txt';
    const nfd = '/tmp/cafe\u0301.txt';

    const quotedNfc = quoteForShell(nfc, 'posix');
    const quotedNfd = quoteForShell(nfd, 'posix');

    expect(quotedNfc).toEqual({ ok: true, quoted: `'${nfc}'` });
    expect(quotedNfd).toEqual({ ok: true, quoted: `'${nfd}'` });
    if (quotedNfc.ok && quotedNfd.ok) {
      const nfcInsideQuotes = quotedNfc.quoted.slice(1, -1);
      const nfdInsideQuotes = quotedNfd.quoted.slice(1, -1);
      expect(Buffer.from(nfcInsideQuotes, 'utf8')).toEqual(Buffer.from(nfc, 'utf8'));
      expect(Buffer.from(nfdInsideQuotes, 'utf8')).toEqual(Buffer.from(nfd, 'utf8'));
      expect(quotedNfc.quoted).not.toBe(quotedNfd.quoted);
    }
  });
});
