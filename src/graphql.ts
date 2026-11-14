// GraphQL v4: a dependency-free tokenizer, parser and executor over the
// same store the REST surface uses. Supports queries and mutations, named
// operations, variables, aliases, named and inline fragments, __type and
// __schema introspection, cursor connections and batched documents.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, DEFAULT_BRANCH, Store, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, gid, ungid, type Issue, type Pull, type Repo } from './store.ts';
import { isRecord, parseJsonBody, readBody, requireAuth, sendJson } from './http-util.ts';

// ------------------------------------------------------------------ tokenizer

type TokenKind = 'brace-l' | 'brace-r' | 'paren-l' | 'paren-r' | 'bracket-l' | 'bracket-r' | 'colon' | 'bang' | 'equals' | 'dollar' | 'spread' | 'at' | 'name' | 'string' | 'int' | 'float' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{') { tokens.push({ kind: 'brace-l', value: ch }); i += 1; continue; }
    if (ch === '}') { tokens.push({ kind: 'brace-r', value: ch }); i += 1; continue; }
    if (ch === '(') { tokens.push({ kind: 'paren-l', value: ch }); i += 1; continue; }
    if (ch === ')') { tokens.push({ kind: 'paren-r', value: ch }); i += 1; continue; }
    if (ch === '[') { tokens.push({ kind: 'bracket-l', value: ch }); i += 1; continue; }
    if (ch === ']') { tokens.push({ kind: 'bracket-r', value: ch }); i += 1; continue; }
    if (ch === ':') { tokens.push({ kind: 'colon', value: ch }); i += 1; continue; }
    if (ch === '!') { tokens.push({ kind: 'bang', value: ch }); i += 1; continue; }
    if (ch === '=') { tokens.push({ kind: 'equals', value: ch }); i += 1; continue; }
    if (ch === '$') { tokens.push({ kind: 'dollar', value: ch }); i += 1; continue; }
    if (ch === '@') { tokens.push({ kind: 'at', value: ch }); i += 1; continue; }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1] as string;
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === 'r') out += '\r';
          else if (next === '"') out += '"';
          else if (next === '\\') out += '\\';
          else if (next === '/') out += '/';
          else if (next === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += next;
          j += 2;
          continue;
        }
        out += source[j] as string;
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'enum' | 'null'; value: string | number | boolean | null }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: Map<string, ValueNode>; selections: Selection[] }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: Selection[] };

interface VarDef {
  name: string;
  defaultValue?: ValueNode;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: VarDef[];
  selections: Selection[];
}

interface FragmentDef {
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expect(kind: TokenKind): Token {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`Expected ${kind}, found ${token.kind} (${token.value})`);
    return token;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'at') {
      this.next();
      this.expect('name');
      if (this.peek().kind === 'paren-l') this.parseArgs();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'brace-l') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        let varDefs: VarDef[] = [];
        if (this.peek().kind === 'paren-l') varDefs = this.parseVarDefs();
        this.skipDirectives();
        operations.push({ kind, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expect('name').value;
        this.expect('name'); // 'on'
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Unexpected token ${token.kind} (${token.value}) at document level`);
    }
    return { operations, fragments };
  }

  private parseVarDefs(): VarDef[] {
    this.expect('paren-l');
    const defs: VarDef[] = [];
    while (this.peek().kind !== 'paren-r') {
      this.expect('dollar');
      const name = this.expect('name').value;
      this.expect('colon');
      // Skip the type tokens (names, brackets, bangs) until '=' or ')'.
      while (this.peek().kind !== 'equals' && this.peek().kind !== 'paren-r' && this.peek().kind !== 'eof') this.next();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'equals') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expect('paren-r');
    return defs;
  }

  private parseArgs(): Map<string, ValueNode> {
    this.expect('paren-l');
    const args = new Map<string, ValueNode>();
    while (this.peek().kind !== 'paren-r') {
      const name = this.expect('name').value;
      this.expect('colon');
      args.set(name, this.parseValue());
    }
    this.expect('paren-r');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'dollar') return { kind: 'var', name: this.expect('name').value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'bracket-l') {
      const items: ValueNode[] = [];
      while (this.peek().kind !== 'bracket-r') items.push(this.parseValue());
      this.expect('bracket-r');
      return { kind: 'list', items };
    }
    if (token.kind === 'brace-l') {
      const fields = new Map<string, ValueNode>();
      while (this.peek().kind !== 'brace-r') {
        const name = this.expect('name').value;
        this.expect('colon');
        fields.set(name, this.parseValue());
      }
      this.expect('brace-r');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${token.kind} (${token.value})`);
  }

  private parseSelectionSet(): Selection[] {
    this.expect('brace-l');
    const selections: Selection[] = [];
    while (this.peek().kind !== 'brace-r') {
      selections.push(this.parseSelection());
    }
    this.expect('brace-r');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expect('name');
    let alias: string | null = null;
    let name = first.value;
    if (this.peek().kind === 'colon') {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    let args = new Map<string, ValueNode>();
    if (this.peek().kind === 'paren-l') args = this.parseArgs();
    this.skipDirectives();
    const selections = this.peek().kind === 'brace-l' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }
}

// ------------------------------------------------------------------ schema tables

interface TypeField {
  name: string;
}

const TYPE_FIELDS: Record<string, TypeField[]> = {
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'repository', 'comments', 'url',
  ].map((name) => ({ name })),
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'repository', 'createdAt',
    'updatedAt', 'closedAt', 'author',
  ].map((name) => ({ name })),
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate',
  ].map((name) => ({ name })),
  User: ['id', 'login', 'name', 'email', 'avatarUrl'].map((name) => ({ name })),
  Viewer: ['id', 'login', 'name', 'email'].map((name) => ({ name })),
  Ref: ['name'].map((name) => ({ name })),
  Comment: ['id', 'body', 'createdAt', 'author'].map((name) => ({ name })),
  PullRequestFile: ['path', 'additions', 'deletions', 'changes'].map((name) => ({ name })),
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'].map((name) => ({ name })),
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'].map((name) => ({ name })),
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'].map((name) => ({ name })),
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'].map((name) => ({ name })),
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'].map((name) => ({ name })),
  Query: ['viewer', 'repository', 'node', 'search'].map((name) => ({ name })),
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'].map((name) => ({ name })),
};

const TYPE_KINDS: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  Viewer: 'OBJECT',
  Ref: 'OBJECT',
  Comment: 'OBJECT',
  PullRequestFile: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  CommentConnection: 'OBJECT',
  PullRequestFileConnection: 'OBJECT',
  PageInfo: 'OBJECT',
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

// ------------------------------------------------------------------ value model

type GqlObject = { __typename: string; [key: string]: unknown };

interface ExecCtx {
  store: Store;
  errors: { message: string }[];
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
}

function viewerObject(): GqlObject {
  return { __typename: 'Viewer', login: VIEWER_LOGIN, id: gid('U', VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function userObject(): GqlObject {
  return { __typename: 'User', login: VIEWER_LOGIN, id: gid('U', VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function typeObject(name: string): GqlObject {
  return { __typename: '__Type', typeName: name };
}

function resolveValue(node: ValueNode, ctx: ExecCtx): unknown {
  if (node.kind === 'var') {
    const value = ctx.variables[node.name];
    return value === undefined ? null : value;
  }
  if (node.kind === 'list') return node.items.map((item) => resolveValue(item, ctx));
  if (node.kind === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of node.fields) out[key] = resolveValue(value, ctx);
    return out;
  }
  return node.value;
}

function argsOf(field: Extract<Selection, { kind: 'field' }>, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, ctx);
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`c:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^c:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface PageArgs {
  first?: number;
  after?: string;
}

/** Build a connection value from an ordered list of node objects. */
function connection(typeName: string, nodes: GqlObject[], args: PageArgs, keyOf: (node: GqlObject) => number): GqlObject {
  const after = cursorNumber(args.after);
  let filtered = nodes;
  if (after !== null) filtered = nodes.filter((node) => keyOf(node) > after);
  const first = args.first ?? filtered.length;
  const page = filtered.slice(0, first);
  const hasNextPage = filtered.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(keyOf(page[page.length - 1] as GqlObject)) : null;
  const startCursor = page.length > 0 ? cursorFor(keyOf(page[0] as GqlObject)) : null;
  return {
    __typename: typeName,
    nodes: page,
    edges: page.map((node) => ({ __typename: 'Edge', node, cursor: cursorFor(keyOf(node)) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor,
      endCursor,
    },
    totalCount: nodes.length,
  };
}

// ------------------------------------------------------------------ field resolution

function resolveField(typeName: string, parent: GqlObject, field: Extract<Selection, { kind: 'field' }>, ctx: ExecCtx): unknown {
  const store = ctx.store;
  const args = argsOf(field, ctx);
  const key = field.name;

  if (key === '__typename') return typeName;

  if (typeName === 'Query') {
    if (key === 'viewer') return viewerObject();
    if (key === 'repository') {
      const owner = args['owner'];
      const name = args['name'];
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      try {
        return repoObject(store.lookupRepo(owner, name));
      } catch {
        return null;
      }
    }
    if (key === 'node') {
      const id = args['id'];
      if (typeof id !== 'string') return null;
      const decoded = ungid(id);
      if (decoded === null) return null;
      if (decoded.kind === 'R') {
        const repo = store.findRepoById(Number(decoded.parts[0]));
        return repo === undefined ? null : repoObject(repo);
      }
      if (decoded.kind === 'I') {
        const repo = store.findRepoById(Number(decoded.parts[0]));
        if (repo === undefined) return null;
        const issue = repo.issues.find((entry) => entry.number === Number(decoded.parts[1]));
        return issue === undefined ? null : issueObject(repo, issue);
      }
      if (decoded.kind === 'P') {
        const repo = store.findRepoById(Number(decoded.parts[0]));
        if (repo === undefined) return null;
        const pull = repo.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
        return pull === undefined ? null : pullObject(repo, pull);
      }
      if (decoded.kind === 'U') return userObject();
      return null;
    }
    if (key === '__type') {
      const name = args['name'];
      if (typeof name !== 'string') return null;
      return TYPE_KINDS[name] === undefined ? null : typeObject(name);
    }
    if (key === '__schema') {
      return {
        __typename: '__Schema',
        queryType: { __typename: '__Type', typeName: 'Query' },
        mutationType: { __typename: '__Type', typeName: 'Mutation' },
        subscriptionType: null,
        types: Object.keys(TYPE_KINDS).map((name) => typeObject(name)),
        directives: [],
      };
    }
  }

  if (typeName === 'Mutation') {
    const input = isRecord(args['input']) ? (args['input'] as Record<string, unknown>) : {};
    if (key === 'createIssue') {
      const repoId = input['repositoryId'];
      const title = input['title'];
      if (typeof repoId !== 'string' || typeof title !== 'string') throw new ApiError(422, 'repositoryId and title are required');
      const decoded = ungid(repoId);
      const repo = decoded !== null && decoded.kind === 'R' ? store.findRepoById(Number(decoded.parts[0])) : undefined;
      if (repo === undefined) throw new ApiError(404, 'Not Found');
      const issue = store.createIssue(repo, title, typeof input['body'] === 'string' ? (input['body'] as string) : '', []);
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
    }
    if (key === 'closeIssue') {
      const issueId = input['issueId'];
      if (typeof issueId !== 'string') throw new ApiError(422, 'issueId is required');
      const decoded = ungid(issueId);
      if (decoded === null || decoded.kind !== 'I') throw new ApiError(404, 'Not Found');
      const repo = store.findRepoById(Number(decoded.parts[0]));
      if (repo === undefined) throw new ApiError(404, 'Not Found');
      const issue = store.findIssue(repo, Number(decoded.parts[1]));
      issue.state = 'closed';
      issue.closedAt = store.nowIso;
      return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
    }
    if (key === 'createPullRequest') {
      const repoId = input['repositoryId'];
      const title = input['title'];
      const head = input['headRefName'];
      const base = input['baseRefName'];
      if (typeof repoId !== 'string' || typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
        throw new ApiError(422, 'repositoryId, title, headRefName and baseRefName are required');
      }
      const decoded = ungid(repoId);
      const repo = decoded !== null && decoded.kind === 'R' ? store.findRepoById(Number(decoded.parts[0])) : undefined;
      if (repo === undefined) throw new ApiError(404, 'Not Found');
      const pull = store.createPull(repo, title, typeof input['body'] === 'string' ? (input['body'] as string) : '', head, base);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
    }
    if (key === 'mergePullRequest') {
      const pullId = input['pullRequestId'];
      if (typeof pullId !== 'string') throw new ApiError(422, 'pullRequestId is required');
      const decoded = ungid(pullId);
      if (decoded === null || decoded.kind !== 'P') throw new ApiError(404, 'Not Found');
      const repo = store.findRepoById(Number(decoded.parts[0]));
      if (repo === undefined) throw new ApiError(404, 'Not Found');
      const pull = store.findPull(repo, Number(decoded.parts[1]));
      store.mergePull(repo, pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
    }
    if (key === 'addComment') {
      const subjectId = input['subjectId'];
      const body = input['body'];
      if (typeof subjectId !== 'string' || typeof body !== 'string') throw new ApiError(422, 'subjectId and body are required');
      const decoded = ungid(subjectId);
      if (decoded === null || decoded.kind !== 'I') throw new ApiError(404, 'Not Found');
      const repo = store.findRepoById(Number(decoded.parts[0]));
      if (repo === undefined) throw new ApiError(404, 'Not Found');
      const issue = store.findIssue(repo, Number(decoded.parts[1]));
      const comment = { id: store.nextCommentId(), body, seq: issue.comments.length + 1 };
      issue.comments.push(comment);
      const node: GqlObject = { __typename: 'Comment', repo, issue, comment };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node, cursor: cursorFor(comment.id) },
      };
    }
  }

  if (typeName === 'Viewer' || typeName === 'User') {
    if (key === 'login') return VIEWER_LOGIN;
    if (key === 'id') return gid('U', VIEWER_ID);
    if (key === 'name') return VIEWER_NAME;
    if (key === 'email') return VIEWER_EMAIL;
    if (key === 'avatarUrl') return '';
  }

  if (typeName === 'Repository') {
    const repo = parent['repo'] as Repo;
    if (key === 'id') return gid('R', repo.id);
    if (key === 'databaseId') return repo.id;
    if (key === 'name') return repo.name;
    if (key === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (key === 'owner') return userObject();
    if (key === 'description') return repo.description;
    if (key === 'isPrivate') return repo.priv;
    if (key === 'createdAt' || key === 'updatedAt') return store.nowIso;
    if (key === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
      return tip === undefined ? null : { __typename: 'Ref', name: DEFAULT_BRANCH };
    }
    if (key === 'viewerPermission') return 'ADMIN';
    if (key === 'hasIssuesEnabled') return true;
    if (key === 'issue') {
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    if (key === 'issues') {
      const states = Array.isArray(args['states']) ? (args['states'] as unknown[]).filter((item) => typeof item === 'string') as string[] : [];
      let issues = repo.issues.filter((issue) => states.length === 0 || states.includes(issue.state.toUpperCase()));
      const orderBy = isRecord(args['orderBy']) ? (args['orderBy'] as Record<string, unknown>) : {};
      const direction = orderBy['direction'];
      const fieldName = orderBy['field'];
      if (fieldName === 'CREATED_AT' && direction === 'DESC') issues = [...issues].sort((a, b) => b.seq - a.seq);
      else if (fieldName === 'CREATED_AT' && direction === 'ASC') issues = [...issues].sort((a, b) => a.seq - b.seq);
      else issues = [...issues].sort((a, b) => a.seq - b.seq);
      const nodes = issues.map((issue) => issueObject(repo, issue));
      return connection('IssueConnection', nodes, { first: typeof args['first'] === 'number' ? args['first'] : undefined, after: typeof args['after'] === 'string' ? args['after'] : undefined }, (node) => (node['issue'] as Issue).number);
    }
    if (key === 'pullRequest') {
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull === undefined ? null : pullObject(repo, pull);
    }
    if (key === 'pullRequests') {
      const nodes = repo.pulls.map((pull) => pullObject(repo, pull));
      return connection('PullRequestConnection', nodes, { first: typeof args['first'] === 'number' ? args['first'] : undefined, after: typeof args['after'] === 'string' ? args['after'] : undefined }, (node) => (node['pull'] as Pull).number);
    }
  }

  if (typeName === 'Issue') {
    const repo = parent['repo'] as Repo;
    const issue = parent['issue'] as Issue;
    if (key === 'id') return gid('I', repo.id, issue.number);
    if (key === 'number') return issue.number;
    if (key === 'title') return issue.title;
    if (key === 'body') return issue.body;
    if (key === 'state') return issue.state.toUpperCase();
    if (key === 'createdAt' || key === 'updatedAt') return store.nowIso;
    if (key === 'closedAt') return issue.closedAt;
    if (key === 'author') return userObject();
    if (key === 'repository') return repoObject(repo);
    if (key === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (key === 'comments') {
      const nodes = issue.comments.map((comment) => ({ __typename: 'Comment', repo, issue, comment }) as GqlObject);
      return connection('CommentConnection', nodes, { first: typeof args['first'] === 'number' ? args['first'] : undefined, after: typeof args['after'] === 'string' ? args['after'] : undefined }, (node) => (node['comment'] as { id: number }).id);
    }
  }

  if (typeName === 'PullRequest') {
    const repo = parent['repo'] as Repo;
    const pull = parent['pull'] as Pull;
    if (key === 'id') return gid('P', repo.id, pull.number);
    if (key === 'number') return pull.number;
    if (key === 'title') return pull.title;
    if (key === 'body') return pull.body;
    if (key === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (key === 'merged') return pull.merged;
    if (key === 'mergeable') return store.mergeableOf(repo, pull);
    if (key === 'headRefName') return pull.head;
    if (key === 'baseRefName') return pull.base;
    if (key === 'headRefOid') return repo.refs.get(`refs/heads/${pull.head}`) ?? null;
    if (key === 'baseRefOid') return repo.refs.get(`refs/heads/${pull.base}`) ?? null;
    if (key === 'createdAt' || key === 'updatedAt') return store.nowIso;
    if (key === 'closedAt') return pull.state === 'closed' ? store.nowIso : null;
    if (key === 'author') return userObject();
    if (key === 'repository') return repoObject(repo);
    if (key === 'files') {
      const files = store.pullFiles(repo, pull).map((file, index) => ({ __typename: 'PullRequestFile', _idx: index, ...file }) as GqlObject);
      return connection('PullRequestFileConnection', files, { first: typeof args['first'] === 'number' ? args['first'] : undefined, after: typeof args['after'] === 'string' ? args['after'] : undefined }, (node) => node['_idx'] as number);
    }
  }

  if (typeName === 'Ref') {
    if (key === 'name') return parent['name'];
  }

  if (typeName === 'Comment') {
    const comment = parent['comment'] as { id: number; body: string };
    if (key === 'id') return gid('C', (parent['repo'] as Repo).id, (parent['issue'] as Issue).number, comment.id);
    if (key === 'body') return comment.body;
    if (key === 'createdAt') return store.nowIso;
    if (key === 'author') return userObject();
  }

  if (typeName === 'PullRequestFile') {
    if (key === 'path') return parent['filename'];
    if (key === 'additions') return parent['additions'];
    if (key === 'deletions') return parent['deletions'];
    if (key === 'changes') return parent['changes'];
  }

  if (typeName.endsWith('Connection')) {
    if (key === 'nodes') return parent['nodes'];
    if (key === 'edges') return parent['edges'];
    if (key === 'pageInfo') return parent['pageInfo'];
    if (key === 'totalCount') return parent['totalCount'];
  }

  if (typeName === 'Edge' || typeName === 'CommentEdge') {
    if (key === 'node') return parent['node'];
    if (key === 'cursor') return parent['cursor'];
  }

  if (typeName === 'PageInfo') {
    if (key === 'hasNextPage') return parent['hasNextPage'];
    if (key === 'hasPreviousPage') return parent['hasPreviousPage'];
    if (key === 'startCursor') return parent['startCursor'];
    if (key === 'endCursor') return parent['endCursor'];
  }

  if (typeName === '__Type') {
    const name = parent['typeName'] as string;
    if (key === 'name') return name;
    if (key === 'kind') return TYPE_KINDS[name] ?? 'OBJECT';
    if (key === 'description') return null;
    if (key === 'fields') {
      const fields = TYPE_FIELDS[name];
      if (fields === undefined) return null;
      return fields.map((field) => ({
        __typename: '__Field',
        name: field.name,
        description: null,
        args: [],
        type: { __typename: '__Type', typeName: 'String' },
      }));
    }
    if (key === 'enumValues') {
      const values = ENUM_VALUES[name];
      if (values === undefined) return null;
      return values.map((value) => ({ __typename: '__EnumValue', name: value, description: null }));
    }
    if (key === 'inputFields') return null;
    if (key === 'interfaces') return [];
    if (key === 'possibleTypes') return null;
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (key === 'name') return parent['name'];
    if (key === 'description') return parent['description'] ?? null;
    if (key === 'args') return parent['args'] ?? [];
    if (key === 'type') return parent['type'] ?? null;
  }

  if (typeName === '__Schema') {
    if (key === 'queryType') return parent['queryType'];
    if (key === 'mutationType') return parent['mutationType'];
    if (key === 'subscriptionType') return parent['subscriptionType'];
    if (key === 'types') return parent['types'];
    if (key === 'directives') return [];
  }

  // Payload objects: createIssue / closeIssue / createPullRequest / mergePullRequest / addComment.
  if (key === 'issue' || key === 'pullRequest') return parent[key] ?? null;
  if (key === 'commentEdge') return parent['commentEdge'] ?? null;

  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return undefined;
}

function isKnownField(typeName: string, fieldName: string): boolean {
  if (fieldName === '__typename') return true;
  const fields = TYPE_FIELDS[typeName];
  if (fields !== undefined && fields.some((field) => field.name === fieldName)) return true;
  if (typeName === 'Query') return ['viewer', 'repository', 'node', '__type', '__schema'].includes(fieldName);
  if (typeName === 'Mutation') return ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'].includes(fieldName);
  if (typeName === '__Type') return ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'].includes(fieldName);
  if (typeName === '__Schema') return ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'].includes(fieldName);
  if (typeName === '__Field') return ['name', 'description', 'args', 'type'].includes(fieldName);
  if (typeName === '__EnumValue') return ['name', 'description'].includes(fieldName);
  if (typeName === 'PageInfo') return ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'].includes(fieldName);
  if (typeName === 'Edge') return ['node', 'cursor'].includes(fieldName);
  if (typeName === 'CommentEdge') return ['node', 'cursor'].includes(fieldName);
  if (typeName.endsWith('Connection')) return ['nodes', 'edges', 'pageInfo', 'totalCount'].includes(fieldName);
  if (typeName.startsWith('Create') || typeName.startsWith('Close') || typeName.startsWith('Merge') || typeName.startsWith('Add')) {
    return ['issue', 'pullRequest', 'commentEdge'].includes(fieldName);
  }
  return false;
}

function resolveSelections(
  typeName: string,
  parent: GqlObject,
  selections: Selection[],
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== typeName) continue;
      Object.assign(out, resolveSelections(typeName, parent, fragment.selections, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      Object.assign(out, resolveSelections(typeName, parent, selection.selections, ctx));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (!isKnownField(typeName, selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(typeName, parent, selection, ctx);
    } catch (error) {
      if (error instanceof ApiError) {
        ctx.errors.push({ message: error.message });
        out[responseKey] = null;
        continue;
      }
      throw error;
    }
    if (value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (selection.selections.length === 0) {
      out[responseKey] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          const child = item as GqlObject;
          return resolveSelections(child.__typename, child, selection.selections, ctx);
        }
        return item;
      });
      continue;
    }
    if (value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const child = value as GqlObject;
      out[responseKey] = resolveSelections(child.__typename, child, selection.selections, ctx);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

function executeOperation(store: Store, doc: Document, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const ctx: ExecCtx = { store, errors: [], variables, fragments: doc.fragments };
  for (const varDef of operation.varDefs) {
    if (ctx.variables[varDef.name] === undefined && varDef.defaultValue !== undefined) {
      ctx.variables[varDef.name] = resolveValue(varDef.defaultValue, ctx);
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = resolveSelections(rootType, root, operation.selections, ctx);
  return { data, errors: ctx.errors };
}

function executeOne(store: Store, body: unknown): { data?: Record<string, unknown>; errors?: { message: string }[] } {
  if (!isRecord(body)) return { errors: [{ message: 'GraphQL request body must be an object' }] };
  const query = body['query'];
  if (typeof query !== 'string') return { errors: [{ message: 'GraphQL query must be a string' }] };
  const variables = isRecord(body['variables']) ? (body['variables'] as Record<string, unknown>) : {};
  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'GraphQL parse error' }] };
  }
  const operationName = typeof body['operationName'] === 'string' ? body['operationName'] : null;
  let operation: Operation | undefined;
  if (operationName !== null) {
    operation = doc.operations.find((op) => op.name === operationName);
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  }
  if (operation === undefined) return { errors: [{ message: 'No operation found in GraphQL document' }] };
  const result = executeOperation(store, doc, operation, { ...variables });
  const out: { data: Record<string, unknown>; errors?: { message: string }[] } = { data: result.data };
  if (result.errors.length > 0) out.errors = result.errors;
  return out;
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, store, 404, { message: 'Not Found' });
    return;
  }
  if (!requireAuth(req, res, store)) return;
  const raw = await readBody(req);
  const parsed = parseJsonBody(res, store, raw);
  if (parsed === null) return;
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => executeOne(store, item));
    sendJson(res, store, 200, results);
    return;
  }
  const result = executeOne(store, parsed);
  sendJson(res, store, 200, result);
}
