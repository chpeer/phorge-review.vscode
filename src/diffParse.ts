/** Pure helpers for mapping Phabricator diff hunks onto editor lines. */

export interface Hunk {
  oldOffset: number;
  newOffset: number;
  corpus: string;
}

export interface RemovedBlock {
  /** 1-based line in the new file before which the block was removed (newLength+1 when removed at EOF). */
  beforeNewLine: number;
  lines: string[];
}

export interface LineMap {
  added: number[];
  removed: RemovedBlock[];
}

function corpusLines(corpus: string): string[] {
  const lines = corpus.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Returns 1-based new-file line numbers of added lines, and where removed blocks used to be. */
export function mapHunks(hunks: Hunk[]): LineMap {
  const added: number[] = [];
  const removed: RemovedBlock[] = [];
  for (const hunk of hunks) {
    let newLine = hunk.newOffset;
    let pending: string[] = [];
    const flush = () => {
      if (pending.length > 0) {
        removed.push({ beforeNewLine: newLine, lines: pending });
        pending = [];
      }
    };
    for (const line of corpusLines(hunk.corpus)) {
      const kind = line[0];
      const text = line.slice(1);
      if (kind === '+') {
        flush();
        added.push(newLine);
        newLine++;
      } else if (kind === '-') {
        pending.push(text);
      } else if (kind === '\\') {
        // "\ No newline at end of file" marker: no line.
      } else {
        flush();
        newLine++;
      }
    }
    flush();
  }
  return { added, removed };
}

/** Groups consecutive added line numbers into [start, end] ranges (1-based, inclusive). */
export function addedRanges(added: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const line of added) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === line - 1) {
      last[1] = line;
    } else {
      ranges.push([line, line]);
    }
  }
  return ranges;
}

/** Sorted 1-based anchor lines of every change (added range starts and removed block positions). */
export function changeAnchors(map: LineMap): number[] {
  const anchors = new Set<number>();
  for (const [start] of addedRanges(map.added)) {
    anchors.add(start);
  }
  for (const block of map.removed) {
    anchors.add(block.beforeNewLine);
  }
  return [...anchors].sort((a, b) => a - b);
}
