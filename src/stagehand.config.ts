import { StagehandConfig } from "@browserbasehq/stagehand";
import dotenv from "dotenv";
import path from "path";

// Load .env from the root directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY must be set in .env");
}

const config: StagehandConfig = {
    env: "LOCAL",
    llm: {
        modelName: "claude-3-sonnet-20240229",
        client: {
            provider: "anthropic",
            apiKey: process.env.ANTHROPIC_API_KEY || ''
        }
    },
    browser: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    },
    slowMo: 50,
    debug: true,
    launchOptions: {
        args: ['--start-maximized']
    },
    contextOptions: {
        viewport: null,
        handleSIGINT: true,
        handleSIGTERM: true,
        handleSIGHUP: true
    }
};

console.log("Config:", {
    modelName: config.llm.modelName,
    provider: config.llm.client.provider,
    apiKeyConfigured: !!config.llm.client.apiKey
});

export default config; 