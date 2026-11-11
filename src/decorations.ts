import * as vscode from 'vscode';
import { addedRanges, changeAnchors, mapHunks } from './diffParse';
import { ReviewStore } from './store';

/** Highlights added lines and marks removed blocks in editors showing files of the active diff. */
export class ChangeDecorator implements vscode.Disposable {
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('phabreview.addedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('phabreview.addedLineBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('phabreview.removedLineMarker'),
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
    overviewRulerColor: new vscode.ThemeColor('phabreview.removedLineMarker'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removedAtEnd = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('phabreview.removedLineMarker'),
    borderStyle: 'solid',
    borderWidth: '0 0 2px 0',
  });
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly store: ReviewStore) {
    this.subscriptions.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
      vscode.workspace.onDidChangeTextDocument((e) => this.decorateDocument(e.document)),
      store.onDidChange(() => this.decorateAll()),
    );
    this.decorateAll();
  }

  decorateAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.decorate(editor);
    }
  }

  private decorateDocument(document: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) {
        this.decorate(editor);
      }
    }
  }

  /** Line map for the document, or undefined when the document does not show the diff's new content. */
  lineMap(document: vscode.TextDocument) {
    const change = this.changeFor(document);
    return change ? mapHunks(change.hunks) : undefined;
  }

  /** The change shown by a document: a clean checked-out workspace file of the active diff. */
  changeFor(document: vscode.TextDocument) {
    return this.store.checkedOut && !document.isDirty ? this.store.changeFor(document.uri) : undefined;
  }

  anchors(document: vscode.TextDocument): number[] {
    const map = this.lineMap(document);
    return map ? changeAnchors(map) : [];
  }

  private decorate(editor: vscode.TextEditor): void {
    const map = isDiffSide(editor) ? undefined : this.lineMap(editor.document);
    if (!map) {
      editor.setDecorations(this.added, []);
      editor.setDecorations(this.removed, []);
      editor.setDecorations(this.removedAtEnd, []);
      return;
    }
    const lineCount = editor.document.lineCount;
    const clamp = (line: number) => Math.min(Math.max(line, 1), lineCount) - 1;
    editor.setDecorations(
      this.added,
      addedRanges(map.added).map(([start, end]) => new vscode.Range(clamp(start), 0, clamp(end), 0)),
    );
    const removed: vscode.DecorationOptions[] = [];
    const removedAtEnd: vscode.DecorationOptions[] = [];
    for (const block of map.removed) {
      const hover = new vscode.MarkdownString();
      hover.appendMarkdown(`**Removed ${block.lines.length} line${block.lines.length === 1 ? '' : 's'}**\n\n`);
      hover.appendCodeblock(block.lines.map((l) => `- ${l}`).join('\n'), 'diff');
      const option = { range: new vscode.Range(clamp(block.beforeNewLine), 0, clamp(block.beforeNewLine), 0), hoverMessage: hover };
      (block.beforeNewLine > lineCount ? removedAtEnd : removed).push(option);
    }
    editor.setDecorations(this.removed, removed);
    editor.setDecorations(this.removedAtEnd, removedAtEnd);
  }

  dispose(): void {
    this.added.dispose();
    this.removed.dispose();
    this.removedAtEnd.dispose();
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }
}

/** True when the editor is the right side of a diff editor, which highlights the changes itself. */
function isDiffSide(editor: vscode.TextEditor): boolean {
  const tab = vscode.window.tabGroups.all.find((g) => g.viewColumn === editor.viewColumn)?.activeTab;
  return tab?.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === editor.document.uri.toString();
}
