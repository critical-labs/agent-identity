// Minimal ambient types for the parts of @critical-labs/qa-conductor that
// packages/qa uses. qa-conductor ships plain JS with no types; these mirror
// its README and lib/ at v0.2.0 and keep the root `tsc --noEmit` green.

declare module "@critical-labs/qa-conductor" {
  import type { Server } from "node:http";
  import type { ConductorConfig } from "@critical-labs/qa-conductor/config";
  import type { Github } from "@critical-labs/qa-conductor/github";

  export type Role = "base" | "pr";
  /** Service name → env for that service. */
  export type PaneEnv = Record<string, Record<string, string>>;

  export interface PaneRef {
    role: Role;
    slug?: string;
    publicOrigin?: string;
  }

  export interface ReservedService {
    url: string;
    port: number;
  }

  /** What the core hands derivePaneEnv / establishSession for one pane. */
  export interface Pane<Db = unknown> {
    ref: PaneRef;
    dsn: string | null;
    db: Db;
    services: Record<string, ReservedService>;
    publicOrigin: string;
    env?: PaneEnv;
  }

  export interface Provisioner {
    provisionDatabase(args: { paneRef: PaneRef; databases: string[]; signal?: AbortSignal }): Promise<{ dsn: string | null; db: unknown }>;
    reserveServices(args: { paneRef: PaneRef; services: Record<string, unknown>; signal?: AbortSignal }): Promise<Record<string, ReservedService>>;
    launchServices(args: {
      paneRef: PaneRef; services: Record<string, unknown>; env: PaneEnv;
      reserved: Record<string, ReservedService>; signal?: AbortSignal;
    }): Promise<void>;
    waitHealthy(args: { services: Record<string, ReservedService>; signal?: AbortSignal }): Promise<void>;
    teardown(args: { paneRef: Pick<PaneRef, "role"> }): Promise<void>;
    sweep?(): Promise<void>;
    logs?(args: { paneRef: Pick<PaneRef, "role">; stage?: string; lines?: number }): Promise<string> | string;
  }

  export interface ResolvedImages {
    services: Record<string, unknown>;
    migrate?: unknown;
    label?: string;
  }

  export interface PrReadiness {
    number: number;
    status: "built" | "building" | "none" | "blocked";
    runUrl: string | null;
    reason?: string;
  }

  export interface BuildConvention {
    migrationStrategy: "one-shot-image" | "on-boot" | "none";
    ensureBuilt(pr: number, opts?: { signal?: AbortSignal }): Promise<void>;
    resolvePrImages(pr: number): Promise<ResolvedImages>;
    resolveBaseImages(): Promise<ResolvedImages>;
    subscribeBuild?(cb: (progress: { runUrl?: string; runStatus?: string; message?: string }) => void): void;
    describePrs?(prs: unknown[]): Promise<PrReadiness[]>;
  }

  // Method syntax on purpose: parameters stay bivariant, so an adapter typed
  // with its own `db` shape still fits the core's opaque `db`.
  export interface Seed<Db = unknown> {
    databases: string[];
    seedPane(args: { paneRef: PaneRef; db: Db; databases: string[] }): Promise<void>;
  }

  export interface EnvTransform<Db = unknown> {
    derivePaneEnv(args: { prodEnv: Record<string, string>; pane: Pane<Db> }): PaneEnv;
  }

  export interface SessionResult {
    landingUrl: string;
  }

  export interface AuthBootstrap<Db = unknown> {
    requiresDb: boolean;
    establishSession(args: { pane: Pane<Db>; operator?: string | null; db?: Db }): Promise<SessionResult>;
    envContributions?(): PaneEnv;
  }

  export interface Adapters {
    provisioner: Provisioner;
    build: BuildConvention;
    seed: Seed;
    envTransform: EnvTransform;
    auth: AuthBootstrap;
  }

  export interface Conductor {
    servers: { harness: Server; baseProxy: Server; prProxy: Server };
    stop(): void;
    shutdown(): Promise<void>;
  }

  export function startConductor(opts: {
    cfg: ConductorConfig;
    github: Github;
    fsx: { readFile(path: string): Promise<Buffer | string> };
    adapters: Adapters;
    readBaseEnv?: () => Promise<Record<string, string>>;
    publicDir?: string;
    log?: Pick<Console, "log" | "warn" | "error">;
  }): Conductor;
}

declare module "@critical-labs/qa-conductor/config" {
  export interface ConductorConfig {
    /** The raw KEY=value map (defaults, then the file), for app keys. */
    env: Record<string, string>;
    githubToken: string;
    operatorEmail: string | null;
    repo: string;
    publicHost: string | null;
    idleMinutes: number;
    host: string;
    allowedHosts: string[];
    ports: { harness: number; base: number; pr: number };
    paneOrigins: { base: string; pr: string };
    verdictLabels: { accept: string; reject: string };
  }

  export function parseEnvFile(envFilePath: string): Record<string, string>;
  export function loadConfig(
    envFilePath: string,
    opts?: { defaults?: Record<string, string>; required?: string[] },
  ): ConductorConfig;
}

declare module "@critical-labs/qa-conductor/github" {
  export interface PrInfo {
    number: number;
    headSha: string;
    author: string | null;
    authorAssociation: string | null;
    isDraft: boolean;
    headRepo: string | null;
    headOwner: string | null;
  }

  export interface OpenPr {
    number: number;
    title: string;
    headSha: string;
    headRef: string;
    author: string;
    authorAssociation: string | null;
    headRepo: string | null;
    headOwner: string | null;
  }

  export interface Github {
    listOpenPrs(): Promise<OpenPr[]>;
    prHead(num: number): Promise<string>;
    prInfo(num: number): Promise<PrInfo>;
    authorPermission(login: string): Promise<string>;
    postComment(num: number, body: string): Promise<string>;
    setQaLabel(num: number, label: string): Promise<void>;
  }

  export function createGithub(opts: {
    token: string;
    repo: string;
    qaLabels?: string[];
    fetchFn?: typeof fetch;
  }): Github;
}

declare module "@critical-labs/qa-conductor/adapters/build-worktree" {
  import type { BuildConvention, Role } from "@critical-labs/qa-conductor";
  import type { Github } from "@critical-labs/qa-conductor/github";

  export interface WorktreeTrust {
    logins?: string[];
    associations?: string[];
    requirePush?: boolean;
    allowForks?: boolean;
  }

  export interface WorktreeInstall {
    cmd: string;
    args?: string[];
    env?: Record<string, string>;
  }

  export interface WorktreeBuildOptions {
    repo: string;
    cloneUrl?: string;
    cacheDir: string;
    github: Pick<Github, "prInfo" | "authorPermission">;
    servicesFor(dir: string, ctx: { role: Role; sha: string }): Record<string, unknown> | Promise<Record<string, unknown>>;
    install?: WorktreeInstall | null;
    baseRef?: string;
    trust?: WorktreeTrust;
    keep?: number;
    migrationStrategy?: BuildConvention["migrationStrategy"];
  }

  export function createWorktreeBuild(opts: WorktreeBuildOptions): BuildConvention & {
    subscribeBuild(cb: (progress: { message?: string }) => void): void;
    describePrs(prs: unknown[]): Promise<import("@critical-labs/qa-conductor").PrReadiness[]>;
  };
}

declare module "@critical-labs/qa-conductor/adapters/provisioner-process" {
  import type { PaneRef, Provisioner } from "@critical-labs/qa-conductor";

  export interface ProcessSpec {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }

  export interface ProcessDatabase<Db = unknown> {
    command(args: { paneRef: PaneRef; port: number }): ProcessSpec;
    ready(args: { port: number; signal?: AbortSignal }): Promise<void>;
    handle(args: { paneRef: PaneRef; port: number }): { dsn: string; db: Db };
  }

  export interface ProcessProvisionerOptions {
    /** `ref` is the service's entry from the BuildConvention: with
     *  build-worktree, the checkout directory. */
    command(args: { name: string; ref: string; port: number; env: Record<string, string>; paneRef: PaneRef }): ProcessSpec;
    database?: ProcessDatabase | null;
    healthPath?: string | ((name: string) => string);
    healthy?(status: number): boolean;
    healthTimeoutMs?: number;
    stateDir: string;
    host?: string;
    graceMs?: number;
    logLines?: number;
    log?: Pick<Console, "log" | "warn" | "error">;
  }

  export function createProcessProvisioner(opts: ProcessProvisionerOptions): Provisioner;
}
