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
