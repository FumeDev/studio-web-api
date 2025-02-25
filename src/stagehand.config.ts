import type { ConstructorParams, LogLine } from "@browserbasehq/stagehand";
import dotenv from "dotenv";

dotenv.config();

const StagehandConfig: ConstructorParams = {
    env: "LOCAL",
    apiKey: process.env.BROWSERBASE_API_KEY /* API key for authentication */,
    projectId: process.env.BROWSERBASE_PROJECT_ID /* Project identifier */,
    debugDom: undefined /* Enable DOM debugging features */,
    headless: true /* Run browser in headless mode */,
    logger: (message: LogLine) =>
        console.log(message) /* Custom logging function */,
    domSettleTimeoutMs: 30_000 /* Timeout for DOM to settle in milliseconds */,
    browserbaseSessionCreateParams: {
        projectId: process.env.BROWSERBASE_PROJECT_ID!,
    },
    enableCaching: undefined /* Enable caching functionality */,
    browserbaseSessionID:
        undefined /* Session ID for resuming Browserbase sessions */,
    modelName: "claude-3-5-sonnet-20241022" /* Name of the model to use */,
    modelClientOptions: {
        apiKey: process.env.ANTHROPIC_API_KEY,
    } /* Configuration options for the model client */
};

console.log("Config:", {
    modelName: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
    headless: "new"
});

export default StagehandConfig; 