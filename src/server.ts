import express, { Request, Response, NextFunction } from "express";
import { Stagehand } from "@browserbasehq/stagehand";
import StagehandConfig from "./stagehand.config";
import { ensureHeadlessConfig, logBrowserConfig } from "./browser-config";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import dotenv from "dotenv";
import Docker from 'dockerode';

dotenv.config();

const execAsync = promisify(exec);

const app = express();
app.use(express.json());

// We keep a single global Stagehand reference and a config
let stagehand: Stagehand | null = null;
let currentConfig: any = null; // Holds dynamic runtime config (browser + LLM)

// ---- Error Handling Middleware ----
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("Error:", err);
  res.status(500).json({
    success: false,
    error: err.message,
    details: err.stack,
  });
});

// ---- 1. Start Browser Endpoint ----
app.post("/start_browser", async (req: Request, res: Response) => {
  try {
    // If browser is already running, check if it's still responsive
    if (stagehand?.page) {
      try {
        // Test if the browser is still responsive by evaluating a simple expression
        await stagehand.page.evaluate(() => true);
        // If we got here, the browser is still responsive
        return res.json({
          success: true,
          message: "Using existing browser session",
        });
      } catch (error) {
        console.log("Existing browser session is no longer responsive, starting a new one");
        // Clean up the stale reference
        stagehand = null;
        currentConfig = null;
      }
    }

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

    // Build the complete config with updated browser settings
    let baseConfig = {
      ...StagehandConfig, // Use all base config
      headless: false, // Set headless mode directly
      llm: llmConfig, // Add LLM config properly
      env: "LOCAL",
      domSettleTimeoutMs: 300_000,
      logger: (message: any) => console.log(message),
      debugDom: false,
    };

    // Ensure headless mode is properly set
    currentConfig = ensureHeadlessConfig(baseConfig);

    // Log the browser configuration
    logBrowserConfig(currentConfig);

    console.log("Creating Stagehand with config:", {
      ...currentConfig,
      modelClientOptions: {
        apiKey: "***", // Hide the API key
      },
    });

    // Create a fresh Stagehand instance with the new config
    console.log("Creating new Stagehand instance...");

    // Try multiple times to initialize the browser, with a delay between attempts
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        console.log(`Browser launch attempt ${attempt + 1}/${maxRetries}`);
        stagehand = new Stagehand(currentConfig);

        // Initialize (launch browser, etc.)
        await stagehand.init();
        console.log("Stagehand initialized successfully");

        // Navigate to Google
        console.log("Navigating to Google...");
        await stagehand.page.goto("https://www.google.com");
        console.log("Navigation to Google complete");

        return res.json({
          success: true,
          message: `Browser started successfully on attempt ${
            attempt + 1
          } and navigated to Google`,
        });
      } catch (error) {
        lastError = error;
        console.error(`Attempt ${attempt + 1} failed:`, error);

        // Clean up failed instance
        if (stagehand) {
          try {
            await stagehand.close();
          } catch (closeError) {
            console.error("Error closing stagehand:", closeError);
          }
          stagehand = null;
        }

        // Wait before retrying
        if (attempt < maxRetries - 1) {
          console.log(`Waiting 5 seconds before retry ${attempt + 2}...`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }

    // If we get here, all attempts failed
    throw (
      lastError ||
      new Error("Failed to initialize browser after multiple attempts")
    );
  } catch (error: unknown) {
    console.error("Error starting browser:", error);
    stagehand = null; // Reset on failure
    currentConfig = null;
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 2. "Goto" Endpoint ----
app.post("/goto", async (req: Request, res: Response) => {
  try {
    // Must have an initialized Stagehand
    if (!stagehand?.page) {
      throw new Error("Browser not started");
    }

    const { url } = req.body;
    if (!url) {
      throw new Error("URL is required");
    }

    console.log("Navigating to:", url);
    await stagehand.page.goto(url);
    console.log("Navigation complete");

    return res.json({
      success: true,
      message: `Successfully navigated to ${url}`,
    });
  } catch (error: unknown) {
    console.error("Error in goto endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 3. Screenshot Endpoint ----
app.get("/screenshot", async (req: Request, res: Response) => {
  try {
    if (!stagehand?.page) {
      throw new Error("Browser not started");
    }

    // Get current URL and title
    const currentUrl = stagehand.page.url();
    const currentTitle = await stagehand.page.title();

    // Capture only the current viewport
    const screenshotBuffer = await stagehand.page.screenshot({
      fullPage: false,
      scale: "css",
      animations: "disabled",
      caret: "hide",
      timeout: 30000,
    });

    // Convert buffer to base64 string
    const base64Image = screenshotBuffer.toString("base64");

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
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
});

// ---- 4. "Act" Endpoint ----
app.post("/act", async (req: Request, res: Response) => {
  try {
    // Must have a valid browser session
    if (!stagehand?.page) {
      throw new Error("Browser not started");
    }
    // Must have a valid LLM config
    if (
      !currentConfig?.llm?.anthropicApiKey &&
      !currentConfig?.llm?.openaiApiKey
    ) {
      throw new Error(
        "LLM configuration not set. Please start the browser first with an API key."
      );
    }

    const { action, url } = req.body;
    if (!action) {
      throw new Error("Action description is required");
    }

    // If a URL is provided, navigate first
    if (url) {
      console.log("Navigating to:", url);
      await stagehand.page.goto(url);
      console.log("Navigation complete");
    }

    console.log("Attempting action:", action);
    // Stagehand .act(...) call
    await stagehand.page.act(action);

    return res.json({ success: true, message: "Action executed successfully" });
  } catch (error: unknown) {
    console.error("Error in act endpoint:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
      // We log some debug info about currentConfig
      config: {
        modelName: currentConfig?.llm?.modelName,
        provider: currentConfig?.llm?.provider,
        // Are we sure we have a key?
        anthropicApiKeySet: !!currentConfig?.llm?.anthropicApiKey,
        openaiApiKeySet: !!currentConfig?.llm?.openaiApiKey,
      },
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

// ---- Server Listen ----
const PORT = process.env.PORT || 5553;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
