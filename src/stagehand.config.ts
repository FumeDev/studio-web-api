import { StagehandConfig } from "@browserbasehq/stagehand";

const config: StagehandConfig = {
    env: "LOCAL",
    llm: {
        modelName: "claude-3-sonnet-20240229",
        client: {
            provider: "anthropic",
            apiKey: ""
        }
    },
    browser: {
        headless: false,
        defaultViewport: null
    },
    slowMo: 50,
    debug: true,
    launchOptions: {
        args: ['--start-maximized'],
    },
    contextOptions: {
        handleSIGINT: true,
        handleSIGTERM: true,
        handleSIGHUP: true,
    },
    routeOptions: {
        async onNewPage(page) {
            const url = page.url();
            await page.close();
            if (stagehand?.page) {
                await stagehand.page.goto(url);
            }
        }
    }
};

console.log("Config:", {
    modelName: config.llm.modelName,
    provider: config.llm.client.provider,
    apiKeyConfigured: !!config.llm.client.apiKey
});

export default config;