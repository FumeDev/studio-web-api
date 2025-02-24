import { Stagehand } from "@browserbasehq/stagehand";
import dotenv from "dotenv";
import path from "path";
import * as os from 'os';
import * as fs from 'fs';

// Load .env from the root directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Helper to find Chrome path with better Linux support
function findChromePath(): string | undefined {
    const commonLocations = [
        // Linux
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        // macOS
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        // Windows
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    
    for (const location of commonLocations) {
        try {
            if (fs.existsSync(location)) {
                console.log(`Found Chrome/Chromium at: ${location}`);
                return location;
            }
        } catch (error) {
            // Ignore errors
        }
    }

    // If we can't find Chrome in common locations, try using 'which' on Linux/macOS
    if (os.platform() !== 'win32') {
        try {
            const { execSync } = require('child_process');
            const chromePath = execSync('which google-chrome || which chromium || which chromium-browser').toString().trim();
            if (chromePath) {
                console.log(`Found Chrome/Chromium using which: ${chromePath}`);
                return chromePath;
            }
        } catch (error) {
            // Ignore errors from which command
        }
    }

    console.warn("Could not find Chrome or Chromium executable");
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
            '--disable-software-rasterizer',
            
            // Explicitly set headless mode
            '--headless=new',
            
            // Disable D-Bus to avoid errors
            '--disable-dbus',
            
            // Session and popup management
            '--disable-session-crashed-bubble',
            '--no-restore-session-state',
            '--disable-session-service',
            '--disable-crash-reporter',
            '--restore-last-session=false',
            '--disable-popup-blocking',
            '--disable-infobars',
            '--disable-translate',
            '--disable-sync',
            '--no-default-browser-check',
            '--no-first-run',
            
            // Performance settings
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-networking',
            
            // Additional security settings
            '--disable-client-side-phishing-detection',
            '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync',
            '--silent-debugger-extension-api',
            
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
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            // Disable D-Bus
            DBUS_SESSION_BUS_ADDRESS: '/dev/null',
            CHROME_DBUS_DISABLE: '1'
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