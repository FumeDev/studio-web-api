import express, { Request, Response, NextFunction } from 'express';
import { Stagehand } from "@browserbasehq/stagehand";
import StagehandConfig from "./stagehand.config";
import { z } from "zod";
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const execAsync = promisify(exec);

const app = express();
app.use(express.json());

// We keep a single global Stagehand reference and a config
let stagehand: Stagehand | null = null;
let currentConfig: any = null;  // Holds dynamic runtime config (browser + LLM)
let xvfbProcess: ReturnType<typeof spawn> | null = null;

// Function to check if X server is running on the specified display
async function checkXvfbDisplay(display: string = ':1'): Promise<boolean> {
    try {
        await execAsync(`xdpyinfo -display ${display}`);
        console.log(`X server is running on display ${display}`);
        return true;
    } catch (error) {
        console.log(`X server is not running on display ${display}`);
        return false;
    }
}

// Function to start Xvfb on a display
async function startXvfb(display: string = ':1', width: number = 1280, height: number = 720): Promise<boolean> {
    try {
        // First kill any existing Xvfb on this display
        try {
            await execAsync(`pkill -f "Xvfb ${display}"`);
            console.log(`Killed existing Xvfb on ${display}`);
        } catch (error) {
            // It's ok if there's no process to kill
        }

        // Start Xvfb
        console.log(`Starting Xvfb on display ${display} with resolution ${width}x${height}`);
        xvfbProcess = spawn('Xvfb', [
            display,
            '-screen', '0', `${width}x${height}x24`,
            '-ac',
            '+extension', 'RANDR',
            '+extension', 'RENDER',
            '-noreset'
        ], {
            stdio: 'ignore',
            detached: true
        });

        // Keep track of the process for later cleanup
        xvfbProcess.unref();

        // Wait for Xvfb to start
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verify Xvfb is running
        return await checkXvfbDisplay(display);
    } catch (error) {
        console.error(`Failed to start Xvfb: ${error}`);
        return false;
    }
}

// ---- Error Handling Middleware ----
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('Error:', err);
    res.status(500).json({
        success: false,
        error: err.message,
        details: err.stack
    });
});

// ---- 1. Start Browser Endpoint ----
app.post('/start_browser', async (req: Request, res: Response) => {
    try {
        // If browser is already running, just return success
        if (stagehand?.page) {
            return res.json({ 
                success: true,
                message: "Using existing browser session"
            });
        }

        // Check if X server is running, if not start it
        const display = process.env.DISPLAY || ':1';
        const xvfbRunning = await checkXvfbDisplay(display);
        
        if (!xvfbRunning) {
            console.log('X server not running, attempting to start Xvfb');
            const started = await startXvfb(display);
            if (!started) {
                return res.status(500).json({
                    success: false,
                    error: `Failed to start Xvfb on display ${display}. Please ensure Xvfb is installed.`
                });
            }
        }

        // 2. Build LLM config based on environment variables
        let llmConfig;
        if (process.env.ANTHROPIC_API_KEY) {
            llmConfig = {
                provider: 'anthropic',
                anthropicApiKey: process.env.ANTHROPIC_API_KEY,
                modelName: 'claude-3-5-sonnet-20241022',
                temperature: 0.7,
                maxTokens: 4096
            };
        } else if (process.env.OPENAI_API_KEY) {
            llmConfig = {
                provider: 'openai',
                openaiApiKey: process.env.OPENAI_API_KEY,
                modelName: 'gpt-4o',
                temperature: 0.7,
                maxTokens: 4096
            };
        } else {
            throw new Error("Either ANTHROPIC_API_KEY or OPENAI_API_KEY must be set in environment variables");
        }

        // 3. Build the complete config with updated browser settings
        currentConfig = {
            ...StagehandConfig,  // Use all base config
            browser: {
                ...StagehandConfig.browser,  // Keep base browser settings
                headless: false,  // Required for VNC
                args: [
                    ...StagehandConfig.browser.args,  // Keep base args
                    // Additional runtime args if needed
                ],
                defaultViewport: {
                    width: 1280,
                    height: 720
                },
                ignoreHTTPSErrors: true
            },
            llm: llmConfig,
            launchOptions: {
                ...StagehandConfig.launchOptions,
                env: {
                    ...process.env,
                    DISPLAY: display,
                    DBUS_SESSION_BUS_ADDRESS: '/dev/null',
                    CHROME_DBUS_DISABLE: '1'
                }
            }
        };

        console.log('Creating Stagehand with config:', {
            ...currentConfig,
            llm: {
                ...currentConfig.llm,
                anthropicApiKey: currentConfig.llm.anthropicApiKey ? '***' : undefined,
                openaiApiKey: currentConfig.llm.openaiApiKey ? '***' : undefined
            }
        });

        // Create a fresh Stagehand instance with the new config
        console.log('Creating new Stagehand instance...');
        
        // Try multiple times to initialize the browser, with a delay between attempts
        const maxRetries = 3;
        let lastError = null;
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                console.log(`Browser launch attempt ${attempt + 1}/${maxRetries}`);
                stagehand = new Stagehand(currentConfig);
                
                // Initialize (launch browser, etc.)
                await stagehand.init();
                console.log('Stagehand initialized successfully');
                
                // Navigate to Google
                console.log('Navigating to Google...');
                await stagehand.page.goto('https://www.google.com');
                console.log('Navigation to Google complete');
                
                return res.json({ 
                    success: true,
                    message: `Browser started successfully on attempt ${attempt + 1} and navigated to Google`
                });
            } catch (error) {
                lastError = error;
                console.error(`Attempt ${attempt + 1} failed:`, error);
                
                // Clean up failed instance
                if (stagehand) {
                    try {
                        await stagehand.close();
                    } catch (closeError) {
                        console.error('Error closing stagehand:', closeError);
                    }
                    stagehand = null;
                }
                
                // Wait before retrying
                if (attempt < maxRetries - 1) {
                    console.log(`Waiting 5 seconds before retry ${attempt + 2}...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        }
        
        // If we get here, all attempts failed
        throw lastError || new Error("Failed to initialize browser after multiple attempts");

    } catch (error: unknown) {
        console.error('Error starting browser:', error);
        stagehand = null;        // Reset on failure
        currentConfig = null;
        return res.status(500).json({ 
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined
        });
    }
});

// ---- 2. "Goto" Endpoint ----
app.post('/goto', async (req: Request, res: Response) => {
    try {
        // Must have an initialized Stagehand
        if (!stagehand?.page) {
            throw new Error("Browser not started");
        }

        const { url } = req.body;
        if (!url) {
            throw new Error("URL is required");
        }

        console.log('Navigating to:', url);
        await stagehand.page.goto(url);
        console.log('Navigation complete');

        return res.json({
            success: true,
            message: `Successfully navigated to ${url}`
        });

    } catch (error: unknown) {
        console.error('Error in goto endpoint:', error);
        return res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined
        });
    }
});

// ---- 3. Screenshot Endpoint ----
app.get('/screenshot', async (req: Request, res: Response) => {
    try {
        if (!stagehand?.page) {
            throw new Error("Browser not started");
        }

        // Capture only the current viewport
        const screenshotBuffer = await stagehand.page.screenshot({
            fullPage: false,
            scale: 'css',
            animations: 'disabled',
            caret: 'hide',
            timeout: 5000
        });

        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': screenshotBuffer.length
        });
        res.end(screenshotBuffer);

    } catch (error: unknown) {
        console.error('Error taking screenshot:', error);
        return res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined
        });
    }
});

// ---- 4. "Act" Endpoint ----
app.post('/act', async (req: Request, res: Response) => {
    try {
        // Must have a valid browser session
        if (!stagehand?.page) {
            throw new Error("Browser not started");
        }
        // Must have a valid LLM config
        if (!currentConfig?.llm?.anthropicApiKey && !currentConfig?.llm?.openaiApiKey) {
            throw new Error("LLM configuration not set. Please start the browser first with an API key.");
        }

        const { action, url } = req.body;
        if (!action) {
            throw new Error("Action description is required");
        }

        // If a URL is provided, navigate first
        if (url) {
            console.log('Navigating to:', url);
            await stagehand.page.goto(url);
            console.log('Navigation complete');
        }

        console.log('Attempting action:', action);
        // Stagehand .act(...) call
        await stagehand.page.act(action);

        return res.json({ success: true, message: "Action executed successfully" });

    } catch (error: unknown) {
        console.error('Error in act endpoint:', error);
        return res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined,
            // We log some debug info about currentConfig
            config: {
                modelName: currentConfig?.llm?.modelName,
                provider: currentConfig?.llm?.provider,
                // Are we sure we have a key?
                anthropicApiKeySet: !!currentConfig?.llm?.anthropicApiKey,
                openaiApiKeySet: !!currentConfig?.llm?.openaiApiKey
            }
        });
    }
});

// ---- 5. Folder Tree Endpoint ----
app.get('/folder-tree', async (req: Request, res: Response) => {
    try {
        const folderPath = req.query.folder_path as string;
        if (!folderPath) {
            return res.status(400).json({ error: "folder_path query parameter is required" });
        }

        const documentsPath = path.join(os.homedir(), 'Documents');

        // Verify Documents exists
        if (!fs.existsSync(documentsPath)) {
            return res.status(404).json({
                error: "Documents directory not found",
                path: documentsPath
            });
        }

        // Attempt to run a 'find' command up to -maxdepth 3
        const command = `cd "${documentsPath}" && find "${folderPath}" -mindepth 1 -maxdepth 3 2>/dev/null || echo "No files found"`;

        const { stdout } = await execAsync(command);
        if (!stdout.trim()) {
            return res.status(404).json({
                message: "No files found in the specified path",
                folder_path: folderPath
            });
        }

        return res.json({
            message: "Folder tree retrieved successfully",
            folder_path: folderPath,
            output: stdout.split('\n').filter(Boolean)
        });

    } catch (error: unknown) {
        console.error('Error in folder-tree endpoint:', error);
        return res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined
        });
    }
});

// ---- 6. Find Repo Endpoint ----
app.post('/find-repo', async (req: express.Request, res: express.Response) => {
    try {
        const { remote_url } = req.body;
        if (!remote_url) {
            return res.status(400).json({ error: "Remote URL not provided" });
        }

        const documentsPath = path.join(os.homedir(), 'Documents');
        const maxDepth = 3;

        // 1) Helper: get immediate subdirs (non-hidden)
        const getSubdirs = async (dirPath: string): Promise<string[]> => {
            try {
                const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
                return entries
                    .filter((entry: fs.Dirent) => entry.isDirectory() && !entry.name.startsWith('.'))
                    .map((entry: fs.Dirent) => path.join(dirPath, entry.name));
            } catch (error) {
                console.error(`Error reading directory ${dirPath}:`, error);
                return [];
            }
        };

        // 2) Helper: check if a given directory is the target repo
        const isTargetRepo = async (dirPath: string): Promise<boolean> => {
            const gitConfigPath = path.join(dirPath, '.git', 'config');
            try {
                const configContent = await fs.promises.readFile(gitConfigPath, 'utf-8');
                // If the .git/config references remote_url, it's our repo
                return configContent.includes(remote_url);
            } catch {
                return false;
            }
        };

        // 3) Perform BFS up to maxDepth
        const visited = new Set<string>();
        let currentLayer = [documentsPath];
        let depth = 0;

        while (currentLayer.length > 0 && depth < maxDepth) {
            console.log(`Searching depth ${depth}...`);
            const nextLayer: string[] = [];

            for (const currentPath of currentLayer) {
                if (visited.has(currentPath)) continue;
                visited.add(currentPath);

                // Check if it's the target repo
                if (await isTargetRepo(currentPath)) {
                    const absPath = path.resolve(currentPath);
                    return res.json({
                        message: "Repository found",
                        path: absPath,
                        depth
                    });
                }

                // Otherwise, add subdirectories
                const subdirs = await getSubdirs(currentPath);
                nextLayer.push(...subdirs);
            }
            currentLayer = nextLayer;
            depth++;
        }

        // If we exhaust BFS without finding it
        return res.status(404).json({
            message: "Repository not found",
            path: null,
            max_depth_reached: depth >= maxDepth
        });

    } catch (error: unknown) {
        console.error('Error in find-repo endpoint:', error);
        return res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
        });
    }
});

// ---- Server Listen ----
const PORT = process.env.PORT || 5553;
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Cleanup function to handle server shutdown
function cleanup() {
    console.log('Server shutting down...');
    
    // Close Stagehand instance if it exists
    if (stagehand) {
        try {
            console.log('Closing browser...');
            stagehand.close();
        } catch (error) {
            console.error('Error closing browser:', error);
        }
        stagehand = null;
    }
    
    // Kill Xvfb if we started it
    if (xvfbProcess && xvfbProcess.pid) {
        try {
            console.log('Killing Xvfb process...');
            process.kill(-xvfbProcess.pid, 'SIGKILL');
        } catch (error) {
            console.error('Error killing Xvfb process:', error);
        }
        xvfbProcess = null;
    }
    
    console.log('Cleanup complete');
}

// Register cleanup handlers
process.on('exit', cleanup);
process.on('SIGINT', () => {
    console.log('Received SIGINT');
    cleanup();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('Received SIGTERM');
    cleanup();
    process.exit(0);
});
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    cleanup();
    process.exit(1);
});
