import * as vscode from 'vscode';
import { ChangeType, Diff } from './phab';
import { ReviewStore } from './store';

export const BASE_SCHEME = 'phabreview-base';

/** Left side of a file's diff editor; the diff ID travels in the query. The right side is the checked-out file. */
export function baseUri(diff: Diff, relPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${relPath}`, query: `diff=${diff.id}` });
}

/** Right side of a deleted file's diff editor, as the file no longer exists in the working tree. */
export function emptyUri(relPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${relPath}`, query: 'empty' });
}

/** Serves the base (pre-change) contents of the active diff's files. */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly store: ReviewStore) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const diff = this.store.active?.diff;
    const diffID = Number(new URLSearchParams(uri.query).get('diff'));
    if (!diff || diff.id !== diffID) {
      return '';
    }
    const relPath = uri.path.replace(/^\//, '');
    const change = diff.changes.find((c) => c.currentPath === relPath);
    if (change?.type === ChangeType.Add) {
      return '';
    }
    return (await this.store.git.showFile(diff.baseCommit, change?.oldPath ?? relPath)) ?? '';
  }
}
