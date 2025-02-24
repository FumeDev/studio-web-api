import { Stagehand } from "@browserbasehq/stagehand";
import dotenv from "dotenv";
import path from "path";

// Load .env from the root directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Define the configuration object with the structure expected by the server code
const config = {
    env: "LOCAL",
    browser: {
        headless: true,  // Always use headless mode
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer'
        ]
    },
    slowMo: 50,
    debug: true,
    launchOptions: {
        args: ['--start-maximized'],
        executablePath: process.env.CHROME_PATH || undefined
    },
    contextOptions: {
        viewport: null,
        handleSIGINT: true,
        handleSIGTERM: true,
        handleSIGHUP: true,
    },
    routeOptions: {
        async onNewPage(page: any) {
            const url = page.url();
            await page.close();
            if ((global as any).stagehand?.page) {
                await (global as any).stagehand.page.goto(url);
            }
        }
    }
};

console.log("Config:", {
    modelName: "claude-3-5-sonnet-20241022", // Using the updated model name
    provider: "anthropic",
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
    display: process.env.DISPLAY || ':1'
});

export default config; 