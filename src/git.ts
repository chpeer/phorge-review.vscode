import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export class Git {
  constructor(readonly root: string) {}

  static async open(dir: string): Promise<Git> {
    const root = await run(dir, ['rev-parse', '--show-toplevel']);
    return new Git(root.trim());
  }

  run(args: string[]): Promise<string> {
    return run(this.root, args);
  }

  async currentBranch(): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  async isClean(): Promise<boolean> {
    return (await this.run(['status', '--porcelain', '--untracked-files=no'])).trim() === '';
  }

  async hasCommit(sha: string): Promise<boolean> {
    try {
      await this.run(['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  async ensureCommit(sha: string): Promise<void> {
    if (await this.hasCommit(sha)) {
      return;
    }
    try {
      await this.run(['fetch', '--quiet', 'origin', sha]);
    } catch {
      await this.run(['fetch', '--quiet', 'origin']);
    }
    if (!(await this.hasCommit(sha))) {
      throw new Error(`Base commit ${sha} not found locally and could not be fetched`);
    }
  }

  async showFile(sha: string, filePath: string): Promise<string | undefined> {
    try {
      return await this.run(['show', `${sha}:${filePath}`]);
    } catch {
      return undefined;
    }
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates `branch` at `base`, applies `rawDiff` and commits it. Only the patched files are committed, so untracked
   * files in the working tree stay untracked. On failure it switches back and deletes the branch.
   */
  async checkoutPatch(branch: string, base: string, rawDiff: string, message: string): Promise<void> {
    await this.ensureCommit(base);
    await this.run(['checkout', '--quiet', '-b', branch, base]);
    const tmp = path.join(os.tmpdir(), `phabreview-${process.pid}-${Date.now()}.diff`);
    fs.writeFileSync(tmp, rawDiff);
    try {
      await this.run(['apply', '--index', '--whitespace=nowarn', tmp]);
      await this.run(['-c', 'user.name=phabreview', '-c', 'user.email=phabreview@localhost', 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', message]);
    } catch (err) {
      await this.run(['reset', '--quiet', '--hard']);
      await this.run(['checkout', '--quiet', '-']);
      await this.run(['branch', '-D', branch]);
      throw err;
    } finally {
      fs.unlinkSync(tmp);
    }
  }
}

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args[0]} failed: ${stderr.trim() || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
