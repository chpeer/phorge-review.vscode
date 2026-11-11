import * as path from 'path';
import * as vscode from 'vscode';
import { Change, ChangeType, Diff, Revision } from './phab';
import { ReviewStore } from './store';

export type Node = CategoryNode | RevisionNode | DescriptionNode | DirectoryNode | FileNode;

/** Query bucket, like the GitHub extension's "Waiting For My Review" / "Created By Me" categories. */
export class CategoryNode extends vscode.TreeItem {
  constructor(label: string, readonly load: () => Promise<Revision[]>, expanded: boolean) {
    super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'category';
  }
}

export class RevisionNode extends vscode.TreeItem {
  constructor(readonly store: ReviewStore, readonly revision: Revision, readonly branch?: string) {
    super(revision.title, vscode.TreeItemCollapsibleState.None);
    const author = store.phab.userName(revision.authorPHID);
    const mine = revision.reviewers.find((r) => r.phid === store.me?.phid);
    this.description = `D${revision.id} · ${author}${branch ? ` · ${branch}` : ''}${mine && mine.status !== 'added' ? ` · you: ${mine.status}` : ''}`;
    this.tooltip = `D${revision.id} ${revision.title}\n${author} · ${revision.statusName}`;
    this.iconPath = statusIcon(revision);
    this.contextValue = store.active?.revision.id === revision.id ? 'revision:active' : 'revision';
    this.command = { command: 'phabreview.openDescription', title: 'Open Description', arguments: [revision.id] };
  }
}

export class DescriptionNode extends vscode.TreeItem {
  constructor(readonly revision: Revision) {
    super('Description', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('git-pull-request');
    this.contextValue = 'description';
    this.command = { command: 'phabreview.openDescription', title: 'Open Description', arguments: [revision.id] };
  }
}

export class DirectoryNode extends vscode.TreeItem {
  children: Array<DirectoryNode | FileNode> = [];
  private readonly byName = new Map<string, DirectoryNode>();

  constructor(readonly store: ReviewStore, readonly diff: Diff, public name: string) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = vscode.ThemeIcon.Folder;
    this.contextValue = 'directory';
  }

  add(segments: string[], file: FileNode): void {
    if (segments.length === 1) {
      this.children.push(file);
      return;
    }
    let dir = this.byName.get(segments[0]);
    if (!dir) {
      dir = new DirectoryNode(this.store, this.diff, segments[0]);
      this.byName.set(segments[0], dir);
      this.children.push(dir);
    }
    dir.add(segments.slice(1), file);
  }

  /** Collapses single-child directory chains and sorts directories before files. */
  finalize(): void {
    for (const c of this.children) {
      if (c instanceof DirectoryNode) {
        c.finalize();
      }
    }
    while (this.children.length === 1 && this.children[0] instanceof DirectoryNode) {
      const only = this.children[0];
      this.name = this.name ? `${this.name}/${only.name}` : only.name;
      this.children = only.children;
    }
    this.label = this.name;
    this.children.sort((a, b) => {
      const dirA = a instanceof DirectoryNode ? 0 : 1;
      const dirB = b instanceof DirectoryNode ? 0 : 1;
      return dirA - dirB || String(a.label).localeCompare(String(b.label));
    });
    const files = this.allFiles();
    const viewed = this.store.viewedFiles(this.diff);
    const allViewed = files.length > 0 && files.every((f) => viewed.has(f.change.currentPath));
    this.checkboxState = allViewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
  }

  allFiles(): FileNode[] {
    return this.children.flatMap((c) => (c instanceof DirectoryNode ? c.allFiles() : [c]));
  }
}

export class FileNode extends vscode.TreeItem {
  constructor(readonly store: ReviewStore, readonly diff: Diff, readonly change: Change, showDirectory: boolean) {
    super(path.basename(change.currentPath), vscode.TreeItemCollapsibleState.None);
    const viewed = store.viewedFiles(diff).has(change.currentPath);
    // The query carries the change type for the file decoration provider; the path keeps file icons working.
    this.resourceUri = store.fileUri(change.currentPath).with({ query: `phabreview=${change.type}&diff=${diff.id}` });
    const dir = path.dirname(change.currentPath);
    this.description = showDirectory && dir !== '.' ? dir : undefined;
    this.tooltip = `${change.currentPath}\n${typeLabel(change.type)} +${change.addLines} −${change.delLines}`;
    this.iconPath = vscode.ThemeIcon.File;
    this.contextValue = `file:${viewed ? 'viewed' : 'unviewed'}`;
    this.checkboxState = viewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    this.command = { command: 'phabreview.openFile', title: 'Open', arguments: [change.currentPath] };
  }
}

export function typeLabel(type: ChangeType): string {
  switch (type) {
    case ChangeType.Add:
      return 'Added';
    case ChangeType.Delete:
      return 'Deleted';
    case ChangeType.MoveHere:
      return 'Renamed';
    case ChangeType.CopyHere:
      return 'Copied';
    case ChangeType.MoveAway:
      return 'Moved away';
    default:
      return 'Modified';
  }
}

function statusIcon(revision: Revision): vscode.ThemeIcon {
  switch (revision.status) {
    case 'accepted':
      return new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('testing.iconPassed'));
    case 'needs-revision':
      return new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('testing.iconFailed'));
    case 'draft':
      return new vscode.ThemeIcon('git-pull-request-draft');
    case 'abandoned':
      return new vscode.ThemeIcon('git-pull-request-closed');
    case 'published':
      return new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('pullRequests.merged'));
    default:
      return new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('pullRequests.open'));
  }
}

/** Builds the changed files of a diff as a tree or flat list. */
export function fileNodes(store: ReviewStore, diff: Diff): Array<DirectoryNode | FileNode> {
  const layout = vscode.workspace.getConfiguration('phabreview').get<string>('fileListLayout', 'tree');
  const changes = diff.changes.filter((c) => c.type !== ChangeType.MoveAway);
  if (layout === 'flat') {
    return changes.map((c) => new FileNode(store, diff, c, true));
  }
  const root = new DirectoryNode(store, diff, '');
  for (const c of changes) {
    root.add(c.currentPath.split('/'), new FileNode(store, diff, c, false));
  }
  root.finalize();
  return root.name === '' ? root.children : [root];
}

export class RevisionsTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Query results by key; store changes re-render from here, only refresh() queries Conduit again. */
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(private readonly store: ReviewStore) {
    store.onDidChange((change) => {
      if (change === 'pending' || change === 'viewed') {
        return;
      }
      if (change === 'checkout') {
        this.cache.delete('branches');
        this.cache.delete('local');
      }
      this.emitter.fire(undefined);
    });
  }

  refresh(): void {
    this.cache.clear();
    this.emitter.fire(undefined);
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    let result = this.cache.get(key) as Promise<T> | undefined;
    if (!result) {
      result = load();
      this.cache.set(key, result);
      result.catch(() => this.cache.delete(key));
    }
    return result;
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    const store = this.store;
    if (!element) {
      const me = store.me ?? (store.me = await store.phab.whoami());
      const branches = () => this.cached('branches', () => store.localRevisionBranches());
      const toReview = () => this.cached('toReview', () => store.phab.revisionsToReview(me.phid));
      const acceptedByMe = (r: Revision) => r.reviewers.some((x) => x.phid === me.phid && x.status === 'accepted');
      return [
        new CategoryNode('Local Revision Branches', () => this.cached('local', async () => {
          const ids = [...new Set((await branches()).map((b) => b.revisionID))];
          const revisions = await Promise.all(ids.map((id) => store.phab.revision(id).catch(() => undefined)));
          return revisions.filter((r): r is Revision => r !== undefined);
        }), false),
        new CategoryNode('Waiting For My Review', async () => (await toReview()).filter((r) => !acceptedByMe(r)), true),
        new CategoryNode('Reviewed By Me', async () => (await toReview()).filter(acceptedByMe), false),
        new CategoryNode('Created By Me', () => this.cached('authored', () => store.phab.revisionsAuthored(me.phid)), false),
      ];
    }
    if (element instanceof CategoryNode) {
      const revisions = await element.load();
      await store.phab.resolveUsers(revisions.map((r) => r.authorPHID));
      const branches = element.label === 'Local Revision Branches' ? await this.cached('branches', () => store.localRevisionBranches()) : [];
      return revisions.map((r) => new RevisionNode(store, r, branches.find((b) => b.revisionID === r.id)?.branch));
    }
    return [];
  }
}

/**
 * "Changes in D123": the active revision's description and files, like the GitHub extension's review-mode view.
 * Empty until the revision is checked out, so the view's welcome content offers the checkout instead.
 */
export class ChangesTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: ReviewStore) {
    store.onDidChange(() => this.emitter.fire(undefined));
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    const active = this.store.active;
    if (!active || !this.store.checkedOut) {
      return [];
    }
    if (!element) {
      return [new DescriptionNode(active.revision), ...fileNodes(this.store, active.diff)];
    }
    if (element instanceof DirectoryNode) {
      return element.children;
    }
    return [];
  }
}

/** Handles the viewed checkboxes of both trees. */
export function onCheckboxChange(store: ReviewStore, e: vscode.TreeCheckboxChangeEvent<Node>): void {
  for (const [node, state] of e.items) {
    const files = node instanceof DirectoryNode ? node.allFiles() : node instanceof FileNode ? [node] : [];
    if (files.length > 0) {
      void store.setViewed(files[0].diff, files.map((f) => f.change.currentPath), state === vscode.TreeItemCheckboxState.Checked);
    }
  }
}
