import express, { Request, Response, NextFunction } from "express";
import { Stagehand } from "../lib/stagehand/dist";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import dotenv from "dotenv";
import Docker from 'dockerode';
import { ProcessManager } from './executeCommand.js';
import axios from 'axios';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import * as http from 'http';
import * as https from 'https';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import wrtc from '@roamhq/wrtc';
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc;
const { RTCVideoSource } = wrtc.nonstandard;
import { createCanvas, loadImage } from 'canvas';

dotenv.config();

// BunnyCDN Configuration
const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE || 'fume';
const BUNNY_REGION = process.env.BUNNY_REGION || 'la';
const BUNNY_API_KEY = process.env.BUNNY_API_KEY || '47be9f34-1258-4d6b-8c3f9a2965c3-4730-4e3f';
const BUNNY_STORAGE_URL = `https://${BUNNY_REGION}.storage.bunnycdn.com/${BUNNY_STORAGE_ZONE}/`;

const DEFAULT_VIEWPORT_SIZE = { width: 1500, height: 800 };
const LARGE_VIEWPORT_SIZE = { width: 1890, height: 1024 };

/**
 * Uploads a file to BunnyCDN storage
 * @param {string} localFilePath - Path to the file on local filesystem
 * @param {string} remoteFilePath - Destination path in BunnyCDN (without storage zone prefix)
 * @returns {Promise<{success: boolean, url: string, error?: string}>}
 */
async function uploadToBunnyStorage(localFilePath: string, remoteFilePath: string): Promise<{success: boolean, url: string, error?: string}> {
  try {
    // Ensure the file exists
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`File not found: ${localFilePath}`);
    }

    // Create file read stream
    const fileStream = createReadStream(localFilePath);
    
    // Full URL for the file in BunnyCDN
    const uploadUrl = `${BUNNY_STORAGE_URL}${remoteFilePath}`;
    
    // Upload the file with explicit proxy configuration to avoid environment variables
    await axios.put(uploadUrl, fileStream, {
      headers: {
        'AccessKey': BUNNY_API_KEY,
        'Content-Type': 'application/octet-stream',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      // Explicitly disable proxy to avoid SOCKS5 protocol mismatch errors
      proxy: false
    });

    // Return success with the CDN URL
    return {
      success: true,
      url: `https://${BUNNY_STORAGE_ZONE}.b-cdn.net/${remoteFilePath}`
    };
  } catch (error) {
    console.error('BunnyCDN upload error:', error);
    
    // Check for the specific SOCKS5 protocol mismatch error
    if (error instanceof Error && 
        (error.message.includes('protocol mismatch') || 
         error.message.includes('socks5:'))) {
      console.warn('Detected proxy configuration issue. Trying again with explicit HTTP agent...');
      
      try {
        // Create new HTTP and HTTPS agents
        const httpAgent = new http.Agent({ keepAlive: true });
        const httpsAgent = new https.Agent({ keepAlive: true });
        
        // Retry with explicit HTTP agent configuration
        await axios.put(
          `${BUNNY_STORAGE_URL}${remoteFilePath}`, 
          createReadStream(localFilePath), 
          {
            headers: {
              'AccessKey': BUNNY_API_KEY,
              'Content-Type': 'application/octet-stream',
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            proxy: false,
            httpAgent, // Use explicit HTTP agent
            httpsAgent // Use explicit HTTPS agent
          }
        );
        
        // If successful, return the URL
        return {
          success: true,
          url: `https://${BUNNY_STORAGE_ZONE}.b-cdn.net/${remoteFilePath}`
        };
      } catch (retryError) {
        console.error('Retry with explicit agent also failed:', retryError);
        return {
          success: false,
          url: '',
          error: retryError instanceof Error ? 
            `Protocol error retry failed: ${retryError.message}` : 
            'Unknown error during retry'
        };
      }
    }
    
    return {
      success: false,
      url: '',
      error: error instanceof Error ? error.message : 'Unknown error during upload'
    };
  }
}

const execAsync = promisify(exec);

const app = express();

// Enable CORS for all origins
app.use(cors({
  origin: true, // Allow all origins in development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Increase JSON payload limit to accommodate base64 encoded files
app.use(express.json({ limit: '50mb' }));

// Global Stagehand instance for singleton browser management
let stagehand: Stagehand | null = null;
let currentConfig: any = null;
let isInitializingBrowser = false; // Lock to prevent concurrent browser initialization
let browserInitPromise: Promise<void> | null = null; // Promise to await if initialization is in progress

// Initialize process manager for command execution
const processManager = ProcessManager.getInstance();

// Store recording events globally
let recordingEvents: any[] = [];
let isRecording = false;

// ---- Error Handling Middleware ----
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("Error:", err);
  res.status(500).json({
    success: false,
    error: err.message,
    details: err.stack,
  });
});

// ---- Reusable Browser Initialization Function ----
async function ensureBrowserIsRunning(viewportSize: { width: number; height: number }, enableRemoteAccess: boolean = false): Promise<void> {
  // If browser initialization is already in progress, wait for it to complete
  if (isInitializingBrowser && browserInitPromise) {
    console.log("Browser initialization already in progress, waiting for completion...");
    await browserInitPromise;
    return;
  }

  // If browser is already running and responsive, do nothing
  if (stagehand && !isInitializingBrowser) {
    try {
      // Check if stagehand is initialized by trying to access the page
      if (stagehand.page) {
        await stagehand.page.evaluate(() => true);
        console.log("Using existing browser session.");
        return; // Browser is fine
      }
    } catch (error) {
      console.log("Existing browser session is no longer responsive, starting a new one");
      // Clean up the stale reference
      await stagehand?.close().catch((err: Error) => console.error("Error closing stale stagehand:", err));
      stagehand = null;
      currentConfig = null;
    }
  }

  // Set lock to prevent concurrent initialization
  isInitializingBrowser = true;
  
  // Create a promise for the initialization process
  browserInitPromise = (async () => {
    try {
      await initializeBrowser(viewportSize, enableRemoteAccess);
    } finally {
      // Always release the lock when done
      isInitializingBrowser = false;
      browserInitPromise = null;
    }
  })();

  await browserInitPromise;
}

async function initializeBrowser(viewportSize: { width: number; height: number }, enableRemoteAccess: boolean): Promise<void> {
  // Build LLM config based on environment variables
  let llmConfig;
  if (process.env.ANTHROPIC_API_KEY) {
    llmConfig = {
      provider: "anthropic",
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      modelName: "claude-3-5-sonnet-20241022",
      temperature: 0.7,
      maxTokens: 4096,
    };
  } else if (process.env.OPENAI_API_KEY) {
    llmConfig = {
      provider: "openai",
      openaiApiKey: process.env.OPENAI_API_KEY,
      modelName: "gpt-4o",
      temperature: 0.7,
      maxTokens: 4096,
    };
  } else {
    throw new Error(
      "Either ANTHROPIC_API_KEY or OPENAI_API_KEY must be set in environment variables"
    );
  }

  // Build launch arguments for the browser
  let browserArgs = ["--start-maximized"];
  
  // Always enable remote debugging on port 9222 for Playwright connectivity
  const debugPort = 9222;
  browserArgs.push(
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=0.0.0.0"
  );
  
  // Add additional remote debugging arguments if enableRemoteAccess is true
  if (enableRemoteAccess) {
    browserArgs.push(
      "--disable-web-security",
      "--disable-features=VizDisplayCompositor"
    );
    console.log(`Remote debugging enabled on port ${debugPort} with additional access options`);
  } else {
    console.log(`Remote debugging enabled on port ${debugPort}`);
  }

  // Build the complete config with updated browser settings - simplified to avoid proxy errors
  let baseConfig = {
    env: "LOCAL" as const,
    headless: false,
    debugDom: false,
    domSettleTimeoutMs: 300_000,
    llm: llmConfig,
    // Local browser launch options with remote debugging port
    localBrowserLaunchOptions: {
      args: browserArgs,
      headless: false,
      devtools: false, // Don't auto-open devtools panel
      env: process.env // Pass environment variables
    }
  };

  // Use the base config directly to avoid issues with helper functions
  currentConfig = baseConfig;

  // Simple browser configuration logging
  console.log('Browser configuration:');
  console.log('- Running under PM2:', process.env.PM2_HOME !== undefined);
  console.log('- Headless mode:', currentConfig.headless);
  console.log('- Args includes headless=new:', currentConfig.browser?.args?.includes('--headless=new'));
  console.log('- Args includes remote-debugging-port:', currentConfig.browser?.args?.some((arg: string) => arg.includes('remote-debugging-port')));
  console.log('- Browser args:', currentConfig.browser?.args);
  console.log('- Launch options args:', currentConfig.launchOptions?.args);
  console.log('- PUPPETEER_HEADLESS:', process.env.PUPPETEER_HEADLESS);

  // Validate config before using it
  if (!currentConfig || typeof currentConfig !== 'object') {
    console.error("Invalid config object, creating minimal fallback");
    currentConfig = {
      env: "LOCAL" as const,
      headless: false,
      llm: llmConfig
    };
  }

  // Ensure required fields exist
  if (!currentConfig.env) currentConfig.env = "LOCAL" as const;
  if (!currentConfig.llm) currentConfig.llm = llmConfig;
  if (currentConfig.headless === undefined) currentConfig.headless = false;

  console.log("Creating Stagehand with config:", {
    ...currentConfig,
    modelClientOptions: {
      apiKey: "***", // Hide the API key
    },
  });

  // Create a fresh Stagehand instance with the new config
  console.log("Creating new Stagehand instance...");

  // Try multiple times to initialize the browser, with a delay between attempts
  const maxRetries = 2; // Reduced retries to speed up
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`Browser launch attempt ${attempt + 1}/${maxRetries}`);
      stagehand = new Stagehand(currentConfig);

      // Initialize with timeout (launch browser, etc.)
      const initPromise = stagehand.init();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Browser initialization timeout after 30 seconds')), 30000);
      });
      
      await Promise.race([initPromise, timeoutPromise]);
      console.log("Stagehand initialized successfully");

      // Wait a moment for the browser to be fully ready
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify page is available before proceeding
      if (!stagehand?.page) {
        throw new Error("Stagehand page not available after initialization");
      }

      // Add initialization script to maintain zoom level and modify placeholders
      try {
        await stagehand.page.addInitScript(() => {
          const setupPage = () => {
          // Function to update placeholders
          const updatePlaceholders = () => {
            const inputs = document.querySelectorAll('input, textarea');
            inputs.forEach(element => {
              if (element instanceof HTMLElement) {
                const placeholder = element.getAttribute('placeholder');
                if (placeholder && !placeholder.endsWith(' (PLACEHOLDER)')) {
                  element.setAttribute('placeholder', `${placeholder} (PLACEHOLDER)`);
                }
              }
            });
          };

          updatePlaceholders();

          // Set up observer for dynamic content
          const observer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
              if (mutation.addedNodes.length > 0) {
                updatePlaceholders();
              }
            });
          });

          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['placeholder']
          });
        };

        setupPage();
      });
      } catch (initScriptError) {
        console.log("Error adding init script (non-fatal):", initScriptError);
      }

      // Function to apply our modifications after navigation
      const applyModifications = async () => {
        try {
          // Check if page is valid before proceeding
          if (!stagehand?.page) {
            console.log("Page not available, skipping modifications");
            return;
          }
          
          // Wait for page to be ready and stable
          await stagehand.page.waitForLoadState('domcontentloaded').catch((e: Error) => console.log("Wait for load state error:", e));
          
          // Verify page is still available after waiting
          if (!stagehand?.page) return;
          
          await stagehand.page.evaluate(() => {
            // Update placeholders
            const inputs = document.querySelectorAll('input, textarea');
            inputs.forEach(element => {
              if (element instanceof HTMLElement) {
                const placeholder = element.getAttribute('placeholder');
                if (placeholder && !placeholder.endsWith(' (PLACEHOLDER)')) {
                  element.setAttribute('placeholder', `${placeholder} (PLACEHOLDER)`);
                }
              }
            });
          }).catch((err: Error) => {
            // Silently catch errors during page modification
            console.log("Page modification error (non-fatal):", err.message);
          });
        } catch (error) {
          // Don't let applyModifications errors crash the app
          console.log("Error in applyModifications (continuing):", error);
        }
      };

      // Set up navigation handling for various events
      if (stagehand?.page) {
        // Handle initial page load with more robust error handling
        stagehand.page.on('load', () => {
          setTimeout(applyModifications, 500); // Slight delay to ensure page is stable
        });
        
        // Handle navigation events with more robust error handling
        stagehand.page.on('framenavigated', () => {
          setTimeout(applyModifications, 500); // Slight delay to ensure page is stable
        });
        
        // Handle after navigation is complete with more robust error handling  
        stagehand.page.on('domcontentloaded', () => {
          setTimeout(applyModifications, 500); // Slight delay to ensure page is stable
        });
      }

      // Navigate to Google initially, but don't fail if navigation issues occur
      console.log("Navigating to Google...");
      try {
        await stagehand.page.goto("https://www.google.com", { 
          waitUntil: 'networkidle',
          timeout: 15000 
        });
        console.log("Initial navigation to Google complete");
      } catch (navError) {
        console.log("Navigation to Google failed, trying with basic page:", navError);
        try {
          await stagehand.page.goto("about:blank", { timeout: 5000 });
          console.log("Navigation to blank page successful");
        } catch (blankError) {
          console.log("Navigation to blank page also failed, but continuing with current page");
          // Don't throw error, continue with whatever page we have
        }
      }

      // Get screen dimensions and set viewport to maximize window
      try {
        const screen = await stagehand.page.evaluate(() => {
          return { width: window.screen.width, height: window.screen.height };
        });
        console.log(`Screen dimensions: ${screen.width}x${screen.height}`);
        await stagehand.page.setViewportSize(viewportSize);
        console.log("Browser window viewport set.");
      } catch (vpError) {
        console.warn("Could not set browser window viewport:", vpError);
        // Continue even if setting viewport fails
      }

      // Successfully initialized
      return;
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt + 1} failed:`, error);
      
      // If browser was initialized successfully but navigation failed, 
      // and WebRTC is active, don't treat this as a complete failure
      if (stagehand && stagehand.page && Object.keys(webrtcClients).length > 0) {
        console.log('Browser initialized but navigation failed - continuing with WebRTC');
        return;
      }

      // Handle specific proxy error gracefully
      if (
        error instanceof Error &&
        error.message &&
        error.message.includes("Cannot create proxy with a non-object as target or handler")
      ) {
        console.error(
          "Stagehand proxy configuration error detected. Trying with minimal config..."
        );
        
        // Try with absolutely minimal config
        const minimalConfig = {
          env: "LOCAL" as const,
          headless: false,
          llm: llmConfig
        };
        
        try {
          console.log("Attempting minimal Stagehand configuration...");
          stagehand = new Stagehand(minimalConfig);
          await Promise.race([
            stagehand.init(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000))
          ]);
          console.log("Minimal Stagehand config succeeded");
          break; // Success, exit retry loop
        } catch (minimalError) {
          console.error("Minimal config also failed:", minimalError instanceof Error ? minimalError.message : minimalError);
          // Clean up and continue with next attempt
          if (stagehand) {
            try {
              await stagehand.close();
            } catch (closeError) {
              console.error("Error closing stagehand:", closeError instanceof Error ? closeError.message : closeError);
            }
            stagehand = null;
          }
        }
      }

      // For WebRTC scenarios, we need to be more aggressive about recovery
      const isWebRTCActive = Object.keys(webrtcClients).length > 0;
      const isBrowserReallyDead = (error as Error).message && (
        (error as Error).message.includes('Target page, context or browser has been closed') ||
        (error as Error).message.includes('browser has been closed') ||
        (error as Error).message.includes('Execution context was destroyed')
      );

      // Clean up failed instance - even if WebRTC is active, if browser is dead we need to restart
      if (stagehand && (Object.keys(webrtcClients).length === 0 || isBrowserReallyDead)) {
        try {
          await stagehand.close();
        } catch (closeError) {
          console.error("Error closing stagehand:", closeError);
        }
        // Always set to null if browser is dead
        if (attempt >= maxRetries - 1 || isBrowserReallyDead) {
          stagehand = null;
        }
      } else if (stagehand && isWebRTCActive && !isBrowserReallyDead) {
        console.log('Skipping browser close - WebRTC clients are active and browser seems responsive');
      }

      // Wait before retrying (reduced wait time)
      if (attempt < maxRetries - 1) {
        // If WebRTC clients are connected but browser is dead, continue retrying
        if (isWebRTCActive && !isBrowserReallyDead) {
          console.log('WebRTC clients are active and browser seems responsive, stopping retries');
          return;
        }
        console.log(`Waiting 1 second before retry ${attempt + 2}...`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // If we get here, all attempts failed
  console.error("Failed to initialize browser after multiple attempts:", lastError);
  stagehand = null; // Ensure stagehand is null on failure
  currentConfig = null;
  throw (
    lastError ||
    new Error("Failed to initialize browser after multiple attempts")
  );
}

// ---- 1. Start Browser Endpoint ----
app.post("/start_browser", async (req: Request, res: Response) => {
  try {
    const { isLarge = false, width, height, enableRemoteAccess = false } = req.body || {};
    
    // Set viewport size based on provided dimensions or isLarge parameter
    let viewportSize;
    
    if (width && height) {
      // Use explicit dimensions if provided
      viewportSize = { 
        width: Number(width), 
        height: Number(height) 
      };
    } else {
      // Fall back to isLarge parameter
      viewportSize = isLarge 
        ? LARGE_VIEWPORT_SIZE  // Larger viewport for isLarge=true
        : DEFAULT_VIEWPORT_SIZE;  // Default viewport size
    }
    
    // Ensure the browser is running using the reusable function
    await ensureBrowserIsRunning(viewportSize, enableRemoteAccess);

    // Get remote access information if enabled
    let remoteAccessInfo = null;
    if (enableRemoteAccess && stagehand) {
      try {
        // Get the browser and page information
        const browser = stagehand.page.context().browser();
        const pageUrl = stagehand.page.url();
        
        // For Playwright, we need to get the CDP endpoint differently
        let cdpUrl = null;
        let debugPort = 9222; // Default CDP port
        
        if (browser) {
          // Try to get the CDP endpoint - this varies by browser implementation
          try {
            // Access the internal CDP session if available
            const browserType = (browser as any)._connection?._url;
            if (browserType) {
              cdpUrl = browserType;
              const cdpUrlMatch = browserType.match(/:(\d+)/);
              if (cdpUrlMatch) {
                debugPort = parseInt(cdpUrlMatch[1]);
              }
            }
          } catch (e) {
            console.log("Could not extract CDP URL from browser connection");
          }
        }
        
        // Get server host/port for constructing URLs
        const serverHost = req.get('host')?.split(':')[0] || 'localhost';
        const serverPort = process.env.PORT || 5553;
        
        remoteAccessInfo = {
          cdp: {
            websocket_url: cdpUrl,
            http_endpoint: `https://${serverHost}:${debugPort}`,
            debug_port: debugPort
          },
          browser: {
            current_url: pageUrl,
            viewport: viewportSize
          },
          connection: {
            proxy_url: `http://${serverHost}`,
                      streaming_endpoints: {
            screenshot: `httpss://${serverHost}/screenshot`,
            vnc_proxy: `wss://${serverHost}/vnc-proxy`,
            webrtc_signaling: `wss://${serverHost}/webrtc-signal`,
            cdp_streaming: `wss://${serverHost}/cdp-stream`
          }
          },
          usage_examples: {
            screenshot_polling: {
              url: `https://${serverHost}/screenshot`,
              method: "GET",
              interval_ms: 1000
            },
            cdp_websocket: {
              url: cdpUrl,
              example_command: {
                id: 1,
                method: "Page.captureScreenshot",
                params: { format: "png", quality: 80 }
              }
            },
            react_component_url: `https://${serverHost}/chrome-streamer-component`
          }
        };
      } catch (accessError) {
        console.warn("Failed to get remote access info:", accessError);
        remoteAccessInfo = { error: "Failed to retrieve remote access information" };
      }
    }

    // If we got here, the browser is running (either new or existing)
    return res.json({
      success: true,
      message: "Browser session is active",
      viewport: viewportSize,
      remote_access: remoteAccessInfo
    });
  } catch (error: unknown) {
    console.error("Error in start_browser endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to start browser",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 1.5. Stop Browser Endpoint ----
app.post("/stop_browser", async (req: Request, res: Response) => {
  try {
    if (stagehand) {
      console.log("Closing browser session...");
      
      // Stop CDP screencast if active
      await stopCDPScreencast();
      
      try {
        // Only try to close if stagehand is properly initialized
        if (stagehand.page) {
          await stagehand.close();
        }
      } catch (closeError) {
        console.log("Error during stagehand close, but continuing with cleanup:", closeError);
      }
      stagehand = null;
      currentConfig = null;
      console.log("Browser session cleaned up successfully");
    }

    return res.json({
      success: true,
      message: "Browser session stopped"
    });
  } catch (error: unknown) {
    console.error("Error stopping browser:", error);
    // Always return success for stop operations to prevent infinite loops
    return res.json({
      success: true,
      message: "Browser session cleanup attempted",
      warning: error instanceof Error ? error.message : "Unknown error during cleanup"
    });
  }
});

// ---- 2. "Goto" Endpoint ----
app.post("/goto", async (req: Request, res: Response) => {
  try {
    // Ensure the browser is running using the reusable function
    await ensureBrowserIsRunning(DEFAULT_VIEWPORT_SIZE);

    // Now we know stagehand and stagehand.page are available
    const { url } = req.body;
    if (!url) {
      throw new Error("URL is required");
    }

    console.log("Navigating to:", url);
    
    // Use multiple waitUntil conditions and a longer timeout
    try {
      // Use non-null assertion as ensureBrowserIsRunning guarantees it
      await stagehand!.page.goto(url, { 
        waitUntil: 'networkidle',
        timeout: 60000 // 60 second timeout
      });
      console.log("Navigation complete");
    } catch (navError) {
      console.warn(`Navigation warning (continuing): ${navError instanceof Error ? navError.message : 'Unknown error'}`);
      
      // Even if there was an error, we'll continue but wait a moment for any partial load
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Add a short delay to ensure page is stable
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
      // Ensure zoom level and placeholders are maintained after navigation
      // Use non-null assertion here as well
      await stagehand!.page.evaluate(() => {
        try {
          // Update placeholders
          const inputs = document.querySelectorAll('input, textarea');
          inputs.forEach(element => {
            if (element instanceof HTMLElement) {
              const placeholder = element.getAttribute('placeholder');
              if (placeholder && !placeholder.endsWith(' (PLACEHOLDER)')) {
                element.setAttribute('placeholder', `${placeholder} (PLACEHOLDER)`);
              }
            }
          });
        } catch (innerError) {
          console.log("Error in page evaluation (handled internally)");
        }
      }).catch((err: Error) => {
        console.warn("Page evaluate error (continuing):", err.message);
      });
    } catch (evalError) {
      console.warn("Outer evaluation error (continuing):", evalError);
    }

    // Try to wait for network idle state, but don't fail if it times out
    try {
      await stagehand!.page.waitForLoadState('networkidle', { timeout: 5000 })
        .catch((e: Error) => console.log("Wait for network idle timeout (continuing):", e.message));
    } catch (loadError) {
      console.log("Error waiting for page load (continuing):", loadError);
    }

    return res.json({
      success: true,
      message: `Successfully navigated to ${url}`,
    });
  } catch (error: unknown) {
    console.error("Error in goto endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error during navigation",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 2.5. "Go Back" Endpoint ----
app.post("/go_back", async (req: Request, res: Response) => {
  try {
    // Ensure the browser is running using the reusable function
    await ensureBrowserIsRunning(DEFAULT_VIEWPORT_SIZE);

    console.log("Navigating back...");
    // Use non-null assertion
    await stagehand!.page.goBack();
    console.log("Navigation back complete");

    return res.json({
      success: true,
      message: `Successfully navigated back`,
    });
  } catch (error: unknown) {
    console.error("Error in go_back endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error during go back",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 2.6. "Refresh" Endpoint ----
app.post("/refresh", async (req: Request, res: Response) => {
  try {
    // Ensure the browser is running using the reusable function
    await ensureBrowserIsRunning(DEFAULT_VIEWPORT_SIZE);

    console.log("Refreshing current page...");
    // Use non-null assertion
    await stagehand!.page.reload({ waitUntil: 'networkidle', timeout: 60000 });
    console.log("Page refresh complete");

    return res.json({
      success: true,
      message: "Page refreshed",
    });
  } catch (error: unknown) {
    console.error("Error in refresh endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error during refresh",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 2.7. "Inject Cookie" Endpoint ----
app.post("/inject-cookie", async (req: Request, res: Response) => {
  try {
    // Ensure the browser is running using the reusable function
    await ensureBrowserIsRunning(DEFAULT_VIEWPORT_SIZE);

    const { name, value, domain, path, expires, httpOnly, secure, sameSite } = req.body;

    // Validate required parameters
    if (!name || !value) {
      return res.status(400).json({
        success: false,
        error: "Cookie name and value are required",
      });
    }

    console.log(`Injecting cookie: ${name}=${value} for domain: ${domain || 'current domain'}`);

    // Get the current page URL
    let currentPageUrl: string | undefined;
    try {
      currentPageUrl = stagehand!.page.url();
      console.log("Current page URL:", currentPageUrl);
    } catch (urlErr) {
      console.warn("Could not read current page url while injecting cookie:", urlErr);
    }

    // Prepare cookie object with simplified logic
    const cookie: any = {
      name,
      value,
      path: path || "/"
    };

    // Only set optional properties if explicitly provided
    if (httpOnly !== undefined) {
      cookie.httpOnly = httpOnly;
    }
    if (secure !== undefined) {
      cookie.secure = secure;
    }
    if (sameSite !== undefined) {
      cookie.sameSite = sameSite;
    }

    // Note: We intentionally ignore the expires parameter as it causes cookie injection issues
    // All cookies will be session cookies (expires when browser closes)
    if (expires) {
      console.log("Expires parameter provided but ignored for compatibility:", expires);
    }

    // Handle domain - use a simpler approach
    if (domain) {
      cookie.domain = domain;
    } else if (currentPageUrl) {
      try {
        const parsed = new URL(currentPageUrl);
        cookie.domain = parsed.hostname;
      } catch (parseErr) {
        console.warn("Could not parse current URL for domain:", parseErr);
      }
    }

    // Remove undefined properties to avoid issues
    Object.keys(cookie).forEach(key => {
      if (cookie[key] === undefined) {
        delete cookie[key];
      }
    });

    console.log("Attempting to inject cookie object:", cookie);

    // Inject the cookie using the browser context
    try {
      console.log("About to inject cookie:", JSON.stringify(cookie, null, 2));
      await stagehand!.page.context().addCookies([cookie]);
      console.log("Cookie injection API call completed successfully");
    } catch (cookieError) {
      console.error("Cookie injection failed:", cookieError);
      console.error("Failed cookie object was:", JSON.stringify(cookie, null, 2));
      // Continue with the response to see the current state
    }

    // Wait a moment for the cookie to be set
    await new Promise(resolve => setTimeout(resolve, 100));

    // Fetch cookies currently in the context for debugging
    let allCookies: any[] = [];
    try {
      allCookies = await stagehand!.page.context().cookies();
      console.log("All cookies in context after injection:", allCookies.length);
    } catch (listErr) {
      console.warn("Could not list cookies after injection:", listErr);
    }

    // Filter cookies for the specific domain
    const targetDomain = domain || (currentPageUrl ? new URL(currentPageUrl).hostname : '');
    const domainCookies = allCookies.filter(c => 
      c.domain === targetDomain || 
      c.domain === '.' + targetDomain ||
      (targetDomain && c.domain.endsWith(targetDomain))
    );

    console.log(`Found ${domainCookies.length} cookies for domain "${targetDomain}"`);
    console.log("Domain cookies:", domainCookies.map(c => `${c.name}=${c.value}`));

    // Check if our cookie was actually set
    const injectedCookie = allCookies.find(c => c.name === name);
    if (injectedCookie) {
      console.log("✓ Cookie injection successful - cookie found in context");
    } else {
      console.log("✗ Cookie injection may have failed - cookie not found in context");
    }

    return res.json({
      success: true,
      message: `Cookie '${name}' injected successfully`,
      current_url_in_browser: currentPageUrl || "",
      all_cookies_in_context: allCookies,
      cookies_for_domain: domainCookies
    });
  } catch (error: unknown) {
    console.error("Error in inject-cookie endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error during cookie injection",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 3. Screenshot Endpoint ----
app.get("/screenshot", async (req: Request, res: Response) => {
  try {
    // Check if another screenshot is in progress
    if (isScreenshotInProgress) {
      return res.status(429).json({
        success: false,
        error: "Screenshot in progress, please try again"
      });
    }
    
    isScreenshotInProgress = true;
    
    // Ensure the browser is running using the reusable function
    await ensureBrowserIsRunning(DEFAULT_VIEWPORT_SIZE);

    // Make sure page is ready
    try {
      // Wait for page to be stable
      await stagehand!.page.waitForLoadState('networkidle', { timeout: 5000 }).catch((err: Error) => {
        console.warn("Screenshot waitForLoadState warning (continuing):", err.message);
      });
    } catch (loadError) {
      console.warn("Error waiting for page load before screenshot (continuing):", loadError);
    }

    // Get current URL and title (use non-null assertion)
    let currentUrl = "";
    let currentTitle = "";
    
    try {
      currentUrl = stagehand!.page.url();
      currentTitle = await stagehand!.page.title();
    } catch (infoError) {
      console.warn("Error getting page info for screenshot (continuing):", infoError);
    }

    // Capture only the current viewport
    let screenshotBuffer;
    try {
      screenshotBuffer = await stagehand!.page.screenshot({
        fullPage: false,
        scale: "css",
        animations: "disabled",
        caret: "hide",
        timeout: 30000,
      });
    } catch (screenshotError) {
      console.error("Error taking screenshot:", screenshotError);
      return res.status(500).json({
        success: false,
        error: screenshotError instanceof Error ? screenshotError.message : "Unknown screenshot error",
      });
    }

    // Convert buffer to base64 string
    const base64Image = screenshotBuffer.toString("base64");
    
    // Save screenshot to file in screenshots/ directory
    try {
      // Create screenshots directory if it doesn't exist
      if (!fs.existsSync('screenshots')) {
        fs.mkdirSync('screenshots', { recursive: true });
      }
      
      // Create a timestamp and sanitized filename
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const sanitizedTitle = (currentTitle || 'screenshot')
        .replace(/[^a-z0-9]/gi, '_')
        .substring(0, 50); // Limit length
      
      const filename = `screenshots/${Math.random().toString(36).substring(2, 15)}.png`;
      
      // Write the file asynchronously
      fs.promises.writeFile(filename, screenshotBuffer)
        .then(() => console.log(`Screenshot saved to ${filename}`))
        .catch((saveError) => console.warn(`Error saving screenshot to file (non-fatal): ${saveError.message}`));
    } catch (fileError) {
      // Log error but continue - this should not affect the API response
      console.warn(`Error preparing to save screenshot (non-fatal): ${fileError instanceof Error ? fileError.message : 'Unknown error'}`);
    }

    res.json({
      success: true,
      data: base64Image,
      encoding: "base64",
      mimeType: "image/png",
      current_url: currentUrl,
      current_title: currentTitle,
    });
  } catch (error: unknown) {
    console.error("Error taking screenshot:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error during screenshot",
      details: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    isScreenshotInProgress = false;
  }
});

// ---- 4. "Act" Endpoint ----
app.post("/act", async (req: Request, res: Response) => {
  try {
    // Ensure the browser is running using the reusable function
    await ensureBrowserIsRunning(DEFAULT_VIEWPORT_SIZE);

    // Must have a valid API key (check remains)
    if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "Either ANTHROPIC_API_KEY or OPENAI_API_KEY must be set in environment variables for agent functionality"
      );
    }

    const { action, url, selector, action_type } = req.body;
    if (!action) {
      throw new Error("Action description is required");
    }

    // If a URL is provided, navigate first (use non-null assertion)
    if (url) {
      console.log("Navigating to:", url);
      await stagehand!.page.goto(url, { waitUntil: 'networkidle' }).catch((err: Error) => {
        console.warn(`Navigation warning (continuing): ${err.message}`);
      });
      console.log("Navigation complete");
      
      // Add a short delay to ensure the page is stable
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Ensure the page is stable before proceeding
    try {
      await stagehand!.page.waitForLoadState('networkidle', { timeout: 10000 })
        .catch((e: Error) => console.log("Wait for network idle timeout (continuing):", e.message));
    } catch (loadError) {
      console.log("Error waiting for page load (continuing):", loadError);
    }

    // Check if we can use deterministic action execution
    let usedDeterministicAction = false;
    let deterministicResult = null;
    let deterministicError = null;

    if (selector && action_type) {
      try {
        console.log(`Attempting deterministic action: ${action_type} on selector "${selector}"`);
        
        // Perform the action based on action_type
        switch (action_type.toLowerCase()) {
          case 'click':
            // Wait for the selector to be available (with timeout)
            await stagehand!.page.waitForSelector(selector, { timeout: 5000 });
            // Click the element
            await stagehand!.page.click(selector);
            console.log(`Successfully clicked on selector: ${selector}`);
            break;
            
          case 'type':
            // Wait for the selector to be available (with timeout)
            await stagehand!.page.waitForSelector(selector, { timeout: 5000 });
            // Clear existing content and type the new text
            await stagehand!.page.fill(selector, action);
            console.log(`Successfully typed "${action}" into selector: ${selector}`);
            break;
            
          default:
            // For unsupported action types, throw an error to fall back to AI
            throw new Error(`Unsupported action_type: ${action_type}`);
        }
        
        // Create a simplified result similar to the agent result
        deterministicResult = {
          completed: true,
          actions: [{
            type: action_type.toLowerCase(),
            element: selector,
            value: action_type.toLowerCase() === 'type' ? action : undefined,
            // No screenshots for deterministic execution
            screenshots: {}
          }],
          metadata: {
            deterministic: true,
            action_type: action_type.toLowerCase(),
            selector: selector
          }
        };
        
        usedDeterministicAction = true;
        console.log("Deterministic action executed successfully");
      } catch (detError) {
        // Log the error but fall back to AI agent
        deterministicError = detError;
        console.log(`Deterministic action failed: ${detError instanceof Error ? detError.message : 'Unknown error'}`);
        console.log("Falling back to AI agent execution...");
      }
    }
    
    // If deterministic action was successful, return the result
    if (usedDeterministicAction && deterministicResult) {
      return res.json({
        success: true,
        message: "Action executed successfully using deterministic method",
      });
    }

    // Fall back to AI agent if deterministic method was not used or failed
    console.log("Creating agent...");

    // Use non-null assertion for stagehand
    const agent = stagehand!.agent({
      provider: 'openai',
      model: 'computer-use-preview',
      instructions: `Instructions:
You are a persistent AI agent that operates a web browser to perform the tasks.
You **precisely** execute the task the user is asking for.
You are an expert on inferring user interfaces and making speculative decisions like inferring icons.
You are persistent and patient.
You dismiss any obstacles like modals, popups, or other distractions that cover your test area if needed.
When selecting options in a dropdown, you may click on the dropdown and NOT see the options appear. In that case, simply type the options you want to select and press RETURN. Trust that the option will be selected even if you could not see the options dropping down. You can confirm the right option is selected by looking at the text of the selected option after you press RETURN.
You first hover over the components you want to scroll in.
You are smart enough to hover over the navbars to expand them to see the option names when needed.

Here are some example pitfalls you might fall into and how to tackle them:
- Not seeing the element the user user wants you to interact with -> Try hovering over navbars to expand them to see the option names or play around the app to expand sections to find the element.
- Popups, modals, nav bars etc. blocking the important content on the page -> Dismiss the obstacle by clicking on an "X" or "Close" button. Or, if there is no button, click on the empty area outside of the obstacle.
- Scrolling **inside** a sub-component instead of the entire page -> First move the mouse to the center of the element you want to scroll in - hovering over it. Then, scroll how many pixels you need to scroll in the direction you want to scroll in.
- Not being able to find a component the task is referring to -> Scroll down the page to see if it's below the current view, or make speculative guess by looking at the icons and navigating around the app to find it.
- Not getting the intended result from an action -> Try again with a different approach. The wrong action may also uncover a new path to success. Be persistent and patient.
- Mistaking the placeholder in a text input for the actual text -> If you see a text input with a half transparent text inside and it has '(PLACEHOLDER)' in the end, it's most likely a placeholder. You can usually click on it to select it and then type your own text without needing to clear it first.
- Not being able to select an option in a dropdown -> Click on the dropdown, even if you don't see the options appear, type the option you want to select and press RETURN. Trust that the option will be selected even if you could not see the options dropping down. You can confirm the right option is selected by looking at the text of the selected option after you press RETURN.`
    });

    console.log("Executing action with AI agent:", action);
    const result = await agent.execute(action);
    
    // Map timestamped screenshot directories to actions
    const actionScreenshotMap: Record<string, {before: string, after: string}> = {};
    try {
      const screenshotsPath = 'screenshots';
      if (fs.existsSync(screenshotsPath)) {
        // List directories (timestamped per action)
        const dirs = fs.readdirSync(screenshotsPath)
          .filter(name => fs.statSync(path.join(screenshotsPath, name)).isDirectory())
          .sort();
        for (const dir of dirs) {
          const beforeLocal = path.join(screenshotsPath, dir, 'before.png');
          const afterLocal = path.join(screenshotsPath, dir, 'after.png');
          let beforeUrl = '';
          let afterUrl = '';
          try {
            if (fs.existsSync(beforeLocal)) {
              const res = await uploadToBunnyStorage(beforeLocal, `screenshots/${dir}/before.png`);
              beforeUrl = res.success ? res.url : '';
            }
          } catch (err) {
            console.warn(`Error uploading before screenshot for ${dir}:`, err);
          }
          try {
            if (fs.existsSync(afterLocal)) {
              const res = await uploadToBunnyStorage(afterLocal, `screenshots/${dir}/after.png`);
              afterUrl = res.success ? res.url : '';
            }
          } catch (err) {
            console.warn(`Error uploading after screenshot for ${dir}:`, err);
          }
          actionScreenshotMap[dir] = { before: beforeUrl, after: afterUrl };
        }
        // Clean up local screenshots folder
        try {
          fs.rmSync(screenshotsPath, { recursive: true, force: true });
          console.log("Screenshots directory removed");
        } catch (rmErr) {
          console.warn("Error removing screenshots directory:", rmErr);
        }
      }
    } catch (err) {
      console.error("Error handling action screenshots:", err);
    }

    // Attach screenshots to each action based on timestamp order
    const orderedDirs = Object.keys(actionScreenshotMap);
    result.actions.forEach((act, idx) => {
      const dir = orderedDirs[idx];
      if (dir) act.screenshots = actionScreenshotMap[dir];
    });

    // Check for repeatables folder and get latest JSON file
    let repeatables = null;
    try {
      if (fs.existsSync('repeatables')) {
        console.log("Checking repeatables directory for JSON files...");
        
        // Get all JSON files in the repeatables directory
        const jsonFiles = fs.readdirSync('repeatables')
          .filter(file => file.toLowerCase().endsWith('.json'))
          .map(file => ({
            name: file,
            path: path.join('repeatables', file),
            mtime: fs.statSync(path.join('repeatables', file)).mtime
          }))
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()); // Sort by modification time, newest first
        
        if (jsonFiles.length > 0) {
          // Get the latest JSON file
          const latestFile = jsonFiles[0];
          console.log(`Found latest JSON file: ${latestFile.name}`);
          
          // Read the file contents
          const fileContents = fs.readFileSync(latestFile.path, 'utf-8');
          try {
            // Parse the JSON
            repeatables = JSON.parse(fileContents);
            console.log("Successfully parsed JSON from repeatables file");
            
            // Delete the file after parsing
            fs.unlinkSync(latestFile.path);
            console.log(`Deleted the processed repeatables file: ${latestFile.name}`);
          } catch (parseError) {
            console.error("Error parsing JSON from repeatables file:", parseError);
            // Return the raw file contents if parsing fails
            repeatables = { raw: fileContents };
            
            // Delete the file even if parsing fails
            try {
              fs.unlinkSync(latestFile.path);
              console.log(`Deleted the unparsable repeatables file: ${latestFile.name}`);
            } catch (deleteError) {
              console.error("Error deleting unparsable repeatables file:", deleteError);
            }
          }
        } else {
          console.log("No JSON files found in repeatables directory");
        }
      } else {
        console.log("Repeatables directory does not exist");
      }
    } catch (repeatableError) {
      console.error("Error checking repeatables:", repeatableError);
      // Continue with the response even if repeatables handling fails
    }

    // Add metadata about fallback reason if deterministic was attempted
    if (selector && action_type && deterministicError) {
      if (!result.metadata) result.metadata = {};
      result.metadata.deterministic_fallback = true;
      result.metadata.deterministic_error = deterministicError instanceof Error 
        ? deterministicError.message 
        : 'Unknown error';
    }

    return res.json({ 
      success: true, 
      message: "Action executed successfully",
      completed: result.completed,
      actions: result.actions,
      metadata: result.metadata,
      repeatables: repeatables
    });
  } catch (error: unknown) {
    console.error("Error in act endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error during act",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 5. Folder Tree Endpoint ----
app.get("/folder-tree", async (req: Request, res: Response) => {
  try {
    // Match Python: no default value for folder_path
    const folderPath = req.query.folder_path as string;

    const documentsPath = path.join(os.homedir(), "Documents");

    // Verify Documents exists
    if (!fs.existsSync(documentsPath)) {
      return res.status(404).json({
        error: "Documents directory not found",
        path: documentsPath,
      });
    }

    // Use a platform-agnostic approach to list files with relative paths
    const getFilesRecursively = (
      dir: string,
      depth = 1,
      maxDepth = 3
    ): string => {
      if (depth > maxDepth) return "";

      let output = "";
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          // Get path relative to Documents directory
          const relativePath = "./" + path.relative(documentsPath, fullPath);
          // Skip the root directory (mindepth 1)
          if (depth >= 1) {
            output += relativePath + "\n";
          }

          if (entry.isDirectory()) {
            try {
              output += getFilesRecursively(fullPath, depth + 1, maxDepth);
            } catch (err) {
              // Skip directories we can't access
              console.log(`Skipping inaccessible directory: ${fullPath}`);
            }
          }
        }
      } catch (err) {
        console.error(`Error reading directory ${dir}:`, err);
      }

      return output;
    };

    try {
      const targetPath = path.join(documentsPath, folderPath || "");
      if (!fs.existsSync(targetPath)) {
        return res.status(404).json({
          message: "Folder not found",
          folder_path: folderPath,
        });
      }

      // Get output as a single string with paths separated by newlines
      const output = getFilesRecursively(targetPath, 1, 3);

      // Match Python find command behavior: always return an object with empty string for empty results
      return res.json({
        message: "Folder tree retrieved successfully",
        folder_path: folderPath,
        output: output || "", // Ensure we return empty string instead of undefined/null
      });
    } catch (error) {
      return res.status(500).json({
        message: "Error retrieving folder tree",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  } catch (error: unknown) {
    console.error("Error in folder-tree endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 6. Find Repo Endpoint ----
app.post("/find-repo", async (req: express.Request, res: express.Response) => {
  try {
    const { remote_url } = req.body;
    if (!remote_url) {
      return res.status(400).json({ error: "Remote URL not provided" });
    }

    const documentsPath = path.join(os.homedir(), "Documents");
    const maxDepth = 3;

    // 1) Helper: get immediate subdirs (non-hidden)
    const getSubdirs = async (dirPath: string): Promise<string[]> => {
      try {
        const entries = await fs.promises.readdir(dirPath, {
          withFileTypes: true,
        });
        return entries
          .filter(
            (entry: fs.Dirent) =>
              entry.isDirectory() && !entry.name.startsWith(".")
          )
          .map((entry: fs.Dirent) => path.join(dirPath, entry.name));
      } catch (error) {
        console.error(`Error reading directory ${dirPath}:`, error);
        return [];
      }
    };

    // 2) Helper: check if a given directory is the target repo
    const isTargetRepo = async (dirPath: string): Promise<boolean> => {
      const gitConfigPath = path.join(dirPath, ".git", "config");
      try {
        const configContent = await fs.promises.readFile(
          gitConfigPath,
          "utf-8"
        );
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
            depth,
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
      max_depth_reached: depth >= maxDepth,
    });
  } catch (error: unknown) {
    console.error("Error in find-repo endpoint:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 7. Create Seed Image Endpoint ----
app.post("/create-seed-image", async (req: Request, res: Response) => {
  try {
    console.log("Starting seed image creation process...");
    
    // Step 1: Remove any existing Docker image with the tag 'myhost'
    console.log("Removing existing Docker image if it exists...");
    try {
      const removeImageResult = await execAsync('cd /home/fume && docker rmi -f myhost');
      console.log("Docker image removal output:", removeImageResult.stdout || "No output");
      console.log("Docker image removal stderr:", removeImageResult.stderr || "No stderr");
    } catch (error) {
      // It's okay if this fails (e.g., if the image doesn't exist)
      console.log("No existing Docker image to remove or removal failed:", error);
    }
    
    // Step 2: Remove any existing tar archive to avoid duplicate path issues
    console.log("Removing existing tar archive if it exists...");
    try {
      const removeTarResult = await execAsync('cd /home/fume && rm -f root.tar');
      console.log("Tar removal output:", removeTarResult.stdout || "No output");
      console.log("Tar removal stderr:", removeTarResult.stderr || "No stderr");
    } catch (error) {
      console.log("Error removing existing tar archive:", error);
    }
    
    // Step 3: Create a fresh tar archive
    console.log("Creating fresh system tar archive...");
    const tarCommand = `cd /home/fume && sudo tar --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/tmp --exclude=/home/fume/FumeData --exclude=/home/fume/Documents --exclude=/home/fume/root.tar -cf /home/fume/root.tar /`;
    console.log("Executing tar command:", tarCommand);
    
    const tarResult = await execAsync(tarCommand);
    console.log("Tar archive created");
    console.log("Tar stdout:", tarResult.stdout || "No stdout");
    console.log("Tar stderr:", tarResult.stderr || "No stderr");
    
    // Step 4: Import the tar archive as a Docker image
    console.log("Importing tar archive as Docker image...");
    const importCommand = `cd /home/fume && cat root.tar | docker import --change "CMD [\"/sbin/init\"]" - myhost:latest`;
    console.log("Executing import command:", importCommand);

    const importResult = await execAsync(importCommand);
    console.log("Docker image created");
    console.log("Import stdout:", importResult.stdout || "No stdout");
    console.log("Import stderr:", importResult.stderr || "No stderr");

    // Remove the large tar file after import is complete
    try {
      await execAsync('cd /home/fume && rm -f root.tar');
      console.log("Removed tar file after successful import");
    } catch (rmError) {
      console.log("Note: Failed to remove tar file after import:", rmError);
    }

    return res.json({
      success: true,
      message: "Seed image created successfully",
      details: {
        tarOutput: {
          stdout: tarResult.stdout || "",
          stderr: tarResult.stderr || ""
        },
        importOutput: {
          stdout: importResult.stdout || "",
          stderr: importResult.stderr || ""
        }
      }
    });
  } catch (error: unknown) {
    console.error("Error creating seed image:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 8. Create Minion Endpoint ----
app.post("/create-minion", async (req: Request, res: Response) => {
  try {
    const { 
      id, 
      sshDomain, 
      apiDomain, 
      vncDomain,
      taskId,
      parentTaskId
    } = req.body;
    
    // Validate all required parameters
    if (!id) {
      return res.status(400).json({
        success: false,
        error: "ID parameter is required"
      });
    }
    
    if (!sshDomain || !apiDomain || !vncDomain) {
      return res.status(400).json({
        success: false,
        error: "All domain parameters (sshDomain, apiDomain, vncDomain) are required"
      });
    }
    
    if (!taskId) {
      return res.status(400).json({
        success: false,
        error: "taskId parameter is required"
      });
    }
    
    console.log(`Creating minion with ID: ${id}`);
    console.log(`Using domains: SSH=${sshDomain}, API=${apiDomain}, VNC=${vncDomain}`);
    console.log(`Task ID: ${taskId}, Parent Task ID: ${parentTaskId || 'None'}`);
    
    // Initialize Docker client
    const docker = new Docker();
    
    // Container name based on ID
    const containerName = `branch${id}`;
    
    // Configure labels for Traefik routing
    const labels = {
      "traefik.enable": "true",
      
      // SSH routing
      [`traefik.tcp.routers.ssh-router-${containerName}.rule`]: `HostSNI(\`${sshDomain}\`)`,
      [`traefik.tcp.routers.ssh-router-${containerName}.entryPoints`]: "ssh",
      [`traefik.tcp.routers.ssh-router-${containerName}.tls`]: "true",
      [`traefik.tcp.routers.ssh-router-${containerName}.tls.certresolver`]: "zerosslResolver",
      [`traefik.tcp.routers.ssh-router-${containerName}.service`]: `ssh-service-${containerName}`,
      [`traefik.tcp.services.ssh-service-${containerName}.loadbalancer.server.port`]: "22",
      
      // API routing
      [`traefik.http.routers.api-router-${containerName}.rule`]: `Host(\`${apiDomain}\`)`,
      [`traefik.http.routers.api-router-${containerName}.entryPoints`]: "websecure",
      [`traefik.http.routers.api-router-${containerName}.tls`]: "true",
      [`traefik.http.routers.api-router-${containerName}.tls.certresolver`]: "zerosslResolver",
      [`traefik.http.routers.api-router-${containerName}.service`]: `api-service-${containerName}`,
      [`traefik.http.services.api-service-${containerName}.loadbalancer.server.port`]: "5553",
      
      // VNC routing
      [`traefik.http.routers.vnc-router-${containerName}.rule`]: `Host(\`${vncDomain}\`)`,
      [`traefik.http.routers.vnc-router-${containerName}.entryPoints`]: "websecure",
      [`traefik.http.routers.vnc-router-${containerName}.tls`]: "true",
      [`traefik.http.routers.vnc-router-${containerName}.tls.certresolver`]: "zerosslResolver",
      [`traefik.http.routers.vnc-router-${containerName}.service`]: `vnc-service-${containerName}`,
      [`traefik.http.services.vnc-service-${containerName}.loadbalancer.server.port`]: "6080"
    };
    
    // Determine source directory for btrfs snapshot based on parentTaskId
    const targetDir = `/home/fume/FumeData/${taskId}`;
    const sourceDir = parentTaskId 
      ? `/home/fume/FumeData/${parentTaskId}`
      : '/home/fume/Documents';
    
    // Variable to store snapshot status
    let snapshotStatus = "completed";
    
    // Execute btrfs subvolume snapshot for fast copying
    console.log(`Creating btrfs snapshot from ${sourceDir} to ${targetDir}...`);
    try {
      // Use btrfs subvolume snapshot command
      await execAsync(`sudo btrfs subvolume snapshot ${sourceDir} ${targetDir}`);
      console.log('Btrfs snapshot created successfully');
    } catch (snapshotError: unknown) {
      console.warn('Snapshot creation encountered errors but will continue:', (snapshotError as Error).message);
      snapshotStatus = "completed with errors";
      
      // Fall back to rsync if btrfs snapshot fails
      try {
        console.log('Falling back to rsync...');
        // First create the target directory and set permissions
        await execAsync(`sudo mkdir -p ${targetDir}`);
        await execAsync(`sudo chown -R fume:fume ${targetDir}`);
        
        // Use rsync as fallback
        await execAsync(
          `rsync -a --quiet ${sourceDir}/ ${targetDir}/`, 
          { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
        );
        console.log('Rsync fallback completed successfully');
      } catch (rsyncError: unknown) {
        console.warn('Rsync fallback also failed:', (rsyncError as Error).message);
        snapshotStatus = "failed";
        // Continue with container creation even if copying failed
      }
    }
    
    // Create container with the specified configuration
    const container = await docker.createContainer({
      name: containerName,
      Image: 'myhost:latest',
      Labels: labels,
      HostConfig: {
        NetworkMode: 'seed-net',
        Binds: [
          `${targetDir}:/home/fume/Documents:rw`,
          // Mount cgroup filesystem for systemd
          "/sys/fs/cgroup:/sys/fs/cgroup:ro"
        ],
        Privileged: true, // Required for systemd to work properly
        SecurityOpt: ["seccomp=unconfined"] // May be needed for some systemd operations
      }
    });
    
    // Start the container
    await container.start();
    console.log(`Minion container ${containerName} started successfully`);
    
    // Execute commands to ensure services are running
    console.log(`Starting services in container ${containerName}...`);
    try {
      // Start SSH service
      const sshExec = await container.exec({
        Cmd: ['/bin/bash', '-c', 'sudo systemctl start ssh'],
        AttachStdout: true,
        AttachStderr: true
      });
      await sshExec.start({});
      
      // Ensure /tmp has correct permissions
      const tmpExec = await container.exec({
        Cmd: ['/bin/bash', '-c', 'sudo mkdir -p /tmp && sudo chmod 1777 /tmp'],
        AttachStdout: true,
        AttachStderr: true
      });
      await tmpExec.start({});
      
      console.log(`Services started successfully in container ${containerName}`);
    } catch (serviceError: unknown) {
      console.warn(`Warning: Error starting services in container: ${(serviceError as Error).message}`);
      // Continue even if service startup has issues
    }
    
    console.log(`Minion container ${containerName} created and configured successfully`);
    
    return res.json({
      success: true,
      message: `Minion container created successfully`,
      container: {
        id: container.id,
        name: containerName,
        endpoints: {
          ssh: `ssh://${sshDomain}`,
          api: `https://${apiDomain}`,
          vnc: `https://${vncDomain}`
        },
        taskId,
        parentTaskId: parentTaskId || null,
        snapshot_output: snapshotStatus
      }
    });
  } catch (error: unknown) {
    console.error("Error creating minion container:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 9. Delete Minion Endpoint ----
app.post("/delete-minion", async (req: Request, res: Response) => {
  try {
    const { 
      id,
      taskId,
      removeData = false // Optional parameter to remove the data directory
    } = req.body;
    
    // Validate required parameters
    if (!id) {
      return res.status(400).json({
        success: false,
        error: "ID parameter is required"
      });
    }
    
    console.log(`Deleting minion with ID: ${id}`);
    
    // Initialize Docker client
    const docker = new Docker();
    
    // Container name based on ID
    const containerName = `branch${id}`;
    
    try {
      // Get container reference
      const container = docker.getContainer(containerName);
      
      // Check if container exists by getting its info
      await container.inspect();
      
      // Stop the container if it's running
      console.log(`Stopping container ${containerName}...`);
      await container.stop().catch(err => {
        // Ignore error if container is already stopped
        console.log(`Container ${containerName} may already be stopped:`, err.message);
      });
      
      // Remove the container
      console.log(`Removing container ${containerName}...`);
      await container.remove();
      
      console.log(`Container ${containerName} removed successfully`);
      
      // Optionally remove the data directory
      if (removeData && taskId) {
        const dataDir = `/home/fume/FumeData/${taskId}`;
        console.log(`Removing data directory ${dataDir}...`);
        
        try {
          // Check if it's a btrfs subvolume first
          const isSubvolume = await execAsync(`sudo btrfs subvolume show ${dataDir}`).then(() => true).catch(() => false);
          
          if (isSubvolume) {
            // Delete the btrfs subvolume
            await execAsync(`sudo btrfs subvolume delete ${dataDir}`);
          } else {
            // Regular directory removal
            await execAsync(`sudo rm -rf ${dataDir}`);
          }
          
          console.log(`Data directory ${dataDir} removed successfully`);
        } catch (dirError: unknown) {
          console.warn(`Error removing data directory: ${(dirError as Error).message}`);
          // Continue even if directory removal fails
        }
      }
      
      return res.json({
        success: true,
        message: `Minion container ${containerName} deleted successfully`,
        dataRemoved: removeData && taskId ? true : false
      });
    } catch (containerError: unknown) {
      // If container doesn't exist or other Docker error
      console.error(`Error with container ${containerName}:`, (containerError as Error).message);
      
      return res.status(404).json({
        success: false,
        error: `Container ${containerName} not found or could not be accessed`,
        details: (containerError as Error).message
      });
    }
  } catch (error: unknown) {
    console.error("Error deleting minion container:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 10. Interactive Command Execution Endpoint ----
app.post("/execute-command", async (req: Request, res: Response) => {
  try {
    const { process_id, input } = req.body;
    
    // Validate process_id is provided
    if (!process_id) {
      return res.status(400).json({
        success: false,
        error: "process_id parameter is required"
      });
    }
    
    // Get the process status
    const processStatus = processManager.getProcessStatus(process_id);
    
    // Case 1: Process doesn't exist yet, create it with the provided input as command
    if (!processStatus && input) {
      console.log(`Creating new process with ID: ${process_id}, command: ${input}`);
      
      // Start the process (treat input as the full command)
      const cmdPromise = processManager.startProcess(
        process_id,
        input,
        [], // No separate args
        {} // No special options
      );
      
      // Wait for initial output (or completion)
      try {
        // Use a 30-second timeout that resets on new output (up to 100 resets)
        const commandResult = await Promise.race([
          cmdPromise,
          new Promise(async (resolve) => {
            // Initial waiting period
            await new Promise(r => setTimeout(r, 500));
            
            console.log(`Waiting for initial output from process ${process_id} (30-second timeout, max 100 resets)...`);
            
            // Set up variables for waiting
            const checkInterval = 300; // ms
            let timeWithoutNewOutput = 0;
            const maxTimeWithoutNewOutput = 30000; // Fixed 30 second timeout
            let lastCheckedOutput = "";
            let resetCount = 0;
            const maxResets = 100; // Maximum number of timeout resets
            
            // Keep checking until we hit the timeout without new output or max resets
            while (timeWithoutNewOutput < maxTimeWithoutNewOutput && resetCount < maxResets) {
              await new Promise(r => setTimeout(r, checkInterval));
              timeWithoutNewOutput += checkInterval;
              
              const currentStatus = processManager.getProcessStatus(process_id);
              
              // If process is no longer active, break immediately
              if (currentStatus && !currentStatus.isActive) {
                console.log(`Process ${process_id} completed during initial wait, returning result immediately`);
                break;
              }
              
              // If we have new output
              if (currentStatus && currentStatus.lastOutput && 
                  currentStatus.lastOutput !== lastCheckedOutput) {
                resetCount++;
                console.log(`New output detected from process ${process_id}, resetting timeout (reset #${resetCount}/${maxResets})`);
                // Reset the timeout when we get new output
                timeWithoutNewOutput = 0;
                lastCheckedOutput = currentStatus.lastOutput;
              }
            }
            
            if (resetCount >= maxResets) {
              console.log(`Maximum reset count (${maxResets}) reached for process ${process_id}`);
            } else if (timeWithoutNewOutput >= maxTimeWithoutNewOutput) {
              console.log(`Timeout of ${maxTimeWithoutNewOutput}ms reached for process ${process_id}`);
            }
            
            resolve(null);
          })
        ]);
        
        // If the command completed already
        if (commandResult) {
          return res.json({
            success: true,
            process_id,
            status: "completed",
            output: (commandResult as any).stdout,
            exit_code: (commandResult as any).exitCode,
            working_directory: (commandResult as any).workingDirectory
          });
        }
        
        // If still running, return current status
        const updatedStatus = processManager.getProcessStatus(process_id);
        return res.json({
          success: true,
          process_id,
          status: updatedStatus?.isActive ? "running" : "completed",
          output: updatedStatus?.output || "", // Return all accumulated output
          working_directory: updatedStatus?.workingDirectory || ""
        });
      } catch (error) {
        // If there was an error executing the command
        return res.status(500).json({
          success: false,
          process_id,
          error: error instanceof Error ? error.message : "Unknown error",
          status: "error"
        });
      }
    }
    
    // Case 2: Process exists, send input if provided
    if (processStatus && input) {
      console.log(`Sending input to existing process ${process_id}: ${input}`);
      
      // If the process exists but is no longer active, restart it with the new input
      if (!processStatus.isActive) {
        console.log(`Process ${process_id} is completed. Restarting with new command: ${input}`);
        
        // Start a new process with the same ID but new command
        const cmdPromise = processManager.startProcess(
          process_id,
          input,
          [], // No separate args
          {cwd: processStatus.workingDirectory} // Maintain working directory
        );
        
        // Wait for initial output (or completion)
        try {
          // Use a 30-second timeout that resets on new output (up to 100 resets)
          const commandResult = await Promise.race([
            cmdPromise,
            new Promise(async (resolve) => {
              // Initial waiting period
              await new Promise(r => setTimeout(r, 500));
              
              console.log(`Waiting for initial output from process ${process_id} (30-second timeout, max 100 resets)...`);
              
              // Set up variables for waiting
              const checkInterval = 300; // ms
              let timeWithoutNewOutput = 0;
              const maxTimeWithoutNewOutput = 30000; // Fixed 30 second timeout
              let lastCheckedOutput = "";
              let resetCount = 0;
              const maxResets = 100; // Maximum number of timeout resets
              
              // Keep checking until we hit the timeout without new output or max resets
              while (timeWithoutNewOutput < maxTimeWithoutNewOutput && resetCount < maxResets) {
                await new Promise(r => setTimeout(r, checkInterval));
                timeWithoutNewOutput += checkInterval;
                
                const currentStatus = processManager.getProcessStatus(process_id);
                
                // If process is no longer active, break immediately
                if (currentStatus && !currentStatus.isActive) {
                  console.log(`Process ${process_id} completed during initial wait, returning result immediately`);
                  break;
                }
                
                // If we have new output
                if (currentStatus && currentStatus.lastOutput && 
                    currentStatus.lastOutput !== lastCheckedOutput) {
                  resetCount++;
                  console.log(`New output detected from process ${process_id}, resetting timeout (reset #${resetCount}/${maxResets})`);
                  // Reset the timeout when we get new output
                  timeWithoutNewOutput = 0;
                  lastCheckedOutput = currentStatus.lastOutput;
                }
              }
              
              if (resetCount >= maxResets) {
                console.log(`Maximum reset count (${maxResets}) reached for process ${process_id}`);
              } else if (timeWithoutNewOutput >= maxTimeWithoutNewOutput) {
                console.log(`Timeout of ${maxTimeWithoutNewOutput}ms reached for process ${process_id}`);
              }
              
              resolve(null);
            })
          ]);
          
          // If the command completed already
          if (commandResult) {
            return res.json({
              success: true,
              process_id,
              status: "completed",
              output: (commandResult as any).stdout,
              exit_code: (commandResult as any).exitCode,
              working_directory: (commandResult as any).workingDirectory
            });
          }
          
          // If still running, return current status
          const updatedStatus = processManager.getProcessStatus(process_id);
          return res.json({
            success: true,
            process_id,
            status: updatedStatus?.isActive ? "running" : "completed",
            output: updatedStatus?.output || "", // Return all accumulated output
            working_directory: updatedStatus?.workingDirectory || ""
          });
        } catch (error) {
          // If there was an error executing the command
          return res.status(500).json({
            success: false,
            process_id,
            error: error instanceof Error ? error.message : "Unknown error",
            status: "error"
          });
        }
      }
      
      // Process is active, send input
      const inputSent = processManager.sendInput(process_id, input);
      
      if (!inputSent) {
        return res.status(400).json({
          success: false,
          process_id,
          error: "Process is not accepting input",
          status: "error"
        });
      }
      
      // Wait for output with a 30-second timeout that resets on new output (up to 100 resets)
      console.log(`Waiting for output from process ${process_id} (30-second timeout, max 100 resets)...`);
      
      // Wait for output to appear with a check every 300ms
      const checkInterval = 300; // ms
      let timeWithoutNewOutput = 0;
      const maxTimeWithoutNewOutput = 30000; // Fixed 30 second timeout
      let lastCheckedOutput = processManager.getProcessStatus(process_id)?.lastOutput || "";
      let resetCount = 0;
      const maxResets = 100; // Maximum number of timeout resets
      
      // Keep checking until we hit the timeout without new output or max resets
      while (timeWithoutNewOutput < maxTimeWithoutNewOutput && resetCount < maxResets) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        timeWithoutNewOutput += checkInterval;
        
        const currentStatus = processManager.getProcessStatus(process_id);
        
        if (!currentStatus?.isActive) {
          console.log(`Process ${process_id} completed, returning result immediately`);
          break; // Process completed, return immediately
        }
        
        // If we have new output that's not just the echo of our input
        if (currentStatus?.lastOutput && 
            currentStatus.lastOutput !== lastCheckedOutput && 
            currentStatus.lastOutput !== input + '\n') {
          
          resetCount++;
          console.log(`New output detected from process ${process_id}, resetting timeout (reset #${resetCount}/${maxResets})`);
          // Reset the timeout when we get new output
          timeWithoutNewOutput = 0;
          lastCheckedOutput = currentStatus.lastOutput;
        }

      }
      
      if (resetCount >= maxResets) {
        console.log(`Maximum reset count (${maxResets}) reached for process ${process_id}`);
      } else if (timeWithoutNewOutput >= maxTimeWithoutNewOutput) {
        console.log(`Timeout of ${maxTimeWithoutNewOutput}ms reached for process ${process_id}`);
      }
      
      // Get updated status
      const updatedStatus = processManager.getProcessStatus(process_id);
      
      return res.json({
        success: true,
        process_id,
        status: updatedStatus?.isActive ? "running" : "completed",
        output: updatedStatus?.output || "", // Return full output instead of just last piece
        working_directory: updatedStatus?.workingDirectory || ""
      });
    }
    
    // Case 3: Process exists, just checking status (no input)
    if (processStatus && !input) {
      return res.json({
        success: true,
        process_id,
        status: processStatus.isActive ? "running" : "completed",
        output: processStatus.output,
        working_directory: processStatus.workingDirectory,
        created_at: processStatus.createdAt,
        last_activity: processStatus.lastActivity
      });
    }
    
    // Case 4: Process doesn't exist and no input provided
    if (!processStatus && !input) {
      return res.status(400).json({
        success: false,
        error: "Process does not exist. You must provide input to create it."
      });
    }
    
    // Should never reach here, but just in case
    return res.status(500).json({
      success: false,
      error: "Unexpected state in command execution endpoint"
    });
  } catch (error: unknown) {
    console.error("Error in execute-command endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 11. List Command Processes Endpoint ----
app.get("/list-processes", async (req: Request, res: Response) => {
  try {
    const processIds = processManager.listProcessIds();
    const processes = processIds.map((id: string) => {
      const status = processManager.getProcessStatus(id);
      return {
        process_id: id,
        command: status?.command,
        status: status?.isActive ? "running" : "completed",
        created_at: status?.createdAt,
        last_activity: status?.lastActivity,
        working_directory: status?.workingDirectory
      };
    });
    
    return res.json({
      success: true,
      count: processes.length,
      processes
    });
  } catch (error: unknown) {
    console.error("Error listing command processes:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 3.5. File Upload Endpoint ----
app.post("/upload-file", async (req: Request, res: Response) => {
  try {
    // Ensure the browser is running
    await ensureBrowserIsRunning(DEFAULT_VIEWPORT_SIZE);

    const {
      file_input_selector,
      file_input_description,
      file_base64,
      file_path,
      post_upload_selector,
      post_upload_wait_ms = 10000
    } = req.body || {};

    if (!file_base64 && !file_path) {
      return res.status(400).json({
        success: false,
        error: "Either file_base64 or file_path parameter must be provided"
      });
    }

    // Track the selector finding journey
    const selectorJourney: any = {
      provided_selector: file_input_selector || null,
      provided_description: file_input_description || null,
      discovery_attempts: [],
      final_selector: null,
      discovery_method: null
    };

    // Determine the selector to use
    let inputSelector: string | undefined = file_input_selector;

    if (!inputSelector) {
      try {
        const instruction = file_input_description
          ? `Find the file input described as: ${file_input_description}`
          : "Find the file upload input or button on this page";

        console.log(`Attempting to discover file input selector using observe() with instruction: "${instruction}"`);
        selectorJourney.discovery_attempts.push({
          method: "observe",
          instruction: instruction,
          status: "attempting"
        });
        
        const observations: any[] = await stagehand!.page.observe({ instruction });
        selectorJourney.discovery_attempts[selectorJourney.discovery_attempts.length - 1].observations_count = observations.length;
        selectorJourney.discovery_attempts[selectorJourney.discovery_attempts.length - 1].observations = observations.map(obs => ({
          description: obs.description,
          selector: obs.selector,
          element_type: obs.element_type || 'unknown'
        }));

        let candidate;
        if (file_input_description) {
          // If a description is provided, trust the first result from observe()
          candidate = observations[0];
          if (candidate) {
            console.log(`Using first observation based on description: "${candidate.description}"`);
            selectorJourney.discovery_attempts[selectorJourney.discovery_attempts.length - 1].selection_strategy = "first_result_with_description";
          }
        } else {
          // Otherwise, find a candidate that looks like a file upload
          candidate = observations.find((obs) => {
            const combined = `${obs.description || ''} ${obs.selector || ''}`.toLowerCase();
            return combined.includes('file') || combined.includes('upload');
          });
          if (candidate) {
            selectorJourney.discovery_attempts[selectorJourney.discovery_attempts.length - 1].selection_strategy = "keyword_match_file_upload";
          }
        }

        if (candidate?.selector) {
          inputSelector = candidate.selector;
          console.log(`Discovered selector via observe(): ${inputSelector}`);
          selectorJourney.discovery_attempts[selectorJourney.discovery_attempts.length - 1].status = "success";
          selectorJourney.discovery_attempts[selectorJourney.discovery_attempts.length - 1].selected_candidate = candidate;
          selectorJourney.discovery_method = "observe";
        } else {
          selectorJourney.discovery_attempts[selectorJourney.discovery_attempts.length - 1].status = "no_suitable_candidate";
          
          // Fallback: query DOM directly for common file inputs
          console.log("observe() did not return a suitable selector, falling back to direct DOM query.");
          selectorJourney.discovery_attempts.push({
            method: "dom_query",
            query: 'input[type="file"]',
            status: "attempting"
          });
          
          const handle = await stagehand!.page.$('input[type="file"]');
          if (handle) {
            inputSelector = await handle.evaluate((el: HTMLElement) => {
              if (el.id) return `#${el.id}`;
              if (el.getAttribute('name')) return `input[name="${el.getAttribute('name')}"]`;
              return 'input[type="file"]';
            });
            console.log(`Discovered selector via DOM query: ${inputSelector}`);
            selectorJourney.discovery_attempts[selectorJourney.discovery_attempts.length - 1].status = "success";
            selectorJourney.discovery_attempts[selectorJourney.discovery_attempts.length - 1].found_selector = inputSelector;
            selectorJourney.discovery_method = "dom_query";
          } else {
            selectorJourney.discovery_attempts[selectorJourney.discovery_attempts.length - 1].status = "not_found";
          }
        }
      } catch (obsErr) {
        console.warn("Automatic selector discovery failed:", obsErr);
        selectorJourney.discovery_attempts.push({
          method: "error",
          error: obsErr instanceof Error ? obsErr.message : "Unknown error",
          status: "failed"
        });
      }
    } else {
      selectorJourney.discovery_method = "provided";
    }

    selectorJourney.final_selector = inputSelector;

    if (!inputSelector) {
      return res.status(404).json({
        success: false,
        error: "Unable to locate file input element automatically. Please provide file_input_selector.",
        selector_journey: selectorJourney
      });
    }

    // Prepare local file path
    let localFilePath = "";
    let tempFileCreated = false;
    try {
      if (file_path) {
        if (!fs.existsSync(file_path)) {
          throw new Error(`File not found at path: ${file_path}`);
        }
        localFilePath = file_path;
      } else {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload_"));
        // Generate a default filename with timestamp
        const timestamp = Date.now();
        const defaultFileName = `uploaded_file_${timestamp}`;
        localFilePath = path.join(tempDir, defaultFileName);
        const buffer = Buffer.from(file_base64, "base64");
        fs.writeFileSync(localFilePath, buffer);
        tempFileCreated = true;
        console.log(`Temporary file created at ${localFilePath}`);
      }
    } catch (prepError) {
      console.error("Error preparing file for upload:", prepError);
      return res.status(500).json({
        success: false,
        error: prepError instanceof Error ? prepError.message : "Error preparing file for upload",
        selector_journey: selectorJourney
      });
    }

    try {
      // For hidden inputs `waitForSelector` will keep waiting for visibility by default, so we
      // explicitly wait for the element to be *attached* (present in the DOM) regardless of
      // its visibility. Playwright can still set files on a hidden <input type="file">.
      await stagehand!.page.waitForSelector(inputSelector, { timeout: 10000, state: "attached" });
      await stagehand!.page.setInputFiles(inputSelector, localFilePath);
      console.log(`File set on input ${inputSelector}`);

      if (post_upload_selector) {
        try {
          await stagehand!.page.waitForSelector(post_upload_selector, { timeout: 5000 });
          await stagehand!.page.click(post_upload_selector);
          console.log(`Clicked post-upload selector ${post_upload_selector}`);
        } catch (postClickErr) {
          console.warn(`Post-upload click error (continuing): ${postClickErr instanceof Error ? postClickErr.message : postClickErr}`);
        }
      }

      if (post_upload_wait_ms && post_upload_wait_ms > 0) {
        try {
          await stagehand!.page.waitForLoadState('networkidle', { timeout: post_upload_wait_ms }).catch(() => {});
        } catch (waitErr) {
          console.warn("Post-upload wait error (continuing):", waitErr);
        }
      }

      return res.json({
        success: true,
        message: "File upload action completed successfully",
        selector_journey: selectorJourney,
        used_selector: inputSelector,
        temp_file_created: tempFileCreated
      });
    } catch (uploadError) {
      console.error("File upload error:", uploadError);
      return res.status(500).json({
        success: false,
        error: uploadError instanceof Error ? uploadError.message : "Unknown error during file upload",
        selector_journey: selectorJourney
      });
    } finally {
      if (tempFileCreated) {
        try {
          fs.unlinkSync(localFilePath);
          console.log(`Temporary file ${localFilePath} deleted`);
        } catch (cleanupErr) {
          console.warn("Error deleting temporary file:", cleanupErr);
        }
      }
    }
  } catch (error: unknown) {
    console.error("Error in upload-file endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error in upload-file endpoint",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 12. Run Playwright Tests Endpoint ----
app.post("/run-playwright", async (req: Request, res: Response) => {
  try {
    // Allow long-running Playwright tests (up to 2 hours)
    res.setTimeout(2 * 60 * 60 * 1000);

    // Use a unique process id so multiple runs can coexist if needed
    const process_id = `run-playwright-${Date.now()}`;

    console.log(`Starting Playwright tests with process id ${process_id}`);

    // Prepare command – run as the same user (no sudo) and make sure we are in the correct directory
    const command = "bash";
    const args = [
      "-c",
      "cd /home/fume/boilerplate && npx playwright test --reporter=list --retries=0"
    ];

    // Start the process using the shared ProcessManager so we get robust output handling
    const cmdPromise = processManager.startProcess(
      process_id,
      command,
      args,
      {
        cwd: "/home/fume/boilerplate",
        env: process.env,
        // Disable built-in timeouts – tests can run for a long time
        timeout: 0 as unknown as number // Cast to avoid type issues; 0 means no timeout
      }
    );

    // Wait for the Playwright run to finish but enforce a hard 2-hour limit
    const timeoutMs = 2 * 60 * 60 * 1000; // 2 hours
    const result = await Promise.race([
      cmdPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Playwright tests timed out after ${timeoutMs / 1000 / 60} minutes`)), timeoutMs)
      )
    ]);

    // Fallback – ensure we always have an exitCode in the result object
    if ((result as any).exitCode === undefined) {
      (result as any).exitCode = 1;
    }

    console.log(
      `Playwright tests completed for process id ${process_id} with exit code ${(result as any).exitCode}`
    );

    // Trim very large output to avoid overwhelming the client (keep the last 1MB)
    const MAX_OUTPUT_SIZE = 1024 * 1024; // 1 MB
    let stdout = (result as any).stdout || "";
    let stderr = (result as any).stderr || "";
    const stdout_truncated = stdout.length > MAX_OUTPUT_SIZE;
    const stderr_truncated = stderr.length > MAX_OUTPUT_SIZE;
    if (stdout_truncated) {
      stdout = stdout.slice(-MAX_OUTPUT_SIZE);
    }
    if (stderr_truncated) {
      stderr = stderr.slice(-MAX_OUTPUT_SIZE);
    }

    // Check for assertion results image file
    const assertionImagePath = "/home/fume/boilerplate/assertion_results/failed-assertion.png";
    let assertionImage = null;
    
    try {
      if (fs.existsSync(assertionImagePath)) {
        console.log(`Found assertion results image at ${assertionImagePath}`);
        const imageBuffer = fs.readFileSync(assertionImagePath);
        assertionImage = imageBuffer.toString('base64');
        console.log(`Assertion image encoded, size: ${assertionImage.length} characters`);
        
        // Remove the image file after reading it
        try {
          fs.unlinkSync(assertionImagePath);
          console.log(`Assertion image file removed: ${assertionImagePath}`);
        } catch (deleteError) {
          console.warn(`Error deleting assertion image file: ${deleteError instanceof Error ? deleteError.message : 'Unknown error'}`);
        }
      } else {
        console.log(`No assertion results image found at ${assertionImagePath}`);
      }
    } catch (imageError) {
      console.warn(`Error reading assertion image: ${imageError instanceof Error ? imageError.message : 'Unknown error'}`);
    }

    // Log once the response has actually been flushed – helps confirm the request finished
    res.on("finish", () => {
      console.log(`Response sent for Playwright run ${process_id}`);
    });

    return res.json({
      success: (result as any).exitCode === 0,
      exit_code: (result as any).exitCode,
      stdout,
      stderr,
      stdout_truncated,
      stderr_truncated,
      process_id,
      assertion_image: assertionImage
    });
  } catch (error: unknown) {
    console.error("Error running Playwright tests:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error during Playwright run",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

app.post("/run-tmp-playwright", async (req: Request, res: Response) => {
  try {
    // Allow long-running Playwright tests (up to 30 minutes)
    res.setTimeout(30 * 60 * 1000);
    
    // Get test code and file path from request body
    const { testCode, filePath } = req.body;

    if (!testCode || !filePath) {
      return res.status(400).json({
        success: false,
        error: "Both testCode and filePath are required"
      });
    }

    // Ensure the tmp directory exists
    const tmpDir = '/home/fume/tmp/boilerplate/tests';
    try {
      await fs.promises.mkdir(tmpDir, { recursive: true });
    } catch (mkdirError) {
      console.error("Error creating tmp directory:", mkdirError);
      return res.status(500).json({
        success: false,
        error: "Failed to create tmp directory"
      });
    }

    // Write test code to file
    const fullPath = path.join(tmpDir, filePath);
    try {
      // Ensure parent directory exists
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, testCode);
      console.log(`Test file written to ${fullPath}`);
    } catch (writeError) {
      console.error("Error writing test file:", writeError);
      return res.status(500).json({
        success: false,
        error: "Failed to write test file"
      });
    }
    // Use a unique process id so multiple runs can coexist if needed
    const process_id = `run-playwright-${Date.now()}`;

    console.log(`Starting Playwright tests with process id ${process_id}`);

    let cdpEndpoint = "http://127.0.0.1:9222";
    console.log("CDP Endpoint:", cdpEndpoint);

    // --- Temporary Playwright config that attaches to the existing browser ---
    const tempConfigContent = `
import type { PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
  retries: 0,
  reporter: 'list',
  testIgnore: ['**/stagehand/**'],
  timeout: 30 * 60 * 1000, // 30 minutes per test

  projects: [
    {
      name: 'live-chrome',
      use: {
        browserName: 'chromium',
        // Attach to the already-running Chrome via CDP instead of launching a new instance
        connectOverCDP: process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222',
        reuseExistingContext: true,
        headless: false,
        viewport: null
      }
    }
  ]
};

export default config;
`;
    
    // Write the temporary config file to disk to avoid shell quoting issues
    const tempConfigPath = `/home/fume/tmp/boilerplate/playwright.tmp.config.${process_id}.ts`;
    await fs.promises.writeFile(tempConfigPath, tempConfigContent);
    const tempConfigFileName = path.basename(tempConfigPath);
    
    const command = "bash";
    const args = [
      "-c",
      `cd /home/fume/tmp/boilerplate && npx playwright test --config=${tempConfigFileName} && rm -f ${tempConfigFileName}`
    ];

    // Start the process using the shared ProcessManager so we get robust output handling
    const cmdPromise = processManager.startProcess(
      process_id,
      command,
      args,
      {
        cwd: "/home/fume/tmp/boilerplate",
        env: process.env,
        // Disable built-in timeouts – tests can run for a long time
        timeout: 0 as unknown as number // Cast to avoid type issues; 0 means no timeout
      }
    );

    // Wait for the Playwright run to finish but enforce a hard 30-minute limit
    const timeoutMs = 30 * 60 * 1000; // 30 minutes
    const result = await Promise.race([
      cmdPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Playwright tests timed out after ${timeoutMs / 1000 / 60} minutes`)), timeoutMs)
      )
    ]);

    // Fallback – ensure we always have an exitCode in the result object
    if ((result as any).exitCode === undefined) {
      (result as any).exitCode = 1;
    }

    console.log(
      `Playwright tests completed for process id ${process_id} with exit code ${(result as any).exitCode}`
    );

    // Trim very large output to avoid overwhelming the client (keep the last 1MB)
    const MAX_OUTPUT_SIZE = 1024 * 1024; // 1 MB
    let stdout = (result as any).stdout || "";
    let stderr = (result as any).stderr || "";
    const stdout_truncated = stdout.length > MAX_OUTPUT_SIZE;
    const stderr_truncated = stderr.length > MAX_OUTPUT_SIZE;
    if (stdout_truncated) {
      stdout = stdout.slice(-MAX_OUTPUT_SIZE);
    }
    if (stderr_truncated) {
      stderr = stderr.slice(-MAX_OUTPUT_SIZE);
    }

    // Check for assertion results image file
    const assertionImagePath = "/home/fume/boilerplate/assertion_results/failed-assertion.png";
    let assertionImage = null;
    
    try {
      if (fs.existsSync(assertionImagePath)) {
        console.log(`Found assertion results image at ${assertionImagePath}`);
        const imageBuffer = fs.readFileSync(assertionImagePath);
        assertionImage = imageBuffer.toString('base64');
        console.log(`Assertion image encoded, size: ${assertionImage.length} characters`);
        
        // Remove the image file after reading it
        try {
          fs.unlinkSync(assertionImagePath);
          console.log(`Assertion image file removed: ${assertionImagePath}`);
        } catch (deleteError) {
          console.warn(`Error deleting assertion image file: ${deleteError instanceof Error ? deleteError.message : 'Unknown error'}`);
        }
      } else {
        console.log(`No assertion results image found at ${assertionImagePath}`);
      }
    } catch (imageError) {
      console.warn(`Error reading assertion image: ${imageError instanceof Error ? imageError.message : 'Unknown error'}`);
    }

    // Log once the response has actually been flushed – helps confirm the request finished
    res.on("finish", () => {
      console.log(`Response sent for Playwright run ${process_id}`);
    });

    return res.json({
      success: (result as any).exitCode === 0,
      exit_code: (result as any).exitCode,
      stdout,
      stderr,
      stdout_truncated,
      stderr_truncated,
      process_id,
      assertion_image: assertionImage
    });
  } catch (error: unknown) {
    console.error("Error running Playwright tests:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error during Playwright run",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- CDP Proxy Endpoint ----
app.get("/cdp-info", async (req: Request, res: Response) => {
  try {
    if (!stagehand?.page) {
      return res.status(400).json({
        success: false,
        error: "No active browser session"
      });
    }

    const browser = stagehand.page.context().browser();
    const pageUrl = stagehand.page.url();
    
    // Get tabs/pages information
    const pages = stagehand.page.context().pages();
    const tabs = pages.map((page, index) => ({
      id: `page_${index}`,
      title: page.url(),
      url: page.url(),
      type: 'page'
    }));

    res.json({
      success: true,
      version: {
        Browser: "Chrome/Playwright",
        "Protocol-Version": "1.3",
        "User-Agent": await stagehand.page.evaluate(() => navigator.userAgent),
        "V8-Version": "N/A",
        webSocketDebuggerUrl: `ws://localhost:9222/devtools/page/${tabs[0]?.id || 'default'}`
      },
      tabs: tabs,
      current_page: {
        url: pageUrl,
        title: await stagehand.page.title()
      }
    });
  } catch (error) {
    console.error("Error in CDP info endpoint:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

// ---- React Component Helper Endpoint ----
app.get("/chrome-streamer-component", (req: Request, res: Response) => {
  const serverHost = req.get('host')?.split(':')[0] || 'localhost';
  const serverPort = process.env.PORT || 5553;
  
  const componentCode = `
import React, { useState, useEffect, useRef } from 'react';

const ChromeStreamer = () => {
  const [screenshot, setScreenshot] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');
  const intervalRef = useRef(null);

  const startStreaming = async () => {
    const fetchScreenshot = async () => {
      try {
        const response = await fetch('http://${serverHost}:${serverPort}/screenshot');
        const data = await response.json();
        if (data.success) {
          setScreenshot('data:image/png;base64,' + data.data);
          setCurrentUrl(data.current_url);
        }
      } catch (error) {
        console.error('Error fetching screenshot:', error);
      }
    };

    await fetchScreenshot();
    intervalRef.current = setInterval(fetchScreenshot, 1000);
    setIsConnected(true);
  };

  const stopStreaming = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsConnected(false);
    setScreenshot(null);
  };

  const handleClick = async (e) => {
    const rect = e.target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    try {
      await fetch('http://${serverHost}:${serverPort}/act', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: \`click at coordinates \${x}, \${y}\`,
          selector: null,
          action_type: 'click'
        })
      });
    } catch (error) {
      console.error('Error clicking:', error);
    }
  };

  useEffect(() => {
    return () => stopStreaming();
  }, []);

  return (
    <div style={{ padding: '20px' }}>
      <h2>Chrome Remote Streamer</h2>
      <div style={{ marginBottom: '20px' }}>
        <button onClick={startStreaming} disabled={isConnected}>
          Start Streaming
        </button>
        <button onClick={stopStreaming} disabled={!isConnected} style={{ marginLeft: '10px' }}>
          Stop Streaming
        </button>
      </div>
      {currentUrl && (
        <div style={{ marginBottom: '10px' }}>
          <strong>Current URL:</strong> {currentUrl}
        </div>
      )}
      {screenshot && (
        <div>
          <img
            src={screenshot}
            alt="Remote Chrome"
            onClick={handleClick}
            style={{
              maxWidth: '100%',
              border: '1px solid #ccc',
              cursor: 'pointer'
            }}
          />
        </div>
      )}
    </div>
  );
};

export default ChromeStreamer;
  `;

  res.type('text/javascript').send(componentCode);
});

// ---- Server Listen ----
const PORT = process.env.PORT || 5553;

// Create HTTP server for WebSocket support
const server = http.createServer(app);

// Single WebSocket server with path-based routing
const wss = new WebSocketServer({ 
  server,
  verifyClient: (info: any) => {
    const pathname = new URL(info.req.url!, `http://${info.req.headers.host}`).pathname;
    return pathname === '/webrtc-signal' || pathname === '/cdp-stream';
  }
});

let nextCDPClientId = 1;

// Store WebRTC peer connections and signaling state
const webrtcClients = new Map<WebSocket, {
  id: string;
  peerConnection: RTCPeerConnection | null;
  isConnected: boolean;
  videoSource: any | null;
  frameInterval: NodeJS.Timeout | null;
}>();

let nextClientId = 1;

// Screenshot semaphore to prevent concurrent screenshots
let isScreenshotInProgress = false;

// Function to convert RGBA to YUV420 planar format
function rgbaToYuv420(rgbaData: Uint8Array, width: number, height: number): Uint8Array {
  const ySize = width * height;
  const uvSize = (width * height) / 4;
  const yuvData = new Uint8Array(ySize + uvSize * 2);
  
  let yIndex = 0;
  let uIndex = ySize;
  let vIndex = ySize + uvSize;
  
  // Convert RGBA to YUV
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const rgbaIndex = (row * width + col) * 4;
      const r = rgbaData[rgbaIndex];
      const g = rgbaData[rgbaIndex + 1];
      const b = rgbaData[rgbaIndex + 2];
      
      // Convert RGB to YUV using standard coefficients
      const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      yuvData[yIndex++] = Math.max(0, Math.min(255, y));
      
      // Sample U and V at half resolution (4:2:0 subsampling)
      if (row % 2 === 0 && col % 2 === 0) {
        const u = Math.round(-0.147 * r - 0.289 * g + 0.436 * b + 128);
        const v = Math.round(0.615 * r - 0.515 * g - 0.100 * b + 128);
        yuvData[uIndex++] = Math.max(0, Math.min(255, u));
        yuvData[vIndex++] = Math.max(0, Math.min(255, v));
      }
    }
  }
  
  return yuvData;
}

// Function to create video track using simple screenshot approach
async function createVideoTrackFromBrowser(peerConnection: any): Promise<any> {
  try {
    // Create RTCVideoSource for WebRTC
    const source = new RTCVideoSource();
    const track = source.createTrack();
    
    // Create a MediaStream and add the track to it
    const stream = new wrtc.MediaStream();
    stream.addTrack(track);
    
    console.log('MediaStream created:', {
      id: stream.id,
      active: stream.active,
      tracks: stream.getTracks().map(t => ({
        kind: t.kind,
        id: t.id,
        enabled: t.enabled,
        readyState: t.readyState
      }))
    });
    
    // Add track to peer connection with the stream
    peerConnection.addTrack(track, stream);
    
    console.log('Created RTCVideoSource with track');
    
    // Cache the expected buffer size once we determine it
    let cachedExpectedBytes: number | null = null;
    
    // Simple function to capture and send frames
    let isReconnecting = false;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;
    
    const sendFrame = async () => {
      if (isReconnecting || isScreenshotInProgress) return;
      
      isScreenshotInProgress = true;
      try {
        // Check if browser is available and responsive
        if (!stagehand?.page) {
          console.log('Stagehand page not available for frame capture, attempting reinitialization...');
          isReconnecting = true;
          try {
            await ensureBrowserIsRunning(DEFAULT_VIEWPORT_SIZE, true); // Enable remote access for WebRTC
            consecutiveErrors = 0;
            console.log('Browser reinitialized successfully for WebRTC');
          } catch (reinitError) {
            console.error('Failed to reinitialize browser:', reinitError);
            consecutiveErrors++;
          } finally {
            isReconnecting = false;
          }
          return;
        }
        
        // Check if page is still valid
        if (stagehand.page.isClosed()) {
          console.log('Browser page is closed, attempting reinitialization...');
          isReconnecting = true;
          try {
            await ensureBrowserIsRunning(DEFAULT_VIEWPORT_SIZE, true);
            consecutiveErrors = 0;
            console.log('Browser reinitialized after page close');
          } catch (reinitError) {
            console.error('Failed to reinitialize browser after page close:', reinitError);
            consecutiveErrors++;
          } finally {
            isReconnecting = false;
          }
          return;
        }
        
        // Take screenshot as buffer
        const screenshot = await stagehand.page.screenshot({
          type: 'png',
          fullPage: false
        });
        
        // Load image and create canvas
        const image = await loadImage(screenshot);
        
        // Use a reasonable resolution for video streaming
        let targetWidth = 320;
        let targetHeight = 240;
        
        const canvas = createCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
        
        // Get raw RGBA data
        const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
        
        // Try using RGBA directly first to debug
        const rgbaData = new Uint8Array(imageData.data);
        
        // If we haven't determined the expected buffer size yet, try to detect it
        if (cachedExpectedBytes === null) {
          console.log(`First frame: ${targetWidth}x${targetHeight}, RGBA data length: ${rgbaData.length}`);
          
          try {
            const frame = {
              width: targetWidth,
              height: targetHeight,
              data: rgbaData,
              timestamp: Date.now() * 1000
            };
            
            source.onFrame(frame);
            // If successful, cache the buffer size
            cachedExpectedBytes = rgbaData.byteLength;
            console.log(`Frame sent successfully, cached buffer size: ${cachedExpectedBytes} bytes`);
            
          } catch (sizeError) {
            console.log('RGBA failed, trying YUV conversion...');
            // Convert RGBA to YUV420 planar format
            const yuvData = rgbaToYuv420(rgbaData, targetWidth, targetHeight);
            console.log(`Trying YUV: ${targetWidth}x${targetHeight}, YUV data length: ${yuvData.length}`);
            
            try {
              const yuvFrame = {
                width: targetWidth,
                height: targetHeight,
                data: yuvData,
                timestamp: Date.now() * 1000
              };
              
              source.onFrame(yuvFrame);
              cachedExpectedBytes = yuvData.byteLength;
              console.log(`YUV frame sent successfully, cached buffer size: ${cachedExpectedBytes} bytes`);
              
            } catch (yuvError: any) {
              // Extract the expected size from the error message
              const errorMessage = yuvError.message || '';
              const expectedMatch = errorMessage.match(/Expected a \.byteLength of (\d+)/);
              
              if (expectedMatch) {
                cachedExpectedBytes = parseInt(expectedMatch[1]);
                console.log(`Detected expected buffer size: ${cachedExpectedBytes} bytes (got ${yuvData.byteLength})`);
              } else {
                console.error('Could not parse expected buffer size from error:', errorMessage);
                throw yuvError;
              }
            }
          }
        }
        
        // Now use the cached expected buffer size
        if (cachedExpectedBytes !== null) {
          // Try RGBA first, then YUV if needed
          let frameData = rgbaData;
          if (cachedExpectedBytes !== rgbaData.byteLength) {
            // Convert to YUV if RGBA size doesn't match
            frameData = rgbaToYuv420(rgbaData, targetWidth, targetHeight);
          }
          
          // Create a buffer of exactly the expected size
          const exactBuffer = new ArrayBuffer(cachedExpectedBytes);
          const exactView = new Uint8Array(exactBuffer);
          
          // Copy our frame data into the exact buffer (truncate or pad as needed)
          const copyLength = Math.min(frameData.length, exactView.length);
          exactView.set(frameData.subarray(0, copyLength), 0);
          
          // Create frame with the exact buffer size and proper timestamp
          const frame = {
            width: targetWidth,
            height: targetHeight,
            data: exactView,
            timestamp: Date.now() * 1000  // microseconds
          };
          
          source.onFrame(frame);
        }
        
        // Reset consecutive error count on successful frame
        consecutiveErrors = 0;
        
      } catch (error) {
        consecutiveErrors++;
        console.error(`Error capturing frame (error ${consecutiveErrors}/${maxConsecutiveErrors}):`, error);
        
        // If too many consecutive errors, send a black frame as fallback
        if (consecutiveErrors >= maxConsecutiveErrors) {
          console.log('Too many consecutive frame capture errors, sending black fallback frame');
          try {
            // Create a black frame as fallback
            if (cachedExpectedBytes) {
              const blackBuffer = new ArrayBuffer(cachedExpectedBytes);
              const blackView = new Uint8Array(blackBuffer);
              // Fill with black pixels (all zeros)
              blackView.fill(0);
              
              const fallbackFrame = {
                width: 320,
                height: 240,
                data: blackView,
                timestamp: Date.now() * 1000
              };
              
              source.onFrame(fallbackFrame);
              console.log('Sent black fallback frame');
            }
          } catch (fallbackError) {
            console.error('Failed to send fallback frame:', fallbackError);
          }
          return;
        }
        
        // Try to reinitialize browser if page is closed or other critical errors
        const errorMessage = (error as Error).message || '';
        if (errorMessage.includes('Target page, context or browser has been closed') ||
            errorMessage.includes('browser has been closed') ||
            errorMessage.includes('Execution context was destroyed')) {
          console.log('Browser/page lost, attempting reinitialization...');
          isReconnecting = true;
          try {
            await ensureBrowserIsRunning(DEFAULT_VIEWPORT_SIZE, true);
            console.log('Browser reinitialized after error');
            consecutiveErrors = 0; // Reset on successful reinit
          } catch (reinitError) {
            console.error('Failed to reinitialize browser after error:', reinitError);
          } finally {
            isReconnecting = false;
          }
        }
      } finally {
        isScreenshotInProgress = false;
      }
    };
    
    // Send frames at 10 FPS for smoother video playback
    const frameInterval = setInterval(sendFrame, 100);
    
    return { source, track, stream, frameInterval };
    
  } catch (error) {
    console.error('Error setting up video capture:', error);
    throw error;
  }
}

// Single WebSocket connection handler with path-based routing
wss.on('connection', (ws: WebSocket, req: any) => {
  const pathname = new URL(req.url!, `http://${req.headers.host}`).pathname;
  
  if (pathname === '/cdp-stream') {
    // CDP streaming connection handler
  const clientId = `cdp_client_${nextCDPClientId++}`;
  console.log(`CDP streaming client connected: ${clientId}`);
  
  const client: CDPStreamClient = {
    id: clientId,
    ws: ws,
    isStreaming: false,
    lastActivity: Date.now()
  };
  
  cdpStreamClients.set(clientId, client);
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      switch (message.type) {
        case 'start-stream':
          console.log(`Starting CDP stream for ${clientId}`);
          client.isStreaming = true;
          
          // Start CDP screencast if not already started
          if (!cdpSessionId) {
            try {
              // Ensure browser is running first
              await ensureBrowserIsRunning({ width: 1280, height: 720 });
              
              await startCDPScreencast();
              ws.send(JSON.stringify({
                type: 'stream-started',
                message: 'CDP streaming started successfully'
              }));
            } catch (error) {
              console.error('Failed to start CDP screencast:', error);
              client.isStreaming = false; // Reset streaming state on error
              ws.send(JSON.stringify({
                type: 'error',
                message: `Failed to start streaming: ${error}`
              }));
            }
          } else {
            ws.send(JSON.stringify({
              type: 'stream-started',
              message: 'CDP streaming already active'
            }));
          }
          
          // Send the last frame if available
          if (lastCDPFrame) {
            ws.send(JSON.stringify({
              type: 'frame',
              data: lastCDPFrame.data,
              metadata: lastCDPFrame.metadata
            }));
          }
          break;
          
        case 'stop-stream':
          console.log(`Stopping CDP stream for ${clientId}`);
          client.isStreaming = false;
          
          // Stop screencast if no clients are streaming
          const activeClients = Array.from(cdpStreamClients.values()).filter(c => c.isStreaming);
          if (activeClients.length === 0) {
            await stopCDPScreencast();
          }
          break;
          
        case 'input':
          // Handle input events
          try {
            await injectCDPInput(message.inputType, message.params);
            ws.send(JSON.stringify({
              type: 'input-ack',
              inputType: message.inputType
            }));
          } catch (error) {
            console.error(`Input injection error for ${clientId}:`, error);
            ws.send(JSON.stringify({
              type: 'error',
              message: `Input error: ${error}`
            }));
          }
          break;
          
        default:
          console.log(`Unknown CDP message type: ${message.type}`);
      }
    } catch (error) {
      console.error(`Error parsing CDP message from ${clientId}:`, error);
    }
  });
  
  ws.on('close', () => {
    console.log(`CDP streaming client disconnected: ${clientId}`);
    cdpStreamClients.delete(clientId);
    
    // Stop screencast if no clients remain
    if (cdpStreamClients.size === 0) {
      stopCDPScreencast();
    }
  });
  
  ws.on('error', (error) => {
    console.error(`CDP streaming error for ${clientId}:`, error);
  });
  
  } else if (pathname === '/webrtc-signal') {
    // WebRTC signaling connection handler
  const clientId = `client_${nextClientId++}`;
  console.log(`WebRTC signaling client connected: ${clientId}`);
  
  // Create a new peer connection for this client
  const peerConnection = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  });

  webrtcClients.set(ws, {
    id: clientId,
    peerConnection: peerConnection,
    isConnected: false,
    videoSource: null,
    frameInterval: null
  });

  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log(`Sending ICE candidate to ${clientId}`);
      ws.send(JSON.stringify({
        type: 'ice-candidate',
        candidate: event.candidate
      }));
    }
  };

  // Handle connection state changes
  peerConnection.onconnectionstatechange = () => {
    console.log(`WebRTC connection state for ${clientId}:`, peerConnection.connectionState);
    const client = webrtcClients.get(ws);
    if (client) {
      client.isConnected = peerConnection.connectionState === 'connected';
    }
  };

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`WebRTC message from ${clientId}:`, message.type);
      
      switch (message.type) {
        case 'start-stream':
          console.log(`Starting WebRTC stream for ${clientId}`);
          
          try {
            // Create video track using simple screenshot approach
            const { source, track, stream, frameInterval } = await createVideoTrackFromBrowser(peerConnection);
            console.log(`Created video track and stream for ${clientId}`);
            
            // Store the video source and frame interval for this client
            const client = webrtcClients.get(ws);
            if (client) {
              client.videoSource = source;
              client.frameInterval = frameInterval;
              console.log(`Video streaming started for ${clientId} at 10 FPS`);
            }
            
            // Create an offer since we're the server
            const offer = await peerConnection.createOffer({
              offerToReceiveAudio: false,
              offerToReceiveVideo: false  // We're sending video, not receiving
            });
            
            await peerConnection.setLocalDescription(offer);
            
            // Send the offer to the client
            ws.send(JSON.stringify({
              type: 'offer',
              offer: offer
            }));
            
            console.log(`Sent WebRTC offer with video track to ${clientId}`);
          } catch (error) {
            console.error(`Error creating WebRTC offer for ${clientId}:`, error);
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Failed to create WebRTC offer'
            }));
          }
          break;
          
        case 'answer':
          console.log(`Received WebRTC answer from ${clientId}`);
          try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
            console.log(`Set remote description for ${clientId}`);
          } catch (error) {
            console.error(`Error setting remote description for ${clientId}:`, error);
          }
          break;
          
        case 'ice-candidate':
          console.log(`Received ICE candidate from ${clientId}`);
          try {
            if (message.candidate) {
              await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
              console.log(`Added ICE candidate for ${clientId}`);
            }
          } catch (error) {
            console.error(`Error adding ICE candidate for ${clientId}:`, error);
          }
          break;
          
        default:
          console.log(`Unknown WebRTC message type: ${message.type}`);
      }
    } catch (error) {
      console.error(`Error parsing WebRTC message from ${clientId}:`, error);
    }
  });

  ws.on('close', () => {
    console.log(`WebRTC signaling client disconnected: ${clientId}`);
    const client = webrtcClients.get(ws);
    if (client) {
      if (client.frameInterval) {
        clearInterval(client.frameInterval);
        client.frameInterval = null;
        console.log(`Stopped video streaming for ${clientId}`);
      }
      if (client.peerConnection) {
        client.peerConnection.close();
      }
    }
    webrtcClients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error(`WebRTC signaling error for ${clientId}:`, error);
    const client = webrtcClients.get(ws);
    if (client && client.frameInterval) {
      clearInterval(client.frameInterval);
      client.frameInterval = null;
    }
  });
  
  } else {
    console.log('Unknown WebSocket path:', pathname);
    ws.close();
  }
});

// CDP Streaming System
interface CDPStreamClient {
  id: string;
  ws: WebSocket;
  isStreaming: boolean;
  lastActivity: number;
}

// Store CDP streaming clients
const cdpStreamClients = new Map<string, CDPStreamClient>();

// CDP frame cache to handle rapid frame updates
interface CDPFrame {
  data: string; // base64 encoded image
  metadata: {
    timestamp: number;
    deviceWidth: number;
    deviceHeight: number;
    pageScaleFactor: number;
    offsetTop: number;
    scrollX: number;
    scrollY: number;
  };
}

let lastCDPFrame: CDPFrame | null = null;
let cdpSessionId: any = null;

// Function to start CDP screencast
async function startCDPScreencast() {
  console.log('Starting CDP screencast...');
  
  if (!stagehand?.page) {
    console.error('Stagehand page not available for CDP screencast');
    throw new Error('Browser page not available');
  }

  // Ensure browser is responsive
  try {
    await stagehand.page.evaluate(() => true);
    console.log('Browser page is responsive');
  } catch (err) {
    console.error('Browser page is not responsive:', err);
    throw new Error('Browser page is not responsive');
  }

  try {
    console.log('Creating CDP session...');
    // Get CDP session
    const client = await stagehand.page.context().newCDPSession(stagehand.page);
    cdpSessionId = client;
    console.log('CDP session created successfully');

    // Configure screencast parameters
    console.log('Configuring CDP screencast parameters...');
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80, // High quality JPEG
      maxWidth: 1920,
      maxHeight: 1080,
      everyNthFrame: 1 // Capture every frame for smoothness
    });
    console.log('CDP screencast configuration sent successfully');

    // Handle incoming frames
    client.on('Page.screencastFrame', async (params: any) => {
      const { sessionId, data, metadata } = params;
      
      // Acknowledge frame receipt (required by CDP)
      await client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      
      // Cache the frame
      lastCDPFrame = {
        data,
        metadata: {
          timestamp: metadata.timestamp * 1000,
          deviceWidth: metadata.deviceWidth,
          deviceHeight: metadata.deviceHeight, 
          pageScaleFactor: metadata.pageScaleFactor || 1,
          offsetTop: metadata.offsetTop || 0,
          scrollX: metadata.scrollX || 0,
          scrollY: metadata.scrollY || 0
        }
      };

      // Broadcast to all connected clients
      broadcastCDPFrame(lastCDPFrame);
    });

    console.log('CDP screencast started successfully');
    return client;
  } catch (error) {
    console.error('Failed to start CDP screencast:', error);
    throw error;
  }
}

// Function to stop CDP screencast
async function stopCDPScreencast() {
  if (cdpSessionId) {
    try {
      await cdpSessionId.send('Page.stopScreencast');
      cdpSessionId = null;
    } catch (error) {
      console.error('Error stopping CDP screencast:', error);
    }
  }
}

// Broadcast frame to all connected clients
function broadcastCDPFrame(frame: CDPFrame) {
  const message = JSON.stringify({
    type: 'frame',
    data: frame.data,
    metadata: frame.metadata
  });

  cdpStreamClients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN && client.isStreaming) {
      client.ws.send(message, (err) => {
        if (err) {
          console.error(`Error sending frame to client ${client.id}:`, err);
        }
      });
      client.lastActivity = Date.now();
    }
  });
}

// Handle CDP input injection
async function injectCDPInput(type: string, params: any) {
  if (!stagehand?.page) {
    throw new Error('Browser page not available');
  }

  const client = cdpSessionId || await stagehand.page.context().newCDPSession(stagehand.page);

  try {
    switch (type) {
      case 'mouseMove':
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: params.x,
          y: params.y,
          modifiers: params.modifiers || 0
        });
        break;

      case 'mouseDown':
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: params.x,
          y: params.y,
          button: params.button || 'left',
          clickCount: params.clickCount || 1,
          modifiers: params.modifiers || 0
        });
        break;

      case 'mouseUp':
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: params.x,
          y: params.y,
          button: params.button || 'left',
          modifiers: params.modifiers || 0
        });
        break;

      case 'mouseWheel':
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: params.x,
          y: params.y,
          deltaX: params.deltaX || 0,
          deltaY: params.deltaY || 0,
          modifiers: params.modifiers || 0
        });
        break;

      case 'keyDown':
        // Only include text parameter if it's provided and valid
        const keyDownEvent: any = {
          type: 'keyDown',
          key: params.key,
          code: params.code,
          modifiers: params.modifiers || 0
        };
        
        // Add keyCode if provided (important for special keys)
        if (params.keyCode !== null && params.keyCode !== undefined) {
          keyDownEvent.windowsVirtualKeyCode = params.keyCode;
          keyDownEvent.nativeVirtualKeyCode = params.keyCode;
        }
        
        // Only add text for printable characters
        if (params.text && typeof params.text === 'string' && params.text.length === 1) {
          const charCode = params.text.charCodeAt(0);
          if (charCode >= 32 && charCode <= 126) {
            keyDownEvent.text = params.text;
          }
        }
        
        await client.send('Input.dispatchKeyEvent', keyDownEvent);
        break;

      case 'keyUp':
        const keyUpEvent: any = {
          type: 'keyUp',
          key: params.key,
          code: params.code,
          modifiers: params.modifiers || 0
        };
        
        // Add keyCode if provided (important for special keys)
        if (params.keyCode !== null && params.keyCode !== undefined) {
          keyUpEvent.windowsVirtualKeyCode = params.keyCode;
          keyUpEvent.nativeVirtualKeyCode = params.keyCode;
        }
        
        await client.send('Input.dispatchKeyEvent', keyUpEvent);
        break;

      case 'insertText':
        await client.send('Input.insertText', {
          text: params.text
        });
        break;

      default:
        throw new Error(`Unknown input type: ${type}`);
    }
  } catch (error) {
    console.error('CDP input injection error:', error);
    console.error('Input type:', type);
    console.error('Input params:', JSON.stringify(params, null, 2));
    throw error;
  }
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Chrome streamer component available at: http://localhost:${PORT}/chrome-streamer-component`);
  console.log(`WebRTC signaling available at: ws://localhost:${PORT}/webrtc-signal`);
  console.log(`CDP streaming available at: ws://localhost:${PORT}/cdp-stream`);
});

