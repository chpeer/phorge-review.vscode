import { Conduit } from './conduit';
import { Hunk } from './diffParse';

export interface Reviewer {
  phid: string;
  status: string;
  isBlocking: boolean;
}

export interface Revision {
  id: number;
  phid: string;
  title: string;
  summary: string;
  testPlan: string;
  status: string;
  statusName: string;
  closed: boolean;
  authorPHID: string;
  diffPHID: string;
  uri: string;
  isDraft: boolean;
  dateCreated: number;
  dateModified: number;
  reviewers: Reviewer[];
  jiraIssues: string[];
}

/** Phabricator DifferentialChangeType constants. */
export enum ChangeType {
  Add = 1,
  Change = 2,
  Delete = 3,
  MoveAway = 4,
  CopyAway = 5,
  MoveHere = 6,
  CopyHere = 7,
  MultiCopy = 8,
  Message = 9,
  Child = 10,
}

export interface Change {
  oldPath: string | null;
  currentPath: string;
  type: ChangeType;
  addLines: number;
  delLines: number;
  hunks: Hunk[];
}

export interface Diff {
  id: number;
  phid: string;
  revisionID: number;
  baseCommit: string;
  branch: string | null;
  onto: string | null;
  changes: Change[];
}

export interface InlineReply {
  phid: string;
  authorPHID: string;
  dateCreated: number;
  content: string;
}

export interface InlineComment {
  transactionID: number;
  phid: string;
  authorPHID: string;
  dateCreated: number;
  /** Transactions published together share a groupID. */
  groupID: string;
  diffID: number;
  path: string;
  /** 1-based line in the new file. */
  line: number;
  length: number;
  isDone: boolean;
  replyToCommentPHID: string | null;
  comments: InlineReply[];
}

export interface TimelineEntry {
  type: string;
  authorPHID: string;
  dateCreated: number;
  groupID: string;
  comment: string | null;
  /** Inline comments published together with this entry. */
  inlines: InlineComment[];
}

export interface User {
  phid: string;
  userName: string;
  realName: string;
  image?: string;
}

interface SearchResult<T> {
  data: T[];
  cursor: { after: string | null };
}

interface RevisionRecord {
  id: number;
  phid: string;
  fields: {
    title: string;
    summary: string;
    testPlan: string;
    status: { value: string; name: string; closed: boolean };
    authorPHID: string;
    diffPHID: string;
    uri: string;
    isDraft: boolean;
    dateCreated: number;
    dateModified: number;
    'jira.issues'?: string[];
  };
  attachments: { reviewers?: { reviewers: Array<{ reviewerPHID: string; status: string; isBlocking: boolean }> } };
}

interface TransactionRecord {
  id: number;
  phid: string;
  type: string | null;
  authorPHID: string;
  dateCreated: number;
  groupID: string;
  comments: Array<{ phid: string; authorPHID: string; dateCreated: number; removed: boolean; content: { raw: string } }>;
  fields: {
    diff?: { id: number };
    path?: string;
    line?: number;
    length?: number;
    replyToCommentPHID?: string | null;
    isDone?: boolean;
  };
}

interface QueryDiffRecord {
  id: string;
  revisionID: string;
  sourceControlBaseRevision: string;
  branch: string | null;
  properties: { 'arc:onto'?: Array<{ type: string; name: string }> } | unknown[];
  changes: Array<{
    oldPath: string | null;
    currentPath: string;
    type: string;
    addLines: string;
    delLines: string;
    hunks: Array<{ oldOffset: string; newOffset: string; corpus: string }>;
  }>;
}

const TIMELINE_TYPES = ['comment', 'accept', 'reject', 'request-changes', 'request-review', 'update', 'plan-changes', 'abandon', 'close', 'commandeer', 'resign', 'reclaim', 'reviewers'];

function toRevision(record: RevisionRecord): Revision {
  const f = record.fields;
  return {
    id: record.id,
    phid: record.phid,
    title: f.title,
    summary: f.summary ?? '',
    testPlan: f.testPlan ?? '',
    status: f.status.value,
    statusName: f.status.name,
    closed: f.status.closed,
    authorPHID: f.authorPHID,
    diffPHID: f.diffPHID,
    uri: f.uri,
    isDraft: f.isDraft,
    dateCreated: f.dateCreated,
    dateModified: f.dateModified,
    reviewers: (record.attachments.reviewers?.reviewers ?? []).map((r) => ({
      phid: r.reviewerPHID,
      status: r.status,
      isBlocking: r.isBlocking,
    })),
    jiraIssues: f['jira.issues'] ?? [],
  };
}

export class Phabricator {
  private readonly users = new Map<string, User>();

  constructor(readonly conduit: Conduit) {}

  get host(): string {
    return this.conduit.host;
  }

  async whoami(): Promise<User> {
    const me = await this.conduit.call<User>('user.whoami', {});
    this.users.set(me.phid, me);
    return me;
  }

  private async searchRevisions(constraints: Record<string, unknown>, queryKey?: string, limit = 50): Promise<Revision[]> {
    const result = await this.conduit.call<SearchResult<RevisionRecord>>('differential.revision.search', {
      queryKey,
      constraints,
      attachments: { reviewers: true },
      order: 'updated',
      limit,
    });
    return result.data.map(toRevision);
  }

  async revision(id: number): Promise<Revision> {
    const [rev] = await this.searchRevisions({ ids: [id] });
    if (!rev) {
      throw new Error(`D${id} not found`);
    }
    return rev;
  }

  /** Active revisions where the user is a direct reviewer (not only via an owners package or project). */
  async revisionsToReview(mePHID: string): Promise<Revision[]> {
    const all = await this.searchRevisions({ reviewerPHIDs: [mePHID] }, 'active', 100);
    return all.filter((r) => r.reviewers.some((x) => x.phid === mePHID));
  }

  revisionsAuthored(mePHID: string): Promise<Revision[]> {
    return this.searchRevisions({ authorPHIDs: [mePHID] }, 'active');
  }

  async diff(diffPHID: string): Promise<Diff> {
    const search = await this.conduit.call<SearchResult<{ id: number; phid: string }>>('differential.diff.search', {
      constraints: { phids: [diffPHID] },
    });
    const id = search.data[0]?.id;
    if (!id) {
      throw new Error(`Diff ${diffPHID} not found`);
    }
    const byId = await this.conduit.call<Record<string, QueryDiffRecord>>('differential.querydiffs', { ids: [id] });
    const record = byId[String(id)];
    const onto = Array.isArray(record.properties) ? undefined : record.properties['arc:onto']?.find((o) => o.type === 'branch')?.name;
    return {
      id,
      phid: diffPHID,
      revisionID: Number(record.revisionID),
      baseCommit: record.sourceControlBaseRevision,
      branch: record.branch,
      onto: onto ?? null,
      changes: record.changes
        .filter((c) => Number(c.type) !== ChangeType.Message && Number(c.type) !== ChangeType.Child)
        .map((c) => ({
          oldPath: c.oldPath,
          currentPath: c.currentPath,
          type: Number(c.type) as ChangeType,
          addLines: Number(c.addLines),
          delLines: Number(c.delLines),
          hunks: c.hunks.map((h) => ({ oldOffset: Number(h.oldOffset), newOffset: Number(h.newOffset), corpus: h.corpus })),
        })),
    };
  }

  rawDiff(diffID: number): Promise<string> {
    return this.conduit.call<string>('differential.getrawdiff', { diffID });
  }

  async transactions(revisionID: number): Promise<{ inlines: InlineComment[]; timeline: TimelineEntry[] }> {
    const records: TransactionRecord[] = [];
    let after: string | null = null;
    do {
      const page: SearchResult<TransactionRecord> = await this.conduit.call('transaction.search', {
        objectIdentifier: `D${revisionID}`,
        limit: 100,
        after,
      });
      records.push(...page.data);
      after = page.cursor.after;
    } while (after);

    const inlines: InlineComment[] = [];
    const timeline: TimelineEntry[] = [];
    for (const r of records) {
      const comments = r.comments
        .filter((c) => !c.removed)
        .map((c) => ({ phid: c.phid, authorPHID: c.authorPHID, dateCreated: c.dateCreated, content: c.content.raw }));
      if (r.type === 'inline') {
        if (comments.length === 0 || !r.fields.path) {
          continue;
        }
        inlines.push({
          transactionID: r.id,
          phid: r.phid,
          authorPHID: r.authorPHID,
          dateCreated: r.dateCreated,
          groupID: r.groupID,
          diffID: r.fields.diff?.id ?? 0,
          path: r.fields.path,
          line: r.fields.line ?? 1,
          length: r.fields.length ?? 1,
          isDone: r.fields.isDone ?? false,
          replyToCommentPHID: r.fields.replyToCommentPHID ?? null,
          comments,
        });
      } else if (r.type && TIMELINE_TYPES.includes(r.type)) {
        timeline.push({ type: r.type, authorPHID: r.authorPHID, dateCreated: r.dateCreated, groupID: r.groupID, comment: comments[0]?.content ?? null, inlines: [] });
      }
    }
    inlines.sort((a, b) => a.dateCreated - b.dateCreated);
    timeline.sort((a, b) => a.dateCreated - b.dateCreated);
    // Attach inlines to the event they were published with; inlines without one get their own entry.
    for (const inline of inlines) {
      let host = timeline.find((t) => t.groupID === inline.groupID);
      if (!host) {
        host = { type: 'inline', authorPHID: inline.authorPHID, dateCreated: inline.dateCreated, groupID: inline.groupID, comment: null, inlines: [] };
        timeline.push(host);
      }
      host.inlines.push(inline);
    }
    timeline.sort((a, b) => a.dateCreated - b.dateCreated);
    return { inlines, timeline };
  }

  async resolveUsers(phids: Iterable<string>): Promise<Map<string, User>> {
    const missing = [...new Set(phids)].filter((p) => p.startsWith('PHID-USER-') && !this.users.has(p));
    if (missing.length > 0) {
      const result = await this.conduit.call<Array<{ phid: string; userName: string; realName: string; image: string }>>('user.query', { phids: missing });
      for (const u of result) {
        this.users.set(u.phid, { phid: u.phid, userName: u.userName, realName: u.realName, image: u.image });
      }
    }
    return this.users;
  }

  user(phid: string): User | undefined {
    return this.users.get(phid);
  }

  userName(phid: string): string {
    const u = this.users.get(phid);
    if (u) {
      return u.userName;
    }
    if (phid.startsWith('PHID-OPKG-')) {
      return 'owners package';
    }
    if (phid.startsWith('PHID-PROJ-')) {
      return 'project';
    }
    return phid;
  }

  /** Creates a draft inline comment; Phabricator publishes drafts with the next review submission. */
  async createInline(revisionID: number, filePath: string, lineNumber: number, lineLength: number, content: string): Promise<number> {
    const result = await this.conduit.call<{ id: number }>('differential.createinline', {
      revisionID,
      filePath,
      isNewFile: true,
      lineNumber,
      // Phabricator counts additional lines after the first.
      lineLength: Math.max(lineLength - 1, 0),
      content,
    });
    return result.id;
  }

  /**
   * Posts a review. Uses the legacy differential.createcomment call because its attach_inlines flag is the
   * only Conduit way to publish the viewer's draft inline comments; differential.revision.edit leaves them unpublished.
   */
  async submitReview(revisionID: number, action: 'comment' | 'accept' | 'reject', comment: string): Promise<void> {
    await this.conduit.call('differential.createcomment', {
      revision_id: revisionID,
      message: comment,
      action,
      attach_inlines: true,
    });
  }

  async renderRemarkup(texts: string[]): Promise<string[]> {
    if (texts.every((t) => !t.trim())) {
      return texts.map(() => '');
    }
    try {
      const result = await this.conduit.call<Array<{ content: string }>>('remarkup.process', { context: 'differential', contents: texts });
      return result.map((r) => r.content);
    } catch {
      return texts.map((t) => `<pre>${escapeHtml(t)}</pre>`);
    }
  }
}

/** Parses a revision ID from user input such as `D12345`, `12345` or a revision URL. */
export function parseRevisionID(input: string): number | undefined {
  const match = /\bD(\d+)\b/i.exec(input) ?? /^\s*(\d+)\s*$/.exec(input);
  return match ? Number(match[1]) : undefined;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
