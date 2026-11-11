import * as vscode from 'vscode';
import { escapeHtml, InlineComment, Revision, TimelineEntry } from './phab';
import { ActiveReview, ReviewStore } from './store';

const ACTION_LABELS: Record<string, string> = {
  comment: 'commented',
  accept: 'accepted this revision',
  reject: 'requested changes',
  'request-changes': 'requested changes',
  'request-review': 'requested review',
  update: 'updated the diff',
  'plan-changes': 'planned changes',
  abandon: 'abandoned this revision',
  close: 'closed this revision',
  commandeer: 'commandeered this revision',
  resign: 'resigned as reviewer',
  reclaim: 'reclaimed this revision',
  reviewers: 'changed reviewers',
  inline: 'added inline comments',
};

const REVIEWER_ICONS: Record<string, [string, string]> = {
  accepted: ['✓', 'approved'],
  rejected: ['✗', 'changes'],
  commented: ['💬', 'commented'],
  blocking: ['●', 'requested'],
  added: ['●', 'requested'],
  resigned: ['–', ''],
};

type Message =
  | { command: 'checkout' | 'exitReviewMode' | 'refresh' | 'openInBrowser' | 'openDescription' }
  | { command: 'submit'; action: 'comment' | 'accept' | 'reject'; text: string }
  | { command: 'openFile'; path: string; line: number };

function statusColor(revision: Revision): string {
  if (revision.isDraft || revision.status === 'draft') {
    return 'grey';
  }
  switch (revision.status) {
    case 'accepted':
      return 'green';
    case 'needs-revision':
    case 'abandoned':
      return 'red';
    case 'published':
      return 'purple';
    default:
      return 'blue';
  }
}

/** Shared overview renderer: full two-column layout for the editor panel, single column for the sidebar view. */
export class OverviewRenderer {
  /** Remarkup rendered for the current `store.active`, which is replaced whenever the revision is (re)loaded. */
  private remarkup: { active: ActiveReview; html: Promise<string[]> } | undefined;

  constructor(private readonly store: ReviewStore) {}

  private renderRemarkup(active: ActiveReview): Promise<string[]> {
    if (this.remarkup?.active !== active) {
      const { revision, timeline } = active;
      const phab = this.store.phab;
      const inlineTexts = timeline.flatMap((t) => t.inlines.flatMap((i) => i.comments.map((c) => c.content)));
      const html = phab.renderRemarkup([revision.summary, revision.testPlan, ...timeline.map((t) => t.comment ?? ''), ...inlineTexts]).then((r) => r.map((h) => absolutizeLinks(h, phab.host)));
      this.remarkup = { active, html };
    }
    return this.remarkup.html;
  }

  private avatar(phid: string | undefined, size = 20): string {
    const user = phid ? this.store.phab.user(phid) : undefined;
    const name = phid ? this.store.phab.userName(phid) : 'me';
    return user?.image
      ? `<img class="avatar" width="${size}" height="${size}" src="${escapeHtml(user.image)}" alt="" title="${escapeHtml(user.realName)}">`
      : `<span class="avatar avatar-fallback" style="width:${size}px;height:${size}px">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
  }

  private when(epoch: number): string {
    return `<span class="when" title="${new Date(epoch * 1000).toLocaleString()}">${relativeTime(epoch)}</span>`;
  }

  async render(compact: boolean): Promise<string> {
    const active = this.store.active;
    if (!active) {
      return shell(compact, this.store.submissions, '<p class="empty">No revision selected. Pick one in the Phabricator view or run <b>Phabricator: Open Revision…</b></p>');
    }
    const { revision, diff, timeline } = active;
    const phab = this.store.phab;
    const author = phab.userName(revision.authorPHID);
    const rendered = await this.renderRemarkup(active);
    const [summary, testPlan] = rendered;
    const eventHtml = rendered.slice(2, 2 + timeline.length);
    const inlineHtml = rendered.slice(2 + timeline.length);
    let inlineIdx = 0;

    const header = `
      <div id="title" class="title"><div class="details">
        <h2><span class="title-text">${escapeHtml(revision.title)}</span> <a class="pr-number" href="${escapeHtml(revision.uri)}">D${revision.id}</a></h2>
        <div class="subtitle">
          <div class="status-badge status-badge-${statusColor(revision)}">${escapeHtml(revision.statusName)}</div>
          <div class="author">${this.avatar(revision.authorPHID)}
            <span><b>${escapeHtml(author)}</b> wants to land into <code class="branch-tag">${escapeHtml(diff.onto ?? 'master')}</code>${diff.branch ? ` from <code class="branch-tag">${escapeHtml(diff.branch)}</code>` : ''}</span>
          </div>
        </div>
        <div class="header-actions">
          ${this.store.checkedOut
            ? `<button class="checkedOut" data-cmd="exitReviewMode" title="Switch back to your previous branch">✓ Checked Out · Exit Review Mode</button>`
            : `<button data-cmd="checkout" title="Create a local branch with this diff applied">Check Out</button>`}
          ${compact ? '<button class="secondary" data-cmd="openDescription" title="Open the full overview in an editor tab">Open Overview</button>' : ''}
          <button class="secondary" data-cmd="refresh">Refresh</button>
          <button class="secondary" data-cmd="openInBrowser">Open in Browser</button>
        </div>
      </div></div>`;

    const description = `
      <div class="comment-container">
        <div class="review-comment-header">${this.avatar(revision.authorPHID)} <b>${escapeHtml(author)}</b>&nbsp;created this revision ${this.when(revision.dateCreated)}</div>
        <div class="comment-body">${summary || '<i>No description provided.</i>'}</div>
        ${testPlan ? `<div class="comment-section"><div class="section-label">Test Plan</div><div class="comment-body">${testPlan}</div></div>` : ''}
      </div>`;

    const events = timeline
      .map((t, i) => this.event(t, eventHtml[i], () => inlineHtml[inlineIdx++]))
      .join('');

    const pendingCount = this.store.pending.length;
    const form = `
      <form id="comment-form" class="comment-form">
        <textarea id="comment-text" placeholder="Leave a comment (Remarkup)" rows="${compact ? 4 : 6}"></textarea>
        <div class="form-actions">
          <span class="pending-note">${pendingCount > 0 ? `${pendingCount} pending inline comment${pendingCount === 1 ? '' : 's'} will be published` : ''}</span>
          <button type="button" class="secondary" data-action="reject">Request Changes</button>
          <button type="button" class="secondary" data-action="accept">Accept</button>
          <button type="button" data-action="comment">Comment</button>
        </div>
      </form>`;

    const reviewers = revision.reviewers.length === 0
      ? '<div class="section-placeholder">None yet</div>'
      : revision.reviewers.map((r) => {
          const [icon, cls] = REVIEWER_ICONS[r.status] ?? ['●', ''];
          return `<div class="section-item reviewer">
            <div class="avatar-with-author">${this.avatar(r.phid)} <span>${escapeHtml(phab.userName(r.phid))}${r.isBlocking ? ' <span class="blocking">blocking</span>' : ''}</span></div>
            <span class="section-icon ${cls}" title="${escapeHtml(r.status)}">${icon}</span>
          </div>`;
        }).join('');
    const sidebar = `
      <div id="sidebar">
        <div class="section"><div class="section-header"><div class="section-title">Reviewers</div></div>${reviewers}</div>
        ${revision.jiraIssues.length > 0 ? `<div class="section"><div class="section-header"><div class="section-title">Jira</div></div>${revision.jiraIssues.map((j) => `<div class="section-item">${escapeHtml(j)}</div>`).join('')}</div>` : ''}
        <div class="section"><div class="section-header"><div class="section-title">Diff</div></div>
          <div class="section-item">Diff ${diff.id} · ${diff.changes.length} file${diff.changes.length === 1 ? '' : 's'}</div>
          <div class="section-item">Base <code>${escapeHtml(diff.baseCommit.slice(0, 10))}</code></div>
          ${this.store.checkedOut ? `<div class="section-item">Local <code>${escapeHtml(this.store.branchFor(diff))}</code></div>` : ''}
        </div>
      </div>`;

    return shell(compact, this.store.submissions, `<div id="app" class="${compact ? 'compact' : ''}">${header}<div id="main">${description}${events}${form}</div>${sidebar}</div>`);
  }

  private event(t: TimelineEntry, bodyHtml: string, nextInlineHtml: () => string): string {
    const author = this.store.phab.userName(t.authorPHID);
    const kind = t.type === 'accept' ? 'accept' : t.type === 'reject' || t.type === 'request-changes' ? 'reject' : t.type;
    const inlines = t.inlines.map((i) => this.inline(i, nextInlineHtml)).join('');
    const hasBody = Boolean(bodyHtml) || t.inlines.length > 0;
    if (!hasBody) {
      return `<div class="timeline-event ${kind}">${this.avatar(t.authorPHID, 16)} <b>${escapeHtml(author)}</b>&nbsp;${escapeHtml(ACTION_LABELS[t.type] ?? t.type)} ${this.when(t.dateCreated)}</div>`;
    }
    return `
      <div class="comment-container ${kind}">
        <div class="review-comment-header">${this.avatar(t.authorPHID)} <b>${escapeHtml(author)}</b>&nbsp;${escapeHtml(ACTION_LABELS[t.type] ?? t.type)} ${this.when(t.dateCreated)}</div>
        ${bodyHtml ? `<div class="comment-body">${bodyHtml}</div>` : ''}
        ${inlines}
      </div>`;
  }

  private inline(i: InlineComment, nextInlineHtml: () => string): string {
    const bodies = i.comments.map(() => nextInlineHtml()).join('');
    const outdated = i.diffID !== this.store.active?.diff.id;
    return `<div class="diff-container">
      <div class="resolved-container">
        <a class="diffPath" href="#" data-path="${escapeHtml(i.path)}" data-line="${i.line}">${escapeHtml(i.path)}:${i.line}</a>
        ${outdated ? '<span class="outdatedLabel">Outdated</span>' : ''}
        ${i.isDone ? '<span class="doneLabel">Done</span>' : ''}
      </div>
      <div class="comment-body inline-body">${bodies}</div>
    </div>`;
  }
}

function relativeTime(epoch: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - epoch);
  const units: Array<[number, string]> = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

function absolutizeLinks(html: string, host: string): string {
  return html.replace(/href="\/(?!\/)/g, `href="${host}`).replace(/src="\/(?!\/)/g, `src="${host}`);
}

/** `submissions` lets the page drop a saved comment draft once a review was submitted successfully. */
function shell(compact: boolean, submissions: number, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 ${compact ? '8px' : '24px'} 24px; line-height: 1.5; }
    #app { display: grid; grid-template-columns: minmax(0, 1fr) minmax(200px, 300px); column-gap: 32px; }
    #app.compact, #app.narrow { grid-template-columns: minmax(0, 1fr); column-gap: 0; }
    #title { grid-column: 1 / 3; } #main { grid-column: 1; display: flex; flex-direction: column; gap: 16px; } #sidebar { grid-column: 2; display: flex; flex-direction: column; gap: 16px; }
    #app.compact #title, #app.narrow #title, #app.compact #main, #app.narrow #main, #app.compact #sidebar, #app.narrow #sidebar { grid-column: 1; }
    .title { margin: 20px 0 24px; padding-bottom: 20px; border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground); }
    .compact .title { margin: 8px 0 12px; padding-bottom: 12px; }
    h2 { margin: 0 0 8px; font-size: ${compact ? '1.1em' : '1.5em'}; font-weight: 600; line-height: 1.3; }
    h2 .pr-number { font-weight: 300; color: var(--vscode-descriptionForeground); margin-left: 5px; text-decoration: none; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; } a:hover { text-decoration: underline; }
    .subtitle { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .status-badge { padding: 3px 10px; border-radius: 16px; font-size: 12px; font-weight: 600; color: #fff; white-space: nowrap; }
    .status-badge-green { background: #238636; } .status-badge-blue { background: #1f6feb; } .status-badge-red { background: #da3633; } .status-badge-purple { background: #8250df; } .status-badge-grey { background: #6e7681; }
    .author { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); }
    .author b { color: var(--vscode-foreground); }
    .avatar { border-radius: 50%; vertical-align: middle; flex-shrink: 0; }
    .avatar-fallback { display: inline-flex; align-items: center; justify-content: center; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; font-weight: 600; }
    code, .branch-tag { font-family: var(--vscode-editor-font-family); font-size: 0.95em; background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 1px 5px; }
    .branch-tag { color: var(--vscode-textLink-foreground); }
    .header-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border, transparent); padding: 4px 12px; border-radius: 2px; cursor: pointer; font-family: inherit; font-size: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.checkedOut { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .comment-container { border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-editor-background); }
    .comment-container.accept { border-color: #238636; } .comment-container.reject { border-color: #da3633; }
    .review-comment-header { display: flex; align-items: center; gap: 6px; padding: 8px 16px; background: var(--vscode-panel-background, var(--vscode-sideBar-background)); border-bottom: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); border-radius: 6px 6px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .accept .review-comment-header { background: rgba(35,134,54,0.15); } .reject .review-comment-header { background: rgba(218,54,51,0.15); }
    .when { color: var(--vscode-descriptionForeground); margin-left: auto; font-size: 0.92em; }
    .comment-body { padding: 12px 16px; overflow-wrap: anywhere; }
    .comment-body p { margin: 0 0 8px; } .comment-body p:last-child { margin-bottom: 0; } .comment-body ul, .comment-body ol { padding-left: 22px; margin: 4px 0; }
    .comment-body pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; }
    .comment-body blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border); margin: 4px 0; padding: 2px 10px; color: var(--vscode-descriptionForeground); }
    .comment-body tt { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
    .comment-section { border-top: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); }
    .section-label { padding: 8px 16px 0; font-weight: 600; font-size: 0.9em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .timeline-event { display: flex; align-items: center; gap: 6px; padding: 0 16px; color: var(--vscode-descriptionForeground); font-size: 0.95em; }
    .timeline-event b { color: var(--vscode-foreground); }
    .diff-container { border-top: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); }
    .resolved-container { display: flex; align-items: center; gap: 8px; padding: 6px 16px; background: var(--vscode-panel-background, var(--vscode-sideBar-background)); font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
    .diffPath { color: var(--vscode-textLink-foreground); }
    .outdatedLabel, .doneLabel, .blocking { font-family: var(--vscode-font-family); font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--vscode-descriptionForeground); color: var(--vscode-descriptionForeground); }
    .doneLabel { border-color: #238636; color: #238636; } .blocking { border-color: #d29922; color: #d29922; }
    .inline-body { padding-top: 8px; padding-bottom: 8px; }
    .comment-form { display: flex; flex-direction: column; gap: 8px; }
    textarea { width: 100%; box-sizing: border-box; resize: vertical; font-family: inherit; font-size: inherit; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
    textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    .form-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; flex-wrap: wrap; }
    .pending-note { margin-right: auto; color: var(--vscode-descriptionForeground); font-style: italic; }
    .section { border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground); padding-bottom: 12px; }
    .section-header { display: flex; align-items: center; margin-bottom: 6px; } .section-title { font-weight: 600; }
    .section-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; }
    .avatar-with-author { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .section-icon { font-size: 12px; } .section-icon.approved { color: #238636; } .section-icon.changes { color: #da3633; } .section-icon.requested { color: var(--vscode-descriptionForeground); }
    .section-placeholder, .empty { color: var(--vscode-descriptionForeground); }
    .busy { opacity: 0.6; pointer-events: none; }
  </style></head><body data-submissions="${submissions}">${body}
  <script>
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const fit = () => { if (app && !app.classList.contains('compact')) { app.classList.toggle('narrow', window.innerWidth < 768); } };
    fit(); window.addEventListener('resize', fit);
    const submissions = Number(document.body.dataset.submissions);
    const saved = vscode.getState(); const textarea = document.getElementById('comment-text');
    if (textarea && saved && saved.text && saved.submissions === submissions) { textarea.value = saved.text; }
    if (textarea) { textarea.addEventListener('input', () => vscode.setState({ text: textarea.value, submissions })); }
    window.addEventListener('message', (e) => { if (e.data.command === 'submitDone') { document.getElementById('comment-form')?.classList.remove('busy'); } });
    document.addEventListener('click', (e) => {
      const cmd = e.target.closest('button[data-cmd]');
      if (cmd) { vscode.postMessage({ command: cmd.dataset.cmd }); return; }
      const action = e.target.closest('button[data-action]');
      if (action && textarea) {
        document.getElementById('comment-form').classList.add('busy');
        vscode.postMessage({ command: 'submit', action: action.dataset.action, text: textarea.value });
        return;
      }
      const path = e.target.closest('a.diffPath');
      if (path) { e.preventDefault(); vscode.postMessage({ command: 'openFile', path: path.dataset.path, line: Number(path.dataset.line) }); }
    });
    if (textarea) { textarea.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { document.querySelector('button[data-action="comment"]').click(); } }); }
  </script></body></html>`;
}

/** Routes webview messages to the extension commands. */
export function handleMessage(webview: vscode.Webview, msg: Message): void {
  switch (msg.command) {
    case 'submit':
      // A successful submit re-renders the page; after a failure the unchanged page has to leave its busy state.
      void vscode.commands.executeCommand('phabreview.submitReview', msg.action, msg.text).then(() => webview.postMessage({ command: 'submitDone' }));
      break;
    case 'openFile':
      void vscode.commands.executeCommand('phabreview.openFile', msg.path, msg.line);
      break;
    default:
      void vscode.commands.executeCommand(`phabreview.${msg.command}`);
  }
}

/** Editor-tab overview of the active revision, like the GitHub extension's pull request description page. */
export class OverviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly store: ReviewStore, private readonly renderer: OverviewRenderer) {
    // The overview does not show viewed state; re-rendering would reload the page and lose its scroll position.
    this.subscriptions.push(store.onDidChange((change) => change !== 'viewed' && void this.update()));
  }

  async show(): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('phabreview.overview', 'Revision', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.panel.iconPath = new vscode.ThemeIcon('git-pull-request');
      const webview = this.panel.webview;
      webview.onDidReceiveMessage((msg: Message) => handleMessage(webview, msg));
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else {
      this.panel.reveal();
    }
    await this.update();
  }

  private async update(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const rev = this.store.active?.revision;
    this.panel.title = rev ? `D${rev.id}: ${rev.title}` : 'Revision';
    this.panel.webview.html = await this.renderer.render(false);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }
}

/** Sidebar view with the compact overview and comment form, like the GitHub extension's "Active Pull Request" view. */
export class ActiveRevisionView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly store: ReviewStore, private readonly renderer: OverviewRenderer) {
    store.onDidChange((change) => change !== 'viewed' && void this.update());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: Message) => handleMessage(view.webview, msg));
    void this.update();
  }

  private async update(): Promise<void> {
    if (!this.view) {
      return;
    }
    const rev = this.store.active?.revision;
    this.view.title = rev ? `D${rev.id}` : 'Active Revision';
    this.view.webview.html = await this.renderer.render(true);
  }
}
