export interface AgentIdentity {
  agentId: string;        // numeric string, e.g. "482913"
  address: string;        // "482913@mail.example.com"
}

export interface EmailSummary {
  id: string;             // ULID
  from: string;
  subject: string;
  receivedAt: string;     // ISO
}

export interface EmailFull extends EmailSummary {
  text: string;
  html?: string;
  links: string[];
}

export interface RegisterResponse extends AgentIdentity {}

// --- forge proxy DTOs (see docs/superpowers/specs/2026-08-20-forge-access-proxy-design.md) ---

export interface RepoRef {
  owner: string;
  name: string;
}

export interface ForgeFile {
  path: string;
  content: string;
}

export interface CommitSpec {
  branch: string;
  message: string;
  files: ForgeFile[];
}

export interface PrSpec {
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface RepoInfo {
  defaultBranch: string;
  headSha: string;
}

export interface CommitResult {
  sha: string;
  url: string;
}

export interface PrResult {
  number: number;
  url: string;
}

export interface CommentResult {
  id: number;
  url: string;
}
