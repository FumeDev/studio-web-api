import express, { Request, Response, NextFunction } from 'express';
import { Stagehand, StagehandOptions } from "@browserbasehq/stagehand";
import StagehandConfig from "./stagehand.config";
import { z } from "zod";
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const execAsync = promisify(exec);

const app = express();
app.use(express.json());

let stagehand: Stagehand | null = null;

// Add Zod schema for validation
const SetupAgentSchema = z.object({
    anthropicApiKey: z.string().min(1, "API key is required"),
    force: z.boolean().optional().default(false)
});

// Add error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Error:', err);
    res.status(500).json({
        success: false,
        error: err.message,
        details: err.stack
    });
});

// Start browser endpoint with automatic Google navigation
app.post('/start_browser', async (req, res) => {
    try {
        if (!stagehand) {
            console.log('Initializing Stagehand...');
            stagehand = new Stagehand(StagehandConfig);
            console.log('Stagehand instance created');
            await stagehand.init();
            console.log('Stagehand initialized successfully');
            
            // Maximize the browser window
            const page = stagehand.page;
            
            // Add script to prevent new tabs/windows
            await page.addInitScript(() => {
                window.open = function(url) {
                    window.location.href = url;
                    return null;
                };
                
                // Override target="_blank" behavior
                document.addEventListener('click', (e) => {
                    const target = e.target as HTMLElement;
                    if (target.tagName === 'A' && target.getAttribute('target') === '_blank') {
                        e.preventDefault();
                        window.location.href = (target as HTMLAnchorElement).href;
                    }
                }, true);
            });
            
            await page.evaluate(() => {
                window.moveTo(0, 0);
                window.resizeTo(screen.width, screen.height);
            });
            
            // Automatically navigate to Google
            console.log('Navigating to Google...');
            await stagehand.page.goto('https://www.google.com');
            console.log('Navigation to Google complete');
            
            res.json({ 
                success: true, 
                message: "Browser started successfully and navigated to Google" 
            });
        } else {
            res.json({ success: true, message: "Browser already running" });
        }
    } catch (error) {
        console.error('Error starting browser:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: error.stack
        });
    }
});

// New goto endpoint
app.post('/goto', async (req, res) => {
    try {
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

        res.json({ 
            success: true, 
            message: `Successfully navigated to ${url}` 
        });

    } catch (error) {
        console.error('Error in goto endpoint:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: error.stack
        });
    }
});

// Screenshot endpoint - only Chrome window
app.get('/screenshot', async (req, res) => {
    try {
        if (!stagehand?.page) {
            throw new Error("Browser not started");
        }

        // Take screenshot of just the browser viewport
        const screenshotBuffer = await stagehand.page.screenshot({
            fullPage: false, // Only capture current viewport
            scale: 'css', // Use CSS pixels
            animations: 'disabled', // Disable animations
            caret: 'hide', // Hide text cursor
            // Don't set a specific clip area to capture the entire viewport
            optimizations: false,
            timeout: 5000,
        });

        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': screenshotBuffer.length
        });
        res.end(screenshotBuffer);
    } catch (error) {
        console.error('Error taking screenshot:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: error.stack 
        });
    }
});

// Act endpoint
app.post('/act', async (req, res) => {
    try {
        if (!stagehand?.page) {
            throw new Error("Browser not started");
        }

        const { action, url } = req.body;
        
        if (!action) {
            throw new Error("Action description is required");
        }

        // If URL is provided, navigate to it first
        if (url) {
            console.log('Navigating to:', url);
            await stagehand.page.goto(url);
            console.log('Navigation complete');
        }

        console.log('Attempting to observe action:', action);
        
        // First observe the action
        const results = await stagehand.page.observe({
            instruction: action,
            onlyVisible: false,
            returnAction: true
        });
        
        console.log('Observe results:', results);
        
        // Then execute it
        if (results && results.length > 0) {
            await stagehand.page.act(results[0]);
            res.json({ success: true, message: "Action executed successfully" });
        } else {
            throw new Error("No actionable results found");
        }

    } catch (error) {
        console.error('Error in act endpoint:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: error.stack,
            config: {
                modelName: StagehandConfig.llm?.modelName,
                provider: StagehandConfig.llm?.client?.provider,
                apiKeyConfigured: !!StagehandConfig.llm?.client?.apiKey
            }
        });
    }
});

// Folder tree endpoint
app.get('/folder-tree', async (req: express.Request, res: express.Response) => {
    try {
        const folderPath = req.query.folder_path as string;
        if (!folderPath) {
            return res.status(400).json({ error: "folder_path query parameter is required" });
        }

        const documentsPath = path.join(os.homedir(), 'Documents');
        const command = `cd "${documentsPath}" && find "${folderPath}" -mindepth 1 -maxdepth 3`;
        
        const { stdout } = await execAsync(command);
        
        res.json({
            message: "Folder tree retrieved successfully",
            folder_path: folderPath,
            output: stdout
        });
    } catch (error) {
        console.error('Error in folder-tree endpoint:', error);
        res.status(500).json({ 
            success: false, 
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined
        });
    }
});

// Find repo endpoint
app.post('/find-repo', async (req: express.Request, res: express.Response) => {
    try {
        const { remote_url } = req.body;
        
        if (!remote_url) {
            return res.status(400).json({ error: "Remote URL not provided" });
        }

        const documentsPath = path.join(os.homedir(), 'Documents');
        const maxDepth = 3;

        // Function to get immediate subdirectories
        const getSubdirs = async (dirPath: string): Promise<string[]> => {
            try {
                const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
                return entries
                    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
                    .map(entry => path.join(dirPath, entry.name));
            } catch (error) {
                console.error(`Error reading directory ${dirPath}:`, error);
                return [];
            }
        };

        // Function to check if a directory is the target repo
        const isTargetRepo = async (dirPath: string): Promise<boolean> => {
            const gitConfigPath = path.join(dirPath, '.git', 'config');
            try {
                const configContent = await fs.promises.readFile(gitConfigPath, 'utf-8');
                return configContent.includes(remote_url);
            } catch {
                return false;
            }
        };

        // BFS implementation
        const visited = new Set<string>();
        let currentLayer = [documentsPath];
        let depth = 0;

        while (currentLayer.length > 0 && depth < maxDepth) {
            console.log(`Searching depth ${depth}...`);
            const nextLayer: string[] = [];

            // Process current layer
            for (const currentPath of currentLayer) {
                if (visited.has(currentPath)) continue;
                visited.add(currentPath);

                // Check if this is the target repo
                if (await isTargetRepo(currentPath)) {
                    const absPath = path.resolve(currentPath);
                    return res.json({
                        message: "Repository found",
                        path: absPath,
                        depth: depth
                    });
                }

                // Add subdirectories to next layer
                const subdirs = await getSubdirs(currentPath);
                nextLayer.push(...subdirs);
            }

            currentLayer = nextLayer;
            depth++;
        }

        return res.status(404).json({
            message: "Repository not found",
            path: null,
            max_depth_reached: depth >= maxDepth
        });

    } catch (error) {
        console.error('Error in find-repo endpoint:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
        });
    }
});

// Setup agent endpoint
app.post('/setup_agent', async (req: Request, res: Response) => {
    try {
        // Validate request body
        const { anthropicApiKey, force } = SetupAgentSchema.parse(req.body);

        // Check if agent already exists and is initialized
        if (stagehand) {
            if (!force) {
                return res.json({
                    success: true,
                    message: "Agent already initialized. Send force: true to reinitialize.",
                    status: "already_initialized"
                });
            }
            
            // If force is true, close existing instance
            console.log('Closing existing Stagehand instance...');
            await stagehand.close();
            stagehand = null;
        }

        // Create new config with provided API key
        const configWithKey: StagehandOptions = {
            browser: {
                headless: false,
                defaultViewport: null
            },
            llm: {
                modelName: 'claude-3-sonnet-20240229',
                client: {
                    provider: 'anthropic',
                    apiKey: anthropicApiKey
                }
            }
        };

        // Initialize new Stagehand instance
        console.log('Initializing Stagehand with provided API key...');
        try {
            stagehand = new Stagehand(configWithKey);
            await stagehand.init();
            console.log('Stagehand initialized successfully');

            res.json({
                success: true,
                message: "Agent setup completed successfully",
                status: force ? "reinitialized" : "initialized"
            });
        } catch (initError) {
            console.error('Stagehand initialization error:', initError);
            throw new Error(`Failed to initialize Stagehand: ${initError instanceof Error ? initError.message : 'Unknown error'}`);
        }

    } catch (error: unknown) {
        console.error('Error setting up agent:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined
        });
    }
});

const PORT = process.env.PORT || 5553;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 