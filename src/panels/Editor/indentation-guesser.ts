/*---------------------------------------------------------------------------------------------
 *  Ported from microsoft/vscode src/vs/editor/common/model/indentationGuesser.ts
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://github.com/microsoft/vscode/blob/main/LICENSE.txt
 *--------------------------------------------------------------------------------------------*/
// 按文件内容推断缩进(VSCode guessIndentation 逐行移植;输入由 ITextBuffer 改成字符串,行不含行尾)。
// 只看前 GUESS_INDENTATION_MAX_LINES 行(VSCode 同上限),大文件推断不随文件变长。
// BDD: src/__tests__/editor-indentation/

const TAB = 9;
const SPACE = 32;
const COMMA = 44;

/** VSCode:Look at most at the first 10k lines。 */
export const GUESS_INDENTATION_MAX_LINES = 10_000;

export interface GuessedIndentation {
  /** 缩进用空格时,一级缩进的空格数;用 tab 时为 tab 宽度(沿用默认值)。 */
  readonly tabSize: number;
  readonly insertSpaces: boolean;
}

interface SpacesDiffResult {
  spacesDiff: number;
  looksLikeAlignment: boolean;
}

/** 两行缩进的空格差(VSCode spacesDiff)。 */
function spacesDiff(a: string, aLength: number, b: string, bLength: number, result: SpacesDiffResult): void {
  result.spacesDiff = 0;
  result.looksLikeAlignment = false;

  // This can go both ways (e.g.):
  //  - a: "\t"
  //  - b: "\t    "
  //  => This should count 1 tab and 4 spaces
  let i: number;
  for (i = 0; i < aLength && i < bLength; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) break;
  }

  let aSpacesCnt = 0;
  let aTabsCount = 0;
  for (let j = i; j < aLength; j++) {
    if (a.charCodeAt(j) === SPACE) aSpacesCnt++;
    else aTabsCount++;
  }

  let bSpacesCnt = 0;
  let bTabsCount = 0;
  for (let j = i; j < bLength; j++) {
    if (b.charCodeAt(j) === SPACE) bSpacesCnt++;
    else bTabsCount++;
  }

  if (aSpacesCnt > 0 && aTabsCount > 0) return;
  if (bSpacesCnt > 0 && bTabsCount > 0) return;

  const tabsDiff = Math.abs(aTabsCount - bTabsCount);
  const spacesDiffValue = Math.abs(aSpacesCnt - bSpacesCnt);

  if (tabsDiff === 0) {
    // check if the indentation difference might be caused by alignment reasons
    // sometime folks like to align their code, but this should not be used as a hint
    result.spacesDiff = spacesDiffValue;
    if (spacesDiffValue > 0 && 0 <= bSpacesCnt - 1 && bSpacesCnt - 1 < a.length && bSpacesCnt < b.length) {
      if (b.charCodeAt(bSpacesCnt) !== SPACE && a.charCodeAt(bSpacesCnt - 1) === SPACE) {
        if (a.charCodeAt(a.length - 1) === COMMA) {
          // This looks like an alignment desire: e.g.
          // const a = b + c,
          //       d = b - c;
          result.looksLikeAlignment = true;
        }
      }
    }
    return;
  }
  if (spacesDiffValue % tabsDiff === 0) {
    result.spacesDiff = spacesDiffValue / tabsDiff;
  }
}

/**
 * 逐行取文本(不含 `\r\n` / `\n` / `\r`),最多 maxLines 行;不整篇 split(大文件只扫前若干行)。
 */
function* leadingLines(text: string, maxLines: number): Generator<string> {
  let start = 0;
  for (let n = 0; n < maxLines; n++) {
    if (start > text.length) return;
    let end = start;
    while (end < text.length) {
      const c = text.charCodeAt(end);
      if (c === 10 || c === 13) break;
      end++;
    }
    yield text.slice(start, end);
    if (end >= text.length) return;
    start = end + (text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10 ? 2 : 1);
  }
}

export function guessIndentation(text: string, defaultTabSize: number, defaultInsertSpaces: boolean): GuessedIndentation {
  let linesIndentedWithTabsCount = 0; // number of lines that contain at least one tab in indentation
  let linesIndentedWithSpacesCount = 0; // number of lines that contain only spaces in indentation

  let previousLineText = ''; // content of latest line that contained non-whitespace chars
  let previousLineIndentation = 0; // index at which latest line contained the first non-whitespace char

  const ALLOWED_TAB_SIZE_GUESSES = [2, 4, 6, 8, 3, 5, 7]; // prefer even guesses for `tabSize`, limit to [2, 8].
  const MAX_ALLOWED_TAB_SIZE_GUESS = 8; // max(ALLOWED_TAB_SIZE_GUESSES) = 8

  const spacesDiffCount = [0, 0, 0, 0, 0, 0, 0, 0, 0]; // `tabSize` scores
  const tmp: SpacesDiffResult = { spacesDiff: 0, looksLikeAlignment: false };

  for (const currentLineText of leadingLines(text, GUESS_INDENTATION_MAX_LINES)) {
    let currentLineHasContent = false; // does `currentLineText` contain non-whitespace chars
    let currentLineIndentation = 0; // index at which `currentLineText` contains the first non-whitespace char
    let currentLineSpacesCount = 0; // count of spaces found in `currentLineText` indentation
    let currentLineTabsCount = 0; // count of tabs found in `currentLineText` indentation
    for (let j = 0; j < currentLineText.length; j++) {
      const charCode = currentLineText.charCodeAt(j);
      if (charCode === TAB) {
        currentLineTabsCount++;
      } else if (charCode === SPACE) {
        currentLineSpacesCount++;
      } else {
        // Hit non whitespace character on this line
        currentLineHasContent = true;
        currentLineIndentation = j;
        break;
      }
    }

    // Ignore empty or only whitespace lines
    if (!currentLineHasContent) continue;

    if (currentLineTabsCount > 0) {
      linesIndentedWithTabsCount++;
    } else if (currentLineSpacesCount > 1) {
      linesIndentedWithSpacesCount++;
    }

    spacesDiff(previousLineText, previousLineIndentation, currentLineText, currentLineIndentation, tmp);

    if (tmp.looksLikeAlignment) {
      // if defaultInsertSpaces === true && the spaces count == tabSize, we may want to count it as valid indentation
      //
      // - item1
      //   - item2
      //
      // otherwise skip this line entirely
      //
      // const a = 1,
      //       b = 2;
      if (!(defaultInsertSpaces && defaultTabSize === tmp.spacesDiff)) continue;
    }

    const currentSpacesDiff = tmp.spacesDiff;
    if (currentSpacesDiff <= MAX_ALLOWED_TAB_SIZE_GUESS) spacesDiffCount[currentSpacesDiff]!++;

    previousLineText = currentLineText;
    previousLineIndentation = currentLineIndentation;
  }

  let insertSpaces = defaultInsertSpaces;
  if (linesIndentedWithTabsCount !== linesIndentedWithSpacesCount) {
    insertSpaces = linesIndentedWithTabsCount < linesIndentedWithSpacesCount;
  }

  let tabSize = defaultTabSize;

  // Guess tabSize only if inserting spaces...
  if (insertSpaces) {
    let tabSizeScore = 0;
    for (const possibleTabSize of ALLOWED_TAB_SIZE_GUESSES) {
      const possibleTabSizeScore = spacesDiffCount[possibleTabSize]!;
      if (possibleTabSizeScore > tabSizeScore) {
        tabSizeScore = possibleTabSizeScore;
        tabSize = possibleTabSize;
      }
    }

    // Let a tabSize of 2 win over 4 only if it has at least 2/3 of the occurrences of 4
    // This helps detect 2-space indentation in cases like YAML files where there might be
    // some 4-space diffs from deeper nesting, while still preferring 4 when it's clearly predominant
    if (
      tabSize === 4 &&
      spacesDiffCount[4]! > 0 &&
      spacesDiffCount[2]! > 0 &&
      spacesDiffCount[2]! >= (spacesDiffCount[4]! * 2) / 3
    ) {
      tabSize = 2;
    }
  }

  return { insertSpaces, tabSize };
}
