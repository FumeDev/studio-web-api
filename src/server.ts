import express, { Request, Response, NextFunction } from 'express';
import { Stagehand } from "@browserbasehq/stagehand";
import StagehandConfig from "./stagehand.config";
import { z } from "zod";
import { exec } from 'child_process';
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
        // 1. Get the Anthropic API key from the request or environment
        const apiKey = req.body.apiKey || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error("Anthropic API key is required either in request body or as ANTHROPIC_API_KEY environment variable");
        }

        // 2. Build a new config that includes the correct anthropicApiKey property
        currentConfig = {
            browser: {
                ...StagehandConfig.browser,
                // Ensure we include the DISPLAY environment variable
                args: [
                    ...StagehandConfig.browser.args,
                    `--display=${process.env.DISPLAY || ':1'}`
                ]
            },
            llm: {
                provider: 'anthropic',
                // Make sure to name it anthropicApiKey
                anthropicApiKey: apiKey,
                modelName: 'claude-3-sonnet-20240229'
            }
        };

        // 3. If a Stagehand instance is already running, close it
        if (stagehand) {
            console.log('Closing existing Stagehand instance...');
            await stagehand.close();
        }

        // 4. Create a fresh Stagehand instance with the new config
        console.log('Creating new Stagehand instance...');
        stagehand = new Stagehand(currentConfig);

        // 5. Initialize (launch browser, etc.)
        await stagehand.init();
        console.log('Stagehand initialized successfully');

        // 6. (Optional) Navigate to Google
        console.log('Navigating to Google...');
        await stagehand.page.goto('https://www.google.com');
        console.log('Navigation to Google complete');

        return res.json({ 
            success: true,
            message: "Browser started successfully and navigated to Google"
        });

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
        if (!currentConfig?.llm?.anthropicApiKey) {
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
                anthropicApiKeySet: !!currentConfig?.llm?.anthropicApiKey
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
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
