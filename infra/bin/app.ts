import { App } from "aws-cdk-lib";
import { AgentIdentityStack } from "../lib/stack.js";

const app = new App();
const domain = app.node.tryGetContext("domain") ?? process.env.MAIL_DOMAIN;
if (!domain) throw new Error("Pass -c domain=mail.example.com or set MAIL_DOMAIN");

new AgentIdentityStack(app, "AgentIdentity", {
  domain,
  // SES inbound is only available in us-east-1, us-west-2, eu-west-1
  env: { region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
});
