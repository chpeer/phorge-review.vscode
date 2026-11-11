import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Git } from '../git';

const ADD_NEW_FILE = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n';
const CHANGE_MISSING_LINE = 'diff --git a/base.txt b/base.txt\n--- a/base.txt\n+++ b/base.txt\n@@ -1 +1 @@\n-missing\n+changed\n';

describe('checkoutPatch', () => {
  let dir: string;
  let git: Git;
  let base: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phabreview-git-test-'));
    git = new Git(dir);
    await git.run(['init', '--quiet', '--initial-branch=main']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    await git.run(['add', 'base.txt']);
    await git.run(['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'base']);
    base = (await git.run(['rev-parse', 'HEAD'])).trim();
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'untracked\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('CommitsOnlyPatchedFilesAndLeavesUntrackedFilesUntracked', async () => {
    await git.checkoutPatch('review', base, ADD_NEW_FILE, 'review');
    const committed = (await git.run(['show', '--name-only', '--format=', 'HEAD'])).trim();
    const status = (await git.run(['status', '--porcelain'])).trim();
    assert.deepEqual({ branch: await git.currentBranch(), committed, status }, { branch: 'review', committed: 'new.txt', status: '?? scratch.txt' });
  });

  it('RestoresPreviousBranchAndDeletesReviewBranchWhenPatchDoesNotApply', async () => {
    await assert.rejects(git.checkoutPatch('review', base, CHANGE_MISSING_LINE, 'review'));
    assert.deepEqual({ branch: await git.currentBranch(), reviewBranchExists: await git.branchExists('review') }, { branch: 'main', reviewBranchExists: false });
  });
});
