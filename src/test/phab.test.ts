import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRevisionID } from '../phab';

describe('parseRevisionID', () => {
  it('AcceptsRevisionNamesBareNumbersAndUrls', () => {
    const inputs = ['D12345', 'd12345', ' 12345 ', 'https://phab2.example.com/D12345', 'http://localhost:8080/D12345#inline-1'];
    assert.deepEqual(inputs.map(parseRevisionID), [12345, 12345, 12345, 12345, 12345]);
  });

  it('RejectsInputWithoutRevision', () => {
    assert.deepEqual(['', 'https://phab2.example.com/', 'abc123'].map(parseRevisionID), [undefined, undefined, undefined]);
  });
});
