import * as vscode from 'vscode';
import { ChangeType } from './phab';

/** Adds the A/M/D/R badge and colour to file nodes, like the GitHub extension's tree decorations. */
export class ChangeFileDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const type = Number(new URLSearchParams(uri.query).get('phabreview'));
    if (!type) {
      return undefined;
    }
    switch (type as ChangeType) {
      case ChangeType.Add:
      case ChangeType.CopyHere:
        return new vscode.FileDecoration('A', 'Added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
      case ChangeType.Delete:
      case ChangeType.MoveAway:
        return new vscode.FileDecoration('D', 'Deleted', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
      case ChangeType.MoveHere:
        return new vscode.FileDecoration('R', 'Renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground'));
      default:
        return new vscode.FileDecoration('M', 'Modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
    }
  }
}
