import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

describe('Phabricator.loadAvatars', () => {
  const users = [
    { phid: 'PHID-USER-alice', userName: 'alice', realName: 'Alice', image: 'https://phab.example.com/file/data/key1/PHID-FILE-alice/profile' },
    { phid: 'PHID-USER-bob', userName: 'bob', realName: 'Bob', image: 'https://phab.example.com/res/phabricator/abc/rsrc/image/avatar.png' },
    { phid: 'PHID-USER-carol', userName: 'carol', realName: 'Carol', image: 'https://phab.example.com/file/data/key2/PHID-FILE-carol/profile' },
  ];

  /** Fake Conduit that serves only alice's picture and records the calls made. */
  function fakeConduit(calls: string[]): Conduit {
    return {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push(method);
        if (method === 'user.query') {
          return users;
        }
        if (method === 'file.download' && params.phid === 'PHID-FILE-alice') {
          return 'YWxpY2U=';
        }
        throw new Error(`no access to ${String(params.phid)}`);
      },
    } as unknown as Conduit;
  }

  it('ResolveUsersLoadsNamesWithoutDownloadingPictures', async () => {
    const calls: string[] = [];

    const resolved = await new Phabricator(fakeConduit(calls)).resolveUsers(users.map((u) => u.phid));

    const expected = new Map<string, User>(users.map(({ image: _, ...u }) => [u.phid, u]));
    assert.deepEqual({ resolved, calls }, { resolved: expected, calls: ['user.query'] });
  });

  it('InlinesUploadedProfilePicturesAndKeepsPublicDefaultAvatars', async () => {
    const phab = new Phabricator(fakeConduit([]));
    const phids = users.map((u) => u.phid);
    await phab.resolveUsers(phids);

    await phab.loadAvatars(phids);

    const expected = [{ ...users[0], image: 'data:image/png;base64,YWxpY2U=' }, users[1], { ...users[2], image: undefined }];
    assert.deepEqual(phids.map((p) => phab.user(p)), expected);
  });

  it('ReusesPicturesDownloadedInAnEarlierSession', async () => {
    const avatarDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'phabreview-avatars-'));
    const phid = 'PHID-USER-alice';
    const earlier = new Phabricator(fakeConduit([]), avatarDir);
    await earlier.resolveUsers([phid]);
    await earlier.loadAvatars([phid]);
    const calls: string[] = [];
    const later = new Phabricator(fakeConduit(calls), avatarDir);
    await later.resolveUsers([phid]);

    await later.loadAvatars([phid]);

    assert.deepEqual({ image: later.user(phid)?.image, calls }, { image: 'data:image/png;base64,YWxpY2U=', calls: ['user.query'] });
    await fs.promises.rm(avatarDir, { recursive: true });
  });
});
