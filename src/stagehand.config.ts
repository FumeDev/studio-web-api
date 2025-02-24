import { Stagehand } from "@browserbasehq/stagehand";
import dotenv from "dotenv";
import path from "path";
import * as os from 'os';

// Load .env from the root directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Helper to find Chrome path
function findChromePath(): string | undefined {
    const commonLocations = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    
    return commonLocations.find(location => {
        try {
            return require('fs').existsSync(location);
        } catch {
            return false;
        }
    });
}

// Define the configuration object with the structure expected by the server code
const config = {
    env: "LOCAL",
    browser: {
        headless: false,  // Required for VNC display
        args: [
            // Core settings
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            
            // Display settings
            '--start-maximized',
            '--force-device-scale-factor=1.25',
            
            // D-Bus related flags
            '--disable-dbus',
            '--disable-notifications',
            '--disable-features=MediaRouter,WebRTC',
            
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
        executablePath: process.env.CHROME_PATH || findChromePath(),
        env: {
            ...process.env,
            DISPLAY: process.env.DISPLAY || ':1',
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
    display: process.env.DISPLAY || ':1',
    chromePath: config.launchOptions.executablePath
});

export default config; 