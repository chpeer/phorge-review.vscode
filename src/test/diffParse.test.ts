import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addedRanges, changeAnchors, mapHunks } from '../diffParse';

describe('mapHunks', () => {
  it('ReportsAddedLinesAndRemovedBlocksInNewFileCoordinates', () => {
    const hunks = [
      { oldOffset: 1, newOffset: 1, corpus: ' a\n-b\n+B\n+B2\n c\n' },
      { oldOffset: 10, newOffset: 11, corpus: ' j\n-k\n-l\n m\n' },
    ];
    assert.deepEqual(mapHunks(hunks), {
      added: [2, 3],
      removed: [
        { beforeNewLine: 2, lines: ['b'] },
        { beforeNewLine: 12, lines: ['k', 'l'] },
      ],
    });
  });

  it('PlacesRemovalAtEndOfFileAfterLastLine', () => {
    const map = mapHunks([{ oldOffset: 1, newOffset: 1, corpus: ' a\n-b\n\\ No newline at end of file\n' }]);
    assert.deepEqual(map, { added: [], removed: [{ beforeNewLine: 2, lines: ['b'] }] });
  });
});

describe('addedRanges', () => {
  it('GroupsConsecutiveLines', () => {
    assert.deepEqual(addedRanges([1, 2, 3, 7, 9, 10]), [[1, 3], [7, 7], [9, 10]]);
  });
});

describe('changeAnchors', () => {
  it('ReturnsSortedUniqueStartsOfAddedRangesAndRemovedBlocks', () => {
    const anchors = changeAnchors({ added: [5, 6, 20], removed: [{ beforeNewLine: 5, lines: ['x'] }, { beforeNewLine: 12, lines: ['y'] }] });
    assert.deepEqual(anchors, [5, 12, 20]);
  });
});
