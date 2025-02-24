import { Stagehand } from "@browserbasehq/stagehand";
import dotenv from "dotenv";
import path from "path";
import * as os from 'os';
import * as fs from 'fs';

// Load .env from the root directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Helper to find Chrome path
function findChromePath(): string | undefined {
    const commonLocations = [
        // macOS
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        // Windows
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    
    for (const location of commonLocations) {
        try {
            if (fs.existsSync(location)) {
                console.log(`Found Chrome at: ${location}`);
                return location;
            }
        } catch (error) {
            // Ignore errors
        }
    }

    console.warn("Could not find Chrome executable");
    return undefined;
}

// Get Chrome path
const chromePath = process.env.CHROME_PATH || findChromePath();

// Define the configuration object with the structure expected by the server code
const config = {
    env: "LOCAL",
    browser: {
        headless: "new",  // Use the new headless mode
        args: [
            // Core settings
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            
            // Explicitly set headless mode
            '--headless=new',
            
            // Session and popup management
            '--disable-session-crashed-bubble',
            '--no-restore-session-state',
            '--disable-crash-reporter',
            '--restore-last-session=false',
            '--disable-popup-blocking',
            '--disable-infobars',
            '--disable-translate',
            '--no-default-browser-check',
            '--no-first-run',
            
            // Performance settings
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            
            // Window size
            '--window-size=1280,720'
        ]
    },
    slowMo: 50,
    debug: true,
    launchOptions: {
        executablePath: chromePath,
        // Explicitly set environment variables
        env: {
            ...process.env,
            // Force API keys to be set from .env file
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY
        }
    },
    contextOptions: {
        viewport: {
            width: 1280,
            height: 720
        }
    }
};

console.log("Config:", {
    modelName: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
    chromePath: chromePath || "Not found",
    headless: "new"
});

export default config; 