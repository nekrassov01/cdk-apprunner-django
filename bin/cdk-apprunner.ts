#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import "source-map-support/register";
import { AppRunnerDemoStack } from "../lib/cdk-apprunner-stack";

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Deploy stacks
const app = new App();
new AppRunnerDemoStack(app, "AppRunnerDemoStack", {
  env: env,
  terminationProtection: false,
});

// Tagging all resources
Tags.of(app).add("Owner", app.node.tryGetContext("owner"));
