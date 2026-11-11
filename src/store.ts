import * as path from 'path';
import * as vscode from 'vscode';
import { Git } from './git';
import { Change, Diff, InlineComment, Phabricator, Revision, TimelineEntry, User } from './phab';

export interface ActiveReview {
  revision: Revision;
  diff: Diff;
  inlines: InlineComment[];
  timeline: TimelineEntry[];
}

export interface PendingInline {
  path: string;
  line: number;
  length: number;
  content: string;
  dateCreated: number;
}

/** What a store change affected, so listeners can skip work that does not depend on it. */
export type StoreChange = 'revision' | 'checkout' | 'viewed' | 'pending';

/** Holds the active revision, its checkout state, the per-file viewed state and pending inline comments. */
export class ReviewStore {
  private readonly changeEmitter = new vscode.EventEmitter<StoreChange>();
  readonly onDidChange = this.changeEmitter.event;

  active: ActiveReview | undefined;
  me: User | undefined;
  /** True when the git HEAD is the branch this extension created for the active diff. */
  checkedOut = false;
  /** Number of reviews submitted successfully; the webviews use it to drop a comment draft once it was published. */
  submissions = 0;

  constructor(
    readonly phab: Phabricator,
    readonly git: Git,
    private readonly state: vscode.Memento,
    private readonly branchPrefix: string,
  ) {}

  branchFor(diff: Diff): string {
    return `${this.branchPrefix}D${diff.revisionID}/${diff.id}`;
  }

  fileUri(relPath: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.git.root, relPath));
  }

  relPath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const rel = path.relative(this.git.root, uri.fsPath);
    return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
  }

  /** Change of the active diff shown by a checked-out workspace file. */
  changeFor(uri: vscode.Uri): Change | undefined {
    const rel = this.relPath(uri);
    return rel ? this.active?.diff.changes.find((c) => c.currentPath === rel) : undefined;
  }

  async open(revisionID: number): Promise<void> {
    const revision = await this.phab.revision(revisionID);
    const [diff, { inlines, timeline }] = await Promise.all([this.phab.diff(revision.diffPHID), this.phab.transactions(revisionID)]);
    const phids = [revision.authorPHID, ...revision.reviewers.map((r) => r.phid), ...inlines.flatMap((i) => i.comments.map((c) => c.authorPHID)), ...timeline.map((t) => t.authorPHID)];
    await this.phab.resolveUsers(phids);
    this.active = { revision, diff, inlines, timeline };
    await this.prunePublishedPending(revisionID, inlines);
    await this.state.update('activeRevisionID', revisionID);
    await this.refreshCheckoutState();
    void vscode.commands.executeCommand('setContext', 'phabreview.hasRevision', true);
    this.changeEmitter.fire('revision');
  }

  async refresh(): Promise<void> {
    if (this.active) {
      await this.open(this.active.revision.id);
    } else {
      this.changeEmitter.fire('revision');
    }
  }

  async close(): Promise<void> {
    this.active = undefined;
    this.checkedOut = false;
    await this.state.update('activeRevisionID', undefined);
    void vscode.commands.executeCommand('setContext', 'phabreview.hasRevision', false);
    this.changeEmitter.fire('revision');
  }

  async restore(): Promise<void> {
    const id = this.state.get<number>('activeRevisionID');
    if (id) {
      await this.open(id);
    }
  }

  async refreshCheckoutState(): Promise<void> {
    const branch = await this.git.currentBranch();
    this.checkedOut = this.active !== undefined && branch === this.branchFor(this.active.diff);
  }

  /** Re-reads HEAD after a possible branch switch outside the extension and notifies listeners if it changed. */
  async syncCheckoutState(): Promise<void> {
    const was = this.checkedOut;
    await this.refreshCheckoutState();
    if (was !== this.checkedOut) {
      this.changeEmitter.fire('checkout');
    }
  }

  async checkout(): Promise<void> {
    if (!this.active) {
      return;
    }
    const { revision, diff } = this.active;
    const branch = this.branchFor(diff);
    const current = await this.git.currentBranch();
    if (current === branch) {
      this.checkedOut = true;
      this.changeEmitter.fire('checkout');
      return;
    }
    if (!(await this.git.isClean())) {
      throw new Error('Working tree has uncommitted changes; commit or stash them before checking out a revision');
    }
    if (!current.startsWith(this.branchPrefix)) {
      await this.state.update('previousBranch', current);
    }
    if (await this.git.branchExists(branch)) {
      await this.git.run(['checkout', '--quiet', branch]);
    } else {
      const raw = await this.phab.rawDiff(diff.id);
      await this.git.checkoutPatch(branch, diff.baseCommit, raw, `[phabreview] D${revision.id} diff ${diff.id}: ${revision.title}`);
    }
    this.checkedOut = true;
    this.changeEmitter.fire('checkout');
  }

  /** Returns to the branch that was active before the first checkout. */
  async exitReviewMode(): Promise<void> {
    const previous = this.state.get<string>('previousBranch');
    const current = await this.git.currentBranch();
    if (previous && current.startsWith(this.branchPrefix)) {
      if (!(await this.git.isClean())) {
        throw new Error('Working tree has uncommitted changes; commit or stash them first');
      }
      await this.git.run(['checkout', '--quiet', previous]);
      await this.state.update('previousBranch', undefined);
    }
    this.checkedOut = false;
    this.changeEmitter.fire('checkout');
  }

  /** Local branches created by this extension, mapped to revision IDs. */
  async localRevisionBranches(): Promise<Array<{ branch: string; revisionID: number }>> {
    const out = await this.git.run(['branch', '--list', '--format=%(refname:short)', `${this.branchPrefix}*`]);
    return out
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean)
      .map((branch) => ({ branch, revisionID: Number(/D(\d+)/.exec(branch)?.[1] ?? 0) }))
      .filter((b) => b.revisionID > 0);
  }

  private viewedKey(diff: Diff): string {
    return `viewed:${diff.id}`;
  }

  viewedFiles(diff: Diff): Set<string> {
    return new Set(this.state.get<string[]>(this.viewedKey(diff), []));
  }

  async setViewed(diff: Diff, paths: string[], viewed: boolean): Promise<void> {
    const set = this.viewedFiles(diff);
    for (const p of paths) {
      if (viewed) {
        set.add(p);
      } else {
        set.delete(p);
      }
    }
    await this.state.update(this.viewedKey(diff), [...set]);
    this.changeEmitter.fire('viewed');
  }

  private pendingKey(revisionID: number): string {
    return `pending:${revisionID}`;
  }

  /**
   * Draft inline comments created from VS Code for the active revision. They are persisted per revision because
   * Phabricator keeps the drafts and publishes them with the next review, and Conduit cannot list them.
   */
  get pending(): PendingInline[] {
    return this.active ? this.state.get<PendingInline[]>(this.pendingKey(this.active.revision.id), []) : [];
  }

  async addPending(inline: PendingInline): Promise<void> {
    if (!this.active) {
      return;
    }
    await this.state.update(this.pendingKey(this.active.revision.id), [...this.pending, inline]);
    this.changeEmitter.fire('pending');
  }

  /** Records a successful review submission, which published the pending drafts. Call before refreshing. */
  async markSubmitted(revisionID: number): Promise<void> {
    this.submissions++;
    await this.state.update(this.pendingKey(revisionID), undefined);
  }

  /** Drops drafts that have since been published, e.g. by a review submitted in the web UI. */
  private async prunePublishedPending(revisionID: number, inlines: InlineComment[]): Promise<void> {
    const key = this.pendingKey(revisionID);
    const pending = this.state.get<PendingInline[]>(key, []);
    const unpublished = pending.filter((p) => !inlines.some((i) => i.path === p.path && i.line === p.line && i.comments.some((c) => c.content === p.content)));
    if (unpublished.length !== pending.length) {
      await this.state.update(key, unpublished.length > 0 ? unpublished : undefined);
    }
  }
}
