// GraphQL v4 API at /api/graphql: a dependency-free parser, executor and
// introspection layer over the same store REST uses.
import type { Issue, IssueComment, PullRequest, Repo, Store } from "./store.ts";
import {
  branchTip,
  flatTree,
  prChangedFiles,
  prMergeable,
  squashMerge,
  userObject,
} from "./store.ts";
import { serializeIssue, serializePull, serializeRepo } from "./rest.ts";

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokKind = "name" | "string" | "int" | "float" | "punct" | "spread" | "eof";

interface Token {
  kind: TokKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "." && src[i + 1] === "." && src[i + 2] === ".") {
      tokens.push({ kind: "spread", value: "..." });
      i += 3;
      continue;
    }
    if ("!$()[]{}:=@&|".includes(c)) {
      tokens.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === "n") out += "\n";
          else if (e === "t") out += "\t";
          else if (e === "r") out += "\r";
          else if (e === '"') out += '"';
          else if (e === "\\") out += "\\";
          else if (e === "/") out += "/";
          else if (e === "u") {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: "string", value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== "-" || /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      if (src[j] === "-") j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === "e" || src[j] === "E") {
        isFloat = true;
        j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      tokens.push({ kind: isFloat ? "float" : "int", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j++;
      tokens.push({ kind: "name", value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: "variable"; name: string }
  | { kind: "string"; value: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: ValueNode[] }
  | { kind: "object"; fields: { name: string; value: ValueNode }[] };

export interface DirectiveNode {
  name: string;
  args: { name: string; value: ValueNode }[];
}

export interface FieldNode {
  kind: "field";
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

export type SelectionNode =
  | FieldNode
  | { kind: "fragmentSpread"; name: string; directives: DirectiveNode[] }
  | { kind: "inlineFragment"; typeCondition: string | null; directives: DirectiveNode[]; selections: SelectionNode[] };

export interface OperationNode {
  kind: "query" | "mutation" | "subscription";
  name: string | null;
  varDefs: { name: string; defaultValue: ValueNode | null }[];
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

export interface FragmentNode {
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(value: string): Token {
    const t = this.next();
    if (t.value !== value) throw new Error(`graphql: expected ${value}, got ${t.value}`);
    return t;
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== "name") throw new Error(`graphql: expected name, got ${t.value}`);
    return t.value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== "eof") {
      const t = this.peek();
      if (t.value === "{") {
        doc.operations.push(this.parseOperation("query"));
      } else if (t.value === "query" || t.value === "mutation" || t.value === "subscription") {
        this.next();
        doc.operations.push(this.parseOperation(t.value as "query" | "mutation" | "subscription"));
      } else if (t.value === "fragment") {
        this.next();
        const frag = this.parseFragment();
        doc.fragments.set(frag.name, frag);
      } else {
        throw new Error(`graphql: unexpected ${t.value}`);
      }
    }
    return doc;
  }

  private parseOperation(kind: "query" | "mutation" | "subscription"): OperationNode {
    let name: string | null = null;
    if (this.peek().kind === "name") name = this.next().value;
    const varDefs: OperationNode["varDefs"] = [];
    if (this.peek().value === "(") {
      this.next();
      while (this.peek().value !== ")") {
        this.expect("$");
        const vname = this.expectName();
        this.expect(":");
        this.parseType();
        let def: ValueNode | null = null;
        if (this.peek().value === "=") {
          this.next();
          def = this.parseValue(true);
        }
        varDefs.push({ name: vname, defaultValue: def });
      }
      this.expect(")");
    }
    const directives = this.parseDirectives();
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, directives, selections };
  }

  private parseType(): void {
    if (this.peek().value === "[") {
      this.next();
      this.parseType();
      this.expect("]");
    } else {
      this.expectName();
    }
    if (this.peek().value === "!") this.next();
  }

  private parseFragment(): FragmentNode {
    const name = this.expectName();
    this.expect("on");
    const typeCondition = this.expectName();
    const directives = this.parseDirectives();
    const selections = this.parseSelectionSet();
    return { name, typeCondition, directives, selections };
  }

  private parseDirectives(): DirectiveNode[] {
    const out: DirectiveNode[] = [];
    while (this.peek().value === "@") {
      this.next();
      const name = this.expectName();
      const args = this.peek().value === "(" ? this.parseArgs() : [];
      out.push({ name, args });
    }
    return out;
  }

  private parseArgs(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expect("(");
    while (this.peek().value !== ")") {
      const name = this.expectName();
      this.expect(":");
      args.push({ name, value: this.parseValue(false) });
    }
    this.expect(")");
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect("{");
    const sels: SelectionNode[] = [];
    while (this.peek().value !== "}") {
      sels.push(this.parseSelection());
    }
    this.expect("}");
    return sels;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === "spread") {
      this.next();
      if (this.peek().value === "on") {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        const selections = this.parseSelectionSet();
        return { kind: "inlineFragment", typeCondition, directives, selections };
      }
      const name = this.expectName();
      const directives = this.parseDirectives();
      return { kind: "fragmentSpread", name, directives };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().value === ":") {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().value === "(" ? this.parseArgs() : [];
    const directives = this.parseDirectives();
    const selections = this.peek().value === "{" ? this.parseSelectionSet() : [];
    return { kind: "field", alias, name, args, directives, selections };
  }

  private parseValue(isConst: boolean): ValueNode {
    const t = this.peek();
    if (t.value === "$") {
      if (isConst) throw new Error("graphql: variable in constant value");
      this.next();
      return { kind: "variable", name: this.expectName() };
    }
    if (t.value === "[") {
      this.next();
      const values: ValueNode[] = [];
      while (this.peek().value !== "]") values.push(this.parseValue(isConst));
      this.expect("]");
      return { kind: "list", values };
    }
    if (t.value === "{") {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek().value !== "}") {
        const name = this.expectName();
        this.expect(":");
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expect("}");
      return { kind: "object", fields };
    }
    this.next();
    if (t.kind === "string") return { kind: "string", value: t.value };
    if (t.kind === "int") return { kind: "int", value: parseInt(t.value, 10) };
    if (t.kind === "float") return { kind: "float", value: parseFloat(t.value) };
    if (t.kind === "name") {
      if (t.value === "true") return { kind: "boolean", value: true };
      if (t.value === "false") return { kind: "boolean", value: false };
      if (t.value === "null") return { kind: "null" };
      return { kind: "enum", value: t.value };
    }
    throw new Error(`graphql: unexpected value ${t.value}`);
  }
}

export function parseGraphQL(src: string): DocumentNode {
  return new Parser(tokenize(src)).parseDocument();
}

// ---------------------------------------------------------------------------
// Value evaluation
// ---------------------------------------------------------------------------

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case "variable":
      return vars[node.name];
    case "string":
    case "int":
    case "float":
    case "boolean":
      return node.value;
    case "null":
      return null;
    case "enum":
      return node.value;
    case "list":
      return node.values.map((v) => evalValue(v, vars));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, vars);
      return out;
    }
  }
}

function argsMap(field: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalValue(a.value, vars);
  return out;
}

function directiveSkip(directives: DirectiveNode[], vars: Record<string, unknown>): boolean {
  for (const d of directives) {
    const args: Record<string, unknown> = {};
    for (const a of d.args) args[a.name] = evalValue(a.value, vars);
    if (d.name === "skip" && args.if === true) return true;
    if (d.name === "include" && args.if === false) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Schema (for introspection and field validation)
// ---------------------------------------------------------------------------

interface TypeField {
  name: string;
  type?: string;
}

interface TypeDef {
  kind: "OBJECT" | "ENUM" | "SCALAR";
  fields?: TypeField[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: "OBJECT",
    fields: [
      { name: "repository" },
      { name: "viewer" },
      { name: "search" },
      { name: "node" },
      { name: "rateLimit" },
      { name: "__type" },
      { name: "__schema" },
    ],
  },
  Mutation: {
    kind: "OBJECT",
    fields: [{ name: "createPullRequest" }, { name: "createIssue" }, { name: "closeIssue" }, { name: "mergePullRequest" }, { name: "addComment" }],
  },
  Repository: {
    kind: "OBJECT",
    fields: [
      { name: "id" },
      { name: "databaseId" },
      { name: "name" },
      { name: "nameWithOwner" },
      { name: "owner" },
      { name: "defaultBranchRef" },
      { name: "viewerPermission" },
      { name: "hasIssuesEnabled" },
      { name: "issue" },
      { name: "issues" },
      { name: "pullRequest" },
      { name: "pullRequests" },
      { name: "url" },
      { name: "description" },
      { name: "createdAt" },
      { name: "updatedAt" },
      { name: "isPrivate" },
    ],
  },
  Issue: {
    kind: "OBJECT",
    fields: [
      { name: "id" },
      { name: "databaseId" },
      { name: "number" },
      { name: "title" },
      { name: "body" },
      { name: "state" },
      { name: "createdAt" },
      { name: "updatedAt" },
      { name: "closedAt" },
      { name: "author" },
      { name: "labels" },
      { name: "url" },
      { name: "repository" },
    ],
  },
  PullRequest: {
    kind: "OBJECT",
    fields: [
      { name: "id" },
      { name: "databaseId" },
      { name: "number" },
      { name: "title" },
      { name: "body" },
      { name: "state" },
      { name: "merged" },
      { name: "mergeable" },
      { name: "headRefName" },
      { name: "baseRefName" },
      { name: "headRefOid" },
      { name: "baseRefOid" },
      { name: "files" },
      { name: "createdAt" },
      { name: "updatedAt" },
      { name: "closedAt" },
      { name: "mergedAt" },
      { name: "author" },
    ],
  },
  User: {
    kind: "OBJECT",
    fields: [{ name: "id" }, { name: "login" }, { name: "url" }],
  },
  Ref: {
    kind: "OBJECT",
    fields: [{ name: "name" }],
  },
  IssueConnection: {
    kind: "OBJECT",
    fields: [{ name: "nodes" }, { name: "edges" }, { name: "pageInfo" }, { name: "totalCount" }],
  },
  PullRequestConnection: {
    kind: "OBJECT",
    fields: [{ name: "nodes" }, { name: "edges" }, { name: "pageInfo" }, { name: "totalCount" }],
  },
  LabelConnection: {
    kind: "OBJECT",
    fields: [{ name: "nodes" }, { name: "edges" }, { name: "pageInfo" }, { name: "totalCount" }],
  },
  PullRequestChangedFileConnection: {
    kind: "OBJECT",
    fields: [{ name: "nodes" }, { name: "edges" }, { name: "pageInfo" }, { name: "totalCount" }],
  },
  SearchResultItemConnection: {
    kind: "OBJECT",
    fields: [{ name: "nodes" }, { name: "edges" }, { name: "pageInfo" }, { name: "issueCount" }, { name: "repositoryCount" }],
  },
  PageInfo: {
    kind: "OBJECT",
    fields: [
      { name: "hasNextPage" },
      { name: "hasPreviousPage" },
      { name: "startCursor" },
      { name: "endCursor" },
    ],
  },
  IssueEdge: {
    kind: "OBJECT",
    fields: [{ name: "node" }, { name: "cursor" }],
  },
  PullRequestEdge: {
    kind: "OBJECT",
    fields: [{ name: "node" }, { name: "cursor" }],
  },
  Label: {
    kind: "OBJECT",
    fields: [{ name: "id" }, { name: "name" }, { name: "color" }, { name: "description" }],
  },
  PullRequestChangedFile: {
    kind: "OBJECT",
    fields: [{ name: "path" }],
  },
  SearchType: { kind: "ENUM", enumValues: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION"] },
  IssueState: { kind: "ENUM", enumValues: ["OPEN", "CLOSED"] },
  OrderDirection: { kind: "ENUM", enumValues: ["ASC", "DESC"] },
  IssueOrderField: { kind: "ENUM", enumValues: ["CREATED_AT", "UPDATED_AT", "COMMENTS"] },
  RepositoryPermission: { kind: "ENUM", enumValues: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"] },
  String: { kind: "SCALAR" },
  Int: { kind: "SCALAR" },
  Boolean: { kind: "SCALAR" },
  ID: { kind: "SCALAR" },
  DateTime: { kind: "SCALAR" },
  URI: { kind: "SCALAR" },
};

function typeObject(name: string): Record<string, unknown> | null {
  const def = SCHEMA[name];
  if (!def) return null;
  const out: Record<string, unknown> = { name, kind: def.kind };
  if (def.fields) {
    out.fields = def.fields.map((f) => ({
      name: f.name,
      args: [],
      type: { kind: "SCALAR", name: "String", ofType: null },
    }));
  } else {
    out.fields = null;
  }
  if (def.enumValues) {
    out.enumValues = def.enumValues.map((v) => ({ name: v }));
  } else {
    out.enumValues = null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  baseUrl: string;
  doc: DocumentNode;
  vars: Record<string, unknown>;
  errors: { message: string }[];
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`).toString("base64");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  try {
    const text = Buffer.from(cursor, "base64").toString("utf8");
    const m = text.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

interface PageArgs {
  first?: number;
  after?: string;
  orderBy?: { field?: string; direction?: string };
  states?: string[];
}

function pageArgs(args: Record<string, unknown>): PageArgs {
  const out: PageArgs = {};
  if (typeof args.first === "number") out.first = args.first;
  if (typeof args.after === "string") out.after = args.after;
  if (args.orderBy && typeof args.orderBy === "object") {
    const o = args.orderBy as Record<string, unknown>;
    out.orderBy = {
      field: typeof o.field === "string" ? o.field : undefined,
      direction: typeof o.direction === "string" ? o.direction : undefined,
    };
  }
  if (Array.isArray(args.states)) out.states = args.states as string[];
  return out;
}

function connection<T>(
  items: T[],
  args: PageArgs,
  keyOf: (item: T) => number,
): Record<string, unknown> {
  const afterKey = decodeCursor(args.after);
  let startIdx = 0;
  if (afterKey >= 0) {
    const idx = items.findIndex((it) => keyOf(it) === afterKey);
    startIdx = idx >= 0 ? idx + 1 : 0;
  }
  const rest = items.slice(startIdx);
  const totalCount = items.length;
  const first = args.first ?? rest.length;
  const page = rest.slice(0, first);
  const hasNext = rest.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(keyOf(page[page.length - 1])) : null;
  const startCursor = page.length > 0 ? cursorFor(keyOf(page[0])) : null;
  return {
    nodes: page,
    edges: page.map((node) => ({ node, cursor: cursorFor(keyOf(node)) })),
    pageInfo: {
      hasNextPage: hasNext,
      hasPreviousPage: startIdx > 0,
      startCursor,
      endCursor,
    },
    totalCount,
  };
}

function sortIssues(issues: Issue[], args: PageArgs): Issue[] {
  const field = args.orderBy?.field ?? "CREATED_AT";
  const desc = (args.orderBy?.direction ?? "ASC") === "DESC";
  return [...issues].sort((a, b) => {
    let cmp = 0;
    if (field === "CREATED_AT") cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    else if (field === "UPDATED_AT") cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (field === "COMMENTS") cmp = a.comments - b.comments;
    if (cmp === 0) cmp = a.number - b.number;
    return desc ? -cmp : cmp;
  });
}

function filterStates<T extends { state: string }>(items: T[], states: string[] | undefined): T[] {
  if (!states || states.length === 0) return items;
  const wanted = new Set(states.map((s) => s.toLowerCase()));
  return items.filter((i) => wanted.has(i.state.toLowerCase()));
}

// Resolve a field on a typed value. value is a wrapper { __typename, ...data }.
function resolveField(
  ctx: Ctx,
  parentType: string,
  parent: Record<string, unknown> & { __typename: string },
  field: FieldNode,
): unknown {
  const def = SCHEMA[parentType];
  if (def && def.fields && !def.fields.some((f) => f.name === field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
    return null;
  }
  const args = argsMap(field, ctx.vars);
  const store = ctx.store;

  switch (parentType) {
    case "Query": {
      if (field.name === "__type") {
        const name = args.name as string;
        return typeObject(name);
      }
      if (field.name === "__schema") {
        return {
          queryType: { name: "Query" },
          mutationType: { name: "Mutation" },
          types: Object.keys(SCHEMA).map((n) => ({ name: n })),
        };
      }
      if (field.name === "repository") {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== store.login) return null;
        const repo = store.repos.get(name);
        if (!repo) return null;
        return { __typename: "Repository", repo };
      }
      if (field.name === "viewer") {
        return { __typename: "User", login: store.login, id: store.userId };
      }
      if (field.name === "search") {
        const q = (args.query as string) ?? "";
        const type = (args.type as string) ?? "ISSUE";
        const first = typeof args.first === "number" ? args.first : 10;
        const after = typeof args.after === "string" ? args.after : undefined;
        const m = q.match(/repo:([^\s]+)/);
        let issues: Issue[] = [];
        if (m) {
          const [owner, name] = m[1].split("/");
          if (owner === store.login) {
            const repo = store.repos.get(name);
            if (repo) issues = [...repo.issues.values()];
          }
        } else {
          for (const repo of store.repos.values()) issues.push(...repo.issues.values());
        }
        const keywords = q.replace(/repo:[^\s]+/g, "").trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (keywords.length > 0) {
          issues = issues.filter((i) =>
            keywords.every((k) => `${i.title} ${i.body}`.toLowerCase().includes(k)),
          );
        }
        issues.sort((a, b) => b.number - a.number);
        if (type === "ISSUE") {
          const conn = connection(
            issues.map((i) => ({ __typename: "Issue", issue: i, repo: findRepoOfIssue(store, i) })),
            { first, after },
            (w) => (w.issue as Issue).number,
          );
          return { __typename: "SearchResultItemConnection", ...conn, issueCount: issues.length, repositoryCount: 0 };
        }
        return { __typename: "SearchResultItemConnection", nodes: [], edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, issueCount: 0, repositoryCount: 0 };
      }
      if (field.name === "node") {
        const id = args.id as string;
        for (const repo of store.repos.values()) {
          if (repo.nodeId === id) return { __typename: "Repository", repo };
          for (const issue of repo.issues.values()) {
            if (issue.nodeId === id) return { __typename: "Issue", issue, repo };
          }
          for (const pr of repo.pulls.values()) {
            if (pr.nodeId === id) return { __typename: "PullRequest", pr, repo };
          }
        }
        return null;
      }
      if (field.name === "rateLimit") {
        return { limit: 5000, cost: 1, remaining: 4999, resetAt: store.clock.nextIso() };
      }
      return null;
    }
    case "Mutation": {
      if (field.name === "createPullRequest") {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoId = input.repositoryId as string;
        const repo = findRepoByNodeId(store, repoId);
        if (!repo) {
          ctx.errors.push({ message: `Could not resolve to a Repository with the id of '${repoId}'.` });
          return null;
        }
        const head = (input.headRefName as string) ?? "";
        const base = (input.baseRefName as string) ?? repo.defaultBranch;
        const headTip = branchTip(repo, head);
        const baseTip = branchTip(repo, base);
        if (!headTip || !baseTip) {
          ctx.errors.push({ message: "Validation Failed: head branch does not exist" });
          return null;
        }
        const number = repo.nextNumber++;
        const id = store.nextObjectId++;
        const now = store.clock.nextIso();
        const pr: PullRequest = {
          id,
          nodeId: Buffer.from(`PullRequest:${id}`).toString("base64"),
          number,
          title: (input.title as string) ?? "",
          body: (input.body as string) ?? "",
          state: "open",
          headRef: head,
          headSha: headTip,
          baseRef: base,
          baseSha: baseTip,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdAt: now,
          updatedAt: now,
          closedAt: null,
        };
        repo.pulls.set(number, pr);
        return {
          __typename: "CreatePullRequestPayload",
          pullRequest: { __typename: "PullRequest", pr, repo },
          clientMutationId: (input.clientMutationId as string) ?? null,
        };
      }
      if (field.name === "createIssue") {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoId = input.repositoryId as string;
        const repo = findRepoByNodeId(store, repoId);
        if (!repo) {
          ctx.errors.push({ message: `Could not resolve to a Repository with the id of '${repoId}'.` });
          return null;
        }
        const number = repo.nextNumber++;
        const id = store.nextObjectId++;
        const now = store.clock.nextIso();
        const issue: Issue = {
          id,
          nodeId: Buffer.from(`Issue:${id}`).toString("base64"),
          number,
          title: (input.title as string) ?? "",
          body: (input.body as string) ?? "",
          state: "open",
          labels: [],
          userLogin: store.login,
          createdAt: now,
          updatedAt: now,
          closedAt: null,
          comments: 0,
        };
        repo.issues.set(number, issue);
        return {
          __typename: "CreateIssuePayload",
          issue: { __typename: "Issue", issue, repo },
          clientMutationId: (input.clientMutationId as string) ?? null,
        };
      }
      if (field.name === "closeIssue") {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const issueId = input.issueId as string;
        for (const repo of store.repos.values()) {
          for (const issue of repo.issues.values()) {
            if (issue.nodeId === issueId) {
              issue.state = "closed";
              issue.closedAt = store.clock.nextIso();
              issue.updatedAt = store.clock.nextIso();
              repo.issueJsonCache.clear();
              return {
                __typename: "CloseIssuePayload",
                issue: { __typename: "Issue", issue, repo },
                clientMutationId: (input.clientMutationId as string) ?? null,
              };
            }
          }
        }
        return null;
      }
      if (field.name === "mergePullRequest") {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const prId = input.pullRequestId as string;
        for (const repo of store.repos.values()) {
          for (const pr of repo.pulls.values()) {
            if (pr.nodeId !== prId) continue;
            if (pr.state !== "open" || pr.merged) {
              ctx.errors.push({ message: "Pull request is not open" });
              return null;
            }
            const result = squashMerge(store, repo, pr);
            if ("conflict" in result) {
              ctx.errors.push({ message: "Merge conflict" });
              return null;
            }
            pr.merged = true;
            pr.state = "closed";
            const now = store.clock.nextIso();
            pr.mergedAt = now;
            pr.closedAt = now;
            pr.updatedAt = now;
            pr.mergeCommitSha = result.sha;
            pr.baseSha = result.sha;
            repo.updatedAt = now;
            repo.pushedAt = now;
            repo.issueJsonCache.clear();
            return {
              __typename: "MergePullRequestPayload",
              pullRequest: { __typename: "PullRequest", pr, repo },
              clientMutationId: (input.clientMutationId as string) ?? null,
            };
          }
        }
        ctx.errors.push({ message: `Could not resolve to a PullRequest with the id of '${prId}'.` });
        return null;
      }
      if (field.name === "addComment") {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const subjectId = input.subjectId as string;
        const body = (input.body as string) ?? "";
        for (const repo of store.repos.values()) {
          for (const issue of repo.issues.values()) {
            if (issue.nodeId !== subjectId) continue;
            const id = store.nextObjectId++;
            const now = store.clock.nextIso();
            const comment: IssueComment = {
              id,
              nodeId: Buffer.from(`IssueComment:${id}`).toString("base64"),
              issueNumber: issue.number,
              body,
              userLogin: store.login,
              createdAt: now,
              updatedAt: now,
            };
            const list = repo.issueComments.get(issue.number) ?? [];
            list.push(comment);
            repo.issueComments.set(issue.number, list);
            issue.comments = list.length;
            issue.updatedAt = now;
            repo.issueJsonCache.clear();
            return {
              __typename: "AddCommentPayload",
              commentEdge: { node: { __typename: "IssueComment", id: comment.nodeId, body: comment.body } },
              clientMutationId: (input.clientMutationId as string) ?? null,
            };
          }
        }
        ctx.errors.push({ message: `Could not resolve to an Issue with the id of '${subjectId}'.` });
        return null;
      }
      return null;
    }
    case "Repository": {
      const repo = parent.repo as Repo;
      switch (field.name) {
        case "id":
          return repo.nodeId;
        case "databaseId":
          return repo.id;
        case "name":
          return repo.name;
        case "nameWithOwner":
          return `${repo.ownerLogin}/${repo.name}`;
        case "owner":
          return { __typename: "User", login: repo.ownerLogin, id: store.userId };
        case "defaultBranchRef":
          return { __typename: "Ref", name: repo.defaultBranch };
        case "viewerPermission":
          return "ADMIN";
        case "hasIssuesEnabled":
          return true;
        case "url":
          return `${ctx.baseUrl}/${repo.ownerLogin}/${repo.name}`;
        case "description":
          return repo.description;
        case "createdAt":
          return repo.createdAt;
        case "updatedAt":
          return repo.updatedAt;
        case "isPrivate":
          return repo.isPrivate;
        case "issue": {
          const n = args.number as number;
          const issue = repo.issues.get(n);
          return issue ? { __typename: "Issue", issue, repo } : null;
        }
        case "issues": {
          const pa = pageArgs(args);
          let list = [...repo.issues.values()];
          list = filterStates(list, pa.states);
          list = sortIssues(list, pa);
          const conn = connection(
            list.map((i) => ({ __typename: "Issue", issue: i, repo })),
            pa,
            (w) => (w.issue as Issue).number,
          );
          return { __typename: "IssueConnection", ...conn };
        }
        case "pullRequest": {
          const n = args.number as number;
          const pr = repo.pulls.get(n);
          return pr ? { __typename: "PullRequest", pr, repo } : null;
        }
        case "pullRequests": {
          const pa = pageArgs(args);
          let list = [...repo.pulls.values()];
          list = filterStates(list, pa.states);
          list.sort((a, b) => {
            const mult = pa.orderBy?.direction === "DESC" ? -1 : 1;
            const cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
            return cmp * mult;
          });
          const conn = connection(
            list.map((p) => ({ __typename: "PullRequest", pr: p, repo })),
            pa,
            (w) => (w.pr as PullRequest).number,
          );
          return { __typename: "PullRequestConnection", ...conn };
        }
        default:
          return null;
      }
    }
    case "Issue": {
      const issue = parent.issue as Issue;
      const repo = parent.repo as Repo;
      switch (field.name) {
        case "id":
          return issue.nodeId;
        case "databaseId":
          return issue.id;
        case "number":
          return issue.number;
        case "title":
          return issue.title;
        case "body":
          return issue.body;
        case "state":
          return issue.state.toUpperCase();
        case "createdAt":
          return issue.createdAt;
        case "updatedAt":
          return issue.updatedAt;
        case "closedAt":
          return issue.closedAt;
        case "author":
          return { __typename: "User", login: issue.userLogin, id: store.userId };
        case "labels": {
          const pa = pageArgs(args);
          const conn = connection(
            issue.labels.map((l) => ({ __typename: "Label", label: l })),
            pa,
            (w) => (w.label as { id: number }).id,
          );
          return { __typename: "LabelConnection", ...conn };
        }
        case "url":
          return `${ctx.baseUrl}/${repo.ownerLogin}/${repo.name}/issues/${issue.number}`;
        case "repository":
          return { __typename: "Repository", repo };
        default:
          return null;
      }
    }
    case "PullRequest": {
      const pr = parent.pr as PullRequest;
      const repo = parent.repo as Repo;
      switch (field.name) {
        case "id":
          return pr.nodeId;
        case "databaseId":
          return pr.id;
        case "number":
          return pr.number;
        case "title":
          return pr.title;
        case "body":
          return pr.body;
        case "state":
          return pr.state.toUpperCase();
        case "merged":
          return pr.merged;
        case "mergeable":
          // GitHub's MergeableState enum, not a boolean.
          if (pr.state !== "open") return "UNKNOWN";
          return prMergeable(repo, pr) ? "MERGEABLE" : "CONFLICTING";
        case "headRefName":
          return pr.headRef;
        case "baseRefName":
          return pr.baseRef;
        case "headRefOid":
          return pr.headSha;
        case "baseRefOid":
          return pr.baseSha;
        case "createdAt":
          return pr.createdAt;
        case "updatedAt":
          return pr.updatedAt;
        case "closedAt":
          return pr.closedAt;
        case "mergedAt":
          return pr.mergedAt;
        case "author":
          return { __typename: "User", login: store.login, id: store.userId };
        case "files": {
          const pa = pageArgs(args);
          const paths = prChangedFiles(repo, pr);
          const nodes = paths.map((p, i) => ({ __typename: "PullRequestChangedFile", path: p, index: i }));
          const conn = connection(nodes, pa, (w) => w.index);
          return { __typename: "PullRequestChangedFileConnection", ...conn };
        }
        default:
          return null;
      }
    }
    case "User": {
      const login = parent.login as string;
      const id = parent.id as number;
      if (field.name === "login") return login;
      if (field.name === "id") return Buffer.from(`User:${id}`).toString("base64");
      if (field.name === "url") return `${ctx.baseUrl}/${login}`;
      return null;
    }
    case "Ref": {
      if (field.name === "name") return parent.name as string;
      return null;
    }
    case "Label": {
      const label = parent.label as { id: number; name: string; color: string; description: string };
      if (field.name === "id") return Buffer.from(`Label:${label.id}`).toString("base64");
      if (field.name === "name") return label.name;
      if (field.name === "color") return label.color;
      if (field.name === "description") return label.description;
      return null;
    }
    case "PullRequestChangedFile": {
      if (field.name === "path") return parent.path as string;
      return null;
    }
    default: {
      // Connection / payload / introspection passthrough: fields already hold
      // plain values; nested selections resolve against the stored objects.
      const v = parent[field.name];
      if (v !== undefined) return v;
      return null;
    }
  }
}

function findRepoByNodeId(store: Store, nodeId: string): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.nodeId === nodeId) return repo;
  }
  return null;
}

function findRepoOfIssue(store: Store, issue: Issue): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.issues.get(issue.number) === issue) return repo;
  }
  return null;
}

// Resolve a selection set against a typed value, returning the JSON object.
function resolveSelections(
  ctx: Ctx,
  parentType: string,
  parent: Record<string, unknown> & { __typename: string },
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === "fragmentSpread") {
      if (directiveSkip(sel.directives, ctx.vars)) continue;
      const frag = ctx.doc.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".` });
        continue;
      }
      Object.assign(out, resolveSelections(ctx, parentType, parent, frag.selections));
      continue;
    }
    if (sel.kind === "inlineFragment") {
      if (directiveSkip(sel.directives, ctx.vars)) continue;
      if (sel.typeCondition && sel.typeCondition !== parentType && sel.typeCondition !== parent.__typename) continue;
      Object.assign(out, resolveSelections(ctx, parentType, parent, sel.selections));
      continue;
    }
    const field = sel;
    if (directiveSkip(field.directives, ctx.vars)) continue;
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, parentType, parent, field);
    if (field.selections.length === 0 || value === null || value === undefined) {
      out[key] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((v) => projectValue(ctx, v, field.selections));
      continue;
    }
    out[key] = projectValue(ctx, value, field.selections);
  }
  return out;
}

function projectValue(ctx: Ctx, value: unknown, selections: SelectionNode[]): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  if (typeof v.__typename === "string") {
    return resolveSelections(ctx, v.__typename, v as Record<string, unknown> & { __typename: string }, selections);
  }
  // Plain object (e.g. connection nodes already wrapped, pageInfo, __type).
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind !== "field") continue;
    const key = sel.alias ?? sel.name;
    const raw = v[sel.name];
    if (sel.selections.length === 0 || raw === null || raw === undefined) {
      out[key] = raw ?? null;
      continue;
    }
    if (Array.isArray(raw)) {
      out[key] = raw.map((item) => projectValue(ctx, item, sel.selections));
    } else {
      out[key] = projectValue(ctx, raw, sel.selections);
    }
  }
  return out;
}

function executeOperation(
  ctx: Ctx,
  op: OperationNode,
): Record<string, unknown> {
  const vars: Record<string, unknown> = { ...ctx.vars };
  for (const def of op.varDefs) {
    if (vars[def.name] === undefined && def.defaultValue) {
      vars[def.name] = evalValue(def.defaultValue, ctx.vars);
    }
  }
  const opCtx: Ctx = { ...ctx, vars };
  const rootType = op.kind === "mutation" ? "Mutation" : "Query";
  const data = resolveSelections(opCtx, rootType, { __typename: rootType }, op.selections);
  const out: Record<string, unknown> = { data };
  if (opCtx.errors.length > 0) out.errors = opCtx.errors;
  return out;
}

export function executeGraphQL(
  store: Store,
  baseUrl: string,
  body: unknown,
): { status: number; body: string } {
  const runOne = (doc: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> => {
    const query = typeof doc.query === "string" ? doc.query : "";
    const variables = (doc.variables && typeof doc.variables === "object" ? doc.variables : {}) as Record<string, unknown>;
    const operationName = typeof doc.operationName === "string" ? doc.operationName : null;
    let parsed: DocumentNode;
    try {
      parsed = parseGraphQL(query);
    } catch (e) {
      return { errors: [{ message: e instanceof Error ? e.message : "Syntax Error" }] };
    }
    const ctx: Ctx = { store, baseUrl, doc: parsed, vars: variables, errors: [] };
    let op: OperationNode | undefined;
    if (operationName) {
      op = parsed.operations.find((o) => o.name === operationName);
    } else if (parsed.operations.length === 1) {
      op = parsed.operations[0];
    } else if (parsed.operations.length > 1) {
      return { errors: [{ message: "Must provide operation name if query contains multiple operations." }] };
    }
    if (!op) return { errors: [{ message: "No operation found." }] };
    return executeOperation(ctx, op);
  };
  try {
    if (Array.isArray(body)) {
      const results = body.map((item) => runOne((item ?? {}) as Record<string, unknown>));
      return { status: 200, body: JSON.stringify(results) };
    }
    if (body && typeof body === "object") {
      return { status: 200, body: JSON.stringify(runOne(body as Record<string, unknown>)) };
    }
    return { status: 400, body: JSON.stringify({ errors: [{ message: "Request body must be a JSON object." }] }) };
  } catch (e) {
    return { status: 200, body: JSON.stringify({ errors: [{ message: e instanceof Error ? e.message : "Internal error" }] }) };
  }
}

// Re-exported for the MCP layer (keeps one copy of the serializers).
export { serializeIssue, serializePull, serializeRepo };
export { flatTree };
export { userObject };
