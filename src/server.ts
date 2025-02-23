import express from 'express';
import { Stagehand } from "@browserbasehq/stagehand";
import StagehandConfig from "./stagehand.config";
import { z } from "zod";
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
dotenv.config();

const execAsync = promisify(exec);

const app = express();
app.use(express.json());

let stagehand: Stagehand | null = null;

// Add error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('Error:', err);
    res.status(500).json({
        success: false,
        error: err.message,
        details: err.stack
    });
});

// Start browser endpoint with automatic Google navigation
app.post('/start_browser', async (req: Request, res: Response) => {
    try {
        if (!stagehand) {
            console.log('Initializing Stagehand...');
            
            // Get API key from request body
            const apiKey = req.body.apiKey;
            if (!apiKey) {
                throw new Error("Anthropic API key is required in request body");
            }

            // Make sure DISPLAY is set
            if (!process.env.DISPLAY) {
                console.log('DISPLAY not set, defaulting to :1');
                process.env.DISPLAY = ':1';
            }
            
            stagehand = new Stagehand({
                ...StagehandConfig,
                browser: {
                    ...StagehandConfig.browser,
                    args: [
                        ...StagehandConfig.browser.args,
                        `--display=${process.env.DISPLAY}`
                    ]
                },
                llm: {
                    ...StagehandConfig.llm,
                    client: {
                        provider: 'anthropic',
                        apiKey: apiKey,
                        modelName: 'claude-3-sonnet-20240229'
                    }
                }
            });
            
            console.log('Stagehand instance created');
            
            try {
                await stagehand.init();
                console.log('Stagehand initialized successfully');
                
                // Navigate to Google
                console.log('Navigating to Google...');
                await stagehand.page.goto('https://www.google.com');
                console.log('Navigation to Google complete');
                
                res.json({ 
                    success: true, 
                    message: "Browser started successfully and navigated to Google" 
                });
            } catch (initError) {
                console.error('Failed to initialize Stagehand:', initError);
                stagehand = null; // Reset stagehand on failure
                throw initError;
            }
        } else {
            res.json({ success: true, message: "Browser already running" });
        }
    } catch (error: unknown) {
        console.error('Error starting browser:', error);
        res.status(500).json({ 
            success: false, 
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined
        });
    }
});

// New goto endpoint
app.post('/goto', async (req: Request, res: Response) => {
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

    } catch (error: unknown) {
        console.error('Error in goto endpoint:', error);
        res.status(500).json({ 
            success: false, 
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined
        });
    }
});

// Screenshot endpoint - only Chrome window
app.get('/screenshot', async (req: Request, res: Response) => {
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
            timeout: 5000,
            // Remove optimizations option as it's not supported
        });

        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': screenshotBuffer.length
        });
        res.end(screenshotBuffer);
    } catch (error: unknown) {
        console.error('Error taking screenshot:', error);
        res.status(500).json({ 
            success: false, 
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined
        });
    }
});

// Act endpoint
app.post('/act', async (req: Request, res: Response) => {
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

    } catch (error: unknown) {
        console.error('Error in act endpoint:', error);
        res.status(500).json({ 
            success: false, 
            error: error instanceof Error ? error.message : 'Unknown error',
            details: error instanceof Error ? error.stack : undefined,
            config: {
                modelName: StagehandConfig.llm?.modelName,
                provider: StagehandConfig.llm?.client?.provider,
                apiKeyConfigured: !!StagehandConfig.llm?.client?.apiKey
            }
        });
    }
});

// Folder tree endpoint
app.get('/folder-tree', async (req: Request, res: Response) => {
    try {
        const folderPath = req.query.folder_path as string;
        if (!folderPath) {
            return res.status(400).json({ error: "folder_path query parameter is required" });
        }

        const documentsPath = path.join(os.homedir(), 'Documents');
        
        // Check if Documents directory exists
        if (!fs.existsSync(documentsPath)) {
            return res.status(404).json({ 
                error: "Documents directory not found",
                path: documentsPath
            });
        }

        // Use the actual folder path instead of "Documents"
        const command = `cd "${documentsPath}" && find "${folderPath}" -mindepth 1 -maxdepth 3 2>/dev/null || echo "No files found"`;
        
        const { stdout } = await execAsync(command);
        
        if (!stdout.trim()) {
            return res.status(404).json({
                message: "No files found in the specified path",
                folder_path: folderPath
            });
        }
        
        res.json({
            message: "Folder tree retrieved successfully",
            folder_path: folderPath,
            output: stdout.split('\n').filter(Boolean)
        });
    } catch (error: unknown) {
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
                    .filter((entry: fs.Dirent) => entry.isDirectory() && !entry.name.startsWith('.'))
                    .map((entry: fs.Dirent) => path.join(dirPath, entry.name));
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

    } catch (error: unknown) {
        console.error('Error in find-repo endpoint:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
        });
    }
});

const PORT = process.env.PORT || 5553;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 