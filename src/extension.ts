import * as vscode from 'vscode';
import { InlineComments } from './comments';
import { Conduit, resolveConduitConfig } from './conduit';
import { BASE_SCHEME, baseUri, DiffContentProvider, emptyUri } from './content';
import { ChangeDecorator } from './decorations';
import { ChangeFileDecorations } from './fileDecorations';
import { Git } from './git';
import { ActiveRevisionView, OverviewPanel, OverviewRenderer } from './overview';
import { ChangeType, parseRevisionID, Phabricator } from './phab';
import { ReviewStore } from './store';
import { ChangesTree, Node, onCheckboxChange, RevisionNode, RevisionsTree } from './trees';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return;
  }
  const config = vscode.workspace.getConfiguration('phabreview');
  const git = await findGitRepo(folders.map((f) => f.uri.fsPath));
  if (!git) {
    void vscode.window.showErrorMessage(`Phabricator Review: no workspace folder is inside a git repository (${folders.map((f) => f.uri.fsPath).join(', ')})`);
    return;
  }
  let phab: Phabricator;
  try {
    phab = new Phabricator(new Conduit(resolveConduitConfig(git.root, config.get<string>('host', ''))));
  } catch (err) {
    void vscode.window.showErrorMessage(`Phabricator Review: ${(err as Error).message}`);
    return;
  }

  const store = new ReviewStore(phab, git, context.workspaceState, config.get<string>('branchPrefix', 'phabreview/'));
  const content = new DiffContentProvider(store);
  const decorator = new ChangeDecorator(store);
  const comments = new InlineComments(store);
  const renderer = new OverviewRenderer(store);
  const overview = new OverviewPanel(store, renderer);
  const activeView = new ActiveRevisionView(store, renderer);
  const revisionsTree = new RevisionsTree(store);
  const changesTree = new ChangesTree(store);
  const revisionsView = vscode.window.createTreeView<Node>('phabreview.revisions', { treeDataProvider: revisionsTree, showCollapseAll: true });
  // Checkbox state is managed manually: VS Code's automatic parent/child propagation would report a directory as
  // unchecked when one of its files is, and onCheckboxChange would then mark every file in it as unviewed.
  const changesView = vscode.window.createTreeView<Node>('phabreview.changes', { treeDataProvider: changesTree, showCollapseAll: true, manageCheckboxStateManually: true });
  const statusBar = vscode.window.createStatusBarItem('phabreview.status', vscode.StatusBarAlignment.Left, 50);
  statusBar.name = 'Phabricator Active Revision';
  statusBar.command = 'phabreview.openDescription';

  const withProgress = <T>(title: string, task: () => Promise<T>) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
  const reportError = (err: unknown) => void vscode.window.showErrorMessage(`Phabricator: ${(err as Error).message}`);

  const syncUi = () => {
    const active = store.active;
    void vscode.commands.executeCommand('setContext', 'phabreview.checkedOut', store.checkedOut);
    changesView.title = active ? `Changes in D${active.revision.id}` : 'Changes';
    changesView.description = active ? (store.checkedOut ? 'checked out' : 'not checked out') : undefined;
    if (active) {
      statusBar.text = `$(git-pull-request) D${active.revision.id}`;
      statusBar.tooltip = `${active.revision.title}\n${store.checkedOut ? 'Checked out' : 'Not checked out'} · click for the overview`;
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };
  store.onDidChange(syncUi);

  const parseRevisionArg = (arg: unknown): number | undefined => {
    if (typeof arg === 'number') {
      return arg;
    }
    if (arg instanceof RevisionNode) {
      return arg.revision.id;
    }
    return undefined;
  };

  const selectRevision = async (id: number) => {
    if (store.active?.revision.id === id) {
      return true;
    }
    try {
      await withProgress(`Loading D${id}…`, () => store.open(id));
      return true;
    } catch (err) {
      reportError(err);
      return false;
    }
  };

  const openRevision = async (arg?: unknown) => {
    let id = parseRevisionArg(arg);
    if (id === undefined) {
      const input = await vscode.window.showInputBox({ prompt: 'Revision ID or URL (e.g. D12345)', value: typeof arg === 'string' ? arg : '' });
      if (!input) {
        return;
      }
      id = parseRevisionID(input);
      if (id === undefined) {
        return reportError(new Error(`Cannot parse revision from "${input}"`));
      }
    }
    if (!(await selectRevision(id))) {
      return;
    }
    await overview.show();
    void vscode.commands.executeCommand('phabreview.changes.focus');
    if (!store.checkedOut) {
      const choice = await vscode.window.showInformationMessage(
        `D${id} selected. Check out its diff to review the changes?`,
        'Check Out',
      );
      if (choice === 'Check Out') {
        await checkout();
      }
    }
  };

  const openDescription = async (arg?: unknown) => {
    const id = parseRevisionArg(arg) ?? store.active?.revision.id;
    if (id === undefined) {
      return openRevision();
    }
    if (await selectRevision(id)) {
      await overview.show();
    }
  };

  const checkout = async (arg?: unknown) => {
    const id = parseRevisionArg(arg);
    if (id !== undefined && !(await selectRevision(id))) {
      return;
    }
    try {
      await withProgress(`Checking out D${store.active?.revision.id}…`, () => store.checkout());
    } catch (err) {
      reportError(err);
    }
  };

  /** Opens a changed file of the active revision as a diff against its base, offering the checkout first if needed. */
  const openFile = async (relPath: string, line?: number) => {
    const active = store.active;
    const change = active?.diff.changes.find((c) => c.currentPath === relPath);
    if (!active || !change) {
      return void vscode.window.showInformationMessage('This file is not part of the selected revision.');
    }
    if (!store.checkedOut) {
      const choice = await vscode.window.showInformationMessage(`Check out D${active.revision.id} to review its changes.`, 'Check Out');
      if (choice !== 'Check Out') {
        return;
      }
      await checkout();
      if (!store.checkedOut) {
        return;
      }
    }
    const right = change.type === ChangeType.Delete ? emptyUri(relPath) : store.fileUri(relPath);
    // Without a selection the diff editor reveals the first change itself.
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (line) {
      options.selection = new vscode.Range(line - 1, 0, line - 1, 0);
    }
    await vscode.commands.executeCommand('vscode.diff', baseUri(active.diff, relPath), right, `${relPath} (D${active.revision.id})`, options);
  };

  /** Editor title action: shows the diff of the file in the active editor, at the cursor line. */
  const openDiffCommand = async (arg?: unknown) => {
    const editor = vscode.window.activeTextEditor;
    const uri = arg instanceof vscode.Uri ? arg : editor?.document.uri;
    const relPath = uri && store.relPath(uri);
    if (relPath) {
      await openFile(relPath, editor ? editor.selection.active.line + 1 : undefined);
    }
  };

  const jumpChange = async (direction: 1 | -1) => {
    const editor = vscode.window.activeTextEditor;
    const change = editor && decorator.changeFor(editor.document);
    if (!editor || !change) {
      return;
    }
    const current = editor.selection.active.line + 1;
    const anchors = decorator.anchors(editor.document);
    const target = direction === 1 ? anchors.find((a) => a > current) : [...anchors].reverse().find((a) => a < current);
    if (target !== undefined) {
      const pos = new vscode.Position(Math.min(target, editor.document.lineCount) - 1, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      return;
    }
    const diff = store.active?.diff;
    if (!diff) {
      return;
    }
    const files = diff.changes.filter((c) => c.type !== ChangeType.MoveAway && c.type !== ChangeType.Delete).map((c) => c.currentPath);
    const next = files[files.indexOf(change.currentPath) + direction];
    if (next) {
      await openFile(next);
    } else {
      void vscode.window.setStatusBarMessage(direction === 1 ? 'Phabricator: last change' : 'Phabricator: first change', 2000);
    }
  };

  const submitReview = async (action?: 'comment' | 'accept' | 'reject', text?: string) => {
    const active = store.active;
    if (!active) {
      return;
    }
    if (!action) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(comment) Comment', action: 'comment' as const, description: 'Publish pending inline comments with a comment' },
          { label: '$(check) Accept', action: 'accept' as const },
          { label: '$(request-changes) Request Changes', action: 'reject' as const },
        ],
        { title: `Review D${active.revision.id}` },
      );
      if (!picked) {
        return;
      }
      action = picked.action;
      text = await vscode.window.showInputBox({ title: `${picked.label.replace(/\$\([^)]*\)\s*/, '')} D${active.revision.id}`, prompt: 'Review comment (optional, Remarkup)', ignoreFocusOut: true });
      if (text === undefined) {
        return;
      }
    }
    try {
      await withProgress('Submitting review…', () => phab.submitReview(active.revision.id, action!, text ?? ''));
    } catch (err) {
      reportError(err);
      // The submit error is already reported; a failing refresh most likely has the same cause.
      await store.refresh().catch(() => undefined);
      return;
    }
    await store.markSubmitted(active.revision.id);
    revisionsTree.refresh();
    await store.refresh().catch(reportError);
  };

  const exitReviewMode = async () => {
    try {
      await store.exitReviewMode();
      await store.close();
    } catch (err) {
      reportError(err);
    }
  };

  context.subscriptions.push(
    decorator,
    comments,
    overview,
    revisionsView,
    changesView,
    statusBar,
    changesView.onDidChangeCheckboxState((e) => onCheckboxChange(store, e)),
    vscode.window.registerFileDecorationProvider(new ChangeFileDecorations()),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, content),
    vscode.window.registerWebviewViewProvider('phabreview.active', activeView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('phabreview.openRevision', openRevision),
    vscode.commands.registerCommand('phabreview.openDescription', openDescription),
    vscode.commands.registerCommand('phabreview.refresh', async () => {
      revisionsTree.refresh();
      await store.refresh().catch(reportError);
    }),
    vscode.commands.registerCommand('phabreview.checkout', checkout),
    vscode.commands.registerCommand('phabreview.exitReviewMode', exitReviewMode),
    vscode.commands.registerCommand('phabreview.openFile', openFile),
    vscode.commands.registerCommand('phabreview.openDiff', openDiffCommand),
    vscode.commands.registerCommand('phabreview.nextChange', () => jumpChange(1)),
    vscode.commands.registerCommand('phabreview.prevChange', () => jumpChange(-1)),
    vscode.commands.registerCommand('phabreview.submitReview', submitReview),
    vscode.commands.registerCommand('phabreview.openInBrowser', (arg?: unknown) => {
      const id = parseRevisionArg(arg);
      const uri = arg instanceof RevisionNode ? arg.revision.uri : store.active?.revision.uri;
      if (uri) {
        void vscode.env.openExternal(vscode.Uri.parse(uri));
      } else if (id) {
        void vscode.env.openExternal(vscode.Uri.parse(`${phab.host}D${id}`));
      }
    }),
    // Branch switches outside the extension (e.g. in a terminal) change whether decorations are valid.
    vscode.window.onDidChangeWindowState(async (s) => {
      if (s.focused && store.active) {
        await store.syncCheckoutState().catch(reportError);
      }
    }),
  );

  void vscode.commands.executeCommand('setContext', 'phabreview.hasRevision', false);
  syncUi();
  store.me = await phab.whoami().catch(() => undefined);
  await store.restore().catch(reportError);
}

async function findGitRepo(dirs: string[]): Promise<Git | undefined> {
  for (const dir of dirs) {
    try {
      return await Git.open(dir);
    } catch {
      // Not a git repository; try the next folder.
    }
  }
  return undefined;
}

export function deactivate(): void {}
