import * as vscode from 'vscode';
import { InlineComment } from './phab';
import { PendingInline, ReviewStore } from './store';

interface ThreadComment {
  authorPHID: string | undefined;
  content: string;
  dateCreated: number;
  pending: boolean;
}

interface Thread {
  path: string;
  line: number;
  length: number;
  isDone: boolean;
  diffID: number;
  comments: ThreadComment[];
}

/** Shows inline comments as editor comment threads and creates pending inlines, GitHub-extension style. */
export class InlineComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('phabreview', 'Phabricator');
  private threads: vscode.CommentThread[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly store: ReviewStore) {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => (this.isReviewable(document) ? [new vscode.Range(0, 0, document.lineCount - 1, 0)] : []),
    };
    this.subscriptions.push(
      store.onDidChange(() => this.rebuild()),
      vscode.commands.registerCommand('phabreview.createComment', (reply: vscode.CommentReply) => this.create(reply)),
    );
    this.rebuild();
  }

  private isReviewable(document: vscode.TextDocument): boolean {
    return this.store.checkedOut && this.store.changeFor(document.uri) !== undefined;
  }

  /**
   * Groups inlines into threads. Phabricator threads replies via replyToCommentPHID when they were made in the
   * web UI; everything else at the same position is grouped like the GitHub extension groups comments by position.
   * A thread's done state is its root inline's, as replies are rarely marked done themselves.
   */
  private buildThreads(inlines: InlineComment[], pending: PendingInline[]): Thread[] {
    const threads: Thread[] = [];
    const byKey = new Map<string, Thread>();
    const byCommentPHID = new Map<string, Thread>();
    const keyOf = (path: string, line: number, length: number) => `${path}:${line}:${length}`;
    for (const inline of inlines) {
      let thread = (inline.replyToCommentPHID && byCommentPHID.get(inline.replyToCommentPHID)) || byKey.get(keyOf(inline.path, inline.line, inline.length));
      if (!thread) {
        thread = { path: inline.path, line: inline.line, length: inline.length, isDone: inline.isDone, diffID: inline.diffID, comments: [] };
        threads.push(thread);
        byKey.set(keyOf(inline.path, inline.line, inline.length), thread);
      }
      for (const c of inline.comments) {
        thread.comments.push({ authorPHID: c.authorPHID, content: c.content, dateCreated: c.dateCreated, pending: false });
        byCommentPHID.set(c.phid, thread);
      }
    }
    for (const p of pending) {
      let thread = byKey.get(keyOf(p.path, p.line, p.length));
      if (!thread) {
        thread = { path: p.path, line: p.line, length: p.length, isDone: false, diffID: this.store.active?.diff.id ?? 0, comments: [] };
        threads.push(thread);
        byKey.set(keyOf(p.path, p.line, p.length), thread);
      }
      thread.comments.push({ authorPHID: this.store.me?.phid, content: p.content, dateCreated: p.dateCreated, pending: true });
    }
    return threads;
  }

  private toComment(c: ThreadComment): vscode.Comment {
    const user = c.authorPHID ? this.store.phab.user(c.authorPHID) : undefined;
    return {
      author: { name: user?.userName ?? (c.authorPHID ? this.store.phab.userName(c.authorPHID) : 'me'), iconPath: user?.image ? vscode.Uri.parse(user.image) : undefined },
      body: new vscode.MarkdownString(c.content),
      mode: vscode.CommentMode.Preview,
      timestamp: new Date(c.dateCreated * 1000),
      label: c.pending ? 'Pending' : undefined,
      contextValue: c.pending ? 'pending' : 'published',
    };
  }

  private rebuild(): void {
    for (const t of this.threads) {
      t.dispose();
    }
    this.threads = [];
    const active = this.store.active;
    // Threads are anchored to workspace files, whose lines only match the diff when it is checked out.
    if (!active || !this.store.checkedOut) {
      return;
    }
    for (const t of this.buildThreads(active.inlines, this.store.pending)) {
      const start = Math.max(t.line - 1, 0);
      const range = new vscode.Range(start, 0, start + Math.max(t.length - 1, 0), 0);
      const thread = this.controller.createCommentThread(this.store.fileUri(t.path), range, t.comments.map((c) => this.toComment(c)));
      thread.canReply = true;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.state = t.isDone ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      thread.label = t.diffID !== active.diff.id ? `Outdated (diff ${t.diffID})` : undefined;
      thread.contextValue = 'phabreview';
      this.threads.push(thread);
    }
  }

  private async create(reply: vscode.CommentReply): Promise<void> {
    const active = this.store.active;
    const relPath = this.store.relPath(reply.thread.uri);
    const range = reply.thread.range;
    if (!active || !relPath || !range) {
      return;
    }
    const line = range.start.line + 1;
    const length = range.end.line - range.start.line + 1;
    try {
      await this.store.phab.createInline(active.revision.id, relPath, line, length, reply.text);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not create inline comment: ${(err as Error).message}`);
      return;
    }
    // Track the thread VS Code created for the input so the rebuild below replaces it instead of duplicating it.
    if (!this.threads.includes(reply.thread)) {
      this.threads.push(reply.thread);
    }
    await this.store.addPending({ path: relPath, line, length, content: reply.text, dateCreated: Date.now() / 1000 });
  }

  dispose(): void {
    for (const t of this.threads) {
      t.dispose();
    }
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.controller.dispose();
  }
}
