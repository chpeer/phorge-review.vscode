import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Conduit } from '../conduit';
import { Phabricator, parseRevisionID, type User } from '../phab';

describe('parseRevisionID', () => {
  it('AcceptsRevisionNamesBareNumbersAndUrls', () => {
    const inputs = ['D12345', 'd12345', ' 12345 ', 'https://phab2.example.com/D12345', 'http://localhost:8080/D12345#inline-1'];
    assert.deepEqual(inputs.map(parseRevisionID), [12345, 12345, 12345, 12345, 12345]);
  });

  it('RejectsInputWithoutRevision', () => {
    assert.deepEqual(['', 'https://phab2.example.com/', 'abc123'].map(parseRevisionID), [undefined, undefined, undefined]);
  });
});

describe('Phabricator.resolveUsers', () => {
  it('InlinesUploadedProfilePicturesAndKeepsPublicDefaultAvatars', async () => {
    const users = [
      { phid: 'PHID-USER-alice', userName: 'alice', realName: 'Alice', image: 'https://phab.example.com/file/data/key1/PHID-FILE-alice/profile' },
      { phid: 'PHID-USER-bob', userName: 'bob', realName: 'Bob', image: 'https://phab.example.com/res/phabricator/abc/rsrc/image/avatar.png' },
      { phid: 'PHID-USER-carol', userName: 'carol', realName: 'Carol', image: 'https://phab.example.com/file/data/key2/PHID-FILE-carol/profile' },
    ];
    const conduit = {
      call: async (method: string, params: Record<string, unknown>) => {
        if (method === 'user.query') {
          return users;
        }
        if (method === 'file.download' && params.phid === 'PHID-FILE-alice') {
          return 'YWxpY2U=';
        }
        throw new Error(`no access to ${String(params.phid)}`);
      },
    } as unknown as Conduit;

    const resolved = await new Phabricator(conduit).resolveUsers(users.map((u) => u.phid));

    const expected = new Map<string, User>([
      ['PHID-USER-alice', { ...users[0], image: 'data:image/png;base64,YWxpY2U=' }],
      ['PHID-USER-bob', users[1]],
      ['PHID-USER-carol', { ...users[2], image: undefined }],
    ]);
    assert.deepEqual(resolved, expected);
  });
});
