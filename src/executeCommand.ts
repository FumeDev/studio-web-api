import { spawn, SpawnOptions, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

/**
 * Interface for command execution result
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sendInput: (input: string) => void;
  workingDirectory: string;
}

/**
 * Extended Promise type with sendInput method
 */
export interface CommandPromise extends Promise<CommandResult> {
  sendInput: (input: string) => void;
}

/**
 * Process manager for tracking interactive processes
 */
export class ProcessManager {
  private static instance: ProcessManager;
  private processes: Map<string, { 
    session: ShellSession, 
    command: string, 
    args: string[], 
    promise: CommandPromise, 
    isActive: boolean,
    output: string,
    lastOutput: string,
    createdAt: Date,
    lastActivity: Date
  }>;

  private constructor() {
    this.processes = new Map();
  }

  public static getInstance(): ProcessManager {
    if (!ProcessManager.instance) {
      ProcessManager.instance = new ProcessManager();
    }
    return ProcessManager.instance;
  }

  /**
   * Start a new process or return an existing one
   */
  public startProcess(id: string, command: string, args: string[] = [], options: SpawnOptions = {}): CommandPromise {
    try {
      // Check if process exists and is active
      if (this.processes.has(id) && this.processes.get(id)!.isActive) {
        return this.processes.get(id)!.promise;
      }

      // If process exists but is not active, reuse the session to maintain state
      let session: ShellSession;
      if (this.processes.has(id)) {
        const existingProcess = this.processes.get(id)!;
        session = existingProcess.session;
        console.log(`Reusing session for process ${id} with working directory: ${session.getWorkingDirectory()}`);
      } else {
        // Create a new shell session for this process
        session = new ShellSession(options.cwd as string, options.env as NodeJS.ProcessEnv);
      }
      
      // If command is provided without args, it might be a full command string
      // We'll execute it through a shell for proper parsing
      let finalCommand: string;
      let finalArgs: string[];
      
      if (command && (!args || args.length === 0)) {
        // Treat the command as a full command line and execute through bash
        finalCommand = 'bash';
        finalArgs = ['-c', command];
      } else {
        // Use the command and args as provided
        finalCommand = command;
        finalArgs = args;
      }
      
      console.log(`[Process ${id}] Executing: ${finalCommand} ${finalArgs.join(' ')}`);
      
      // Execute the command
      const promise = session.executeCommand(finalCommand, finalArgs, options);
      
      // Track output
      let output = '';
      let lastOutput = '';
      
      // Create a process entry now to allow capturing output immediately
      const processEntry = {
        session,
        command: finalCommand,
        args: finalArgs,
        promise,
        isActive: true,
        output,
        lastOutput,
        createdAt: new Date(),
        lastActivity: new Date()
      };
      
      this.processes.set(id, processEntry);
      
      // Setup output capture
      promise.then(
        (result) => {
          // Update with final output when the process completes
          if (this.processes.has(id)) {
            const process = this.processes.get(id)!;
            process.isActive = false;
            process.lastActivity = new Date();
            process.output = result.stdout;
            process.lastOutput = result.stdout;
            console.log(`[Process ${id}] Completed successfully`);
          }
        },
        (error) => {
          // Update status on error
          if (this.processes.has(id)) {
            const process = this.processes.get(id)!;
            process.isActive = false;
            process.lastActivity = new Date();
            console.error(`[Process ${id}] Failed with error:`, error);
          }
        }
      );
      
      // Set up real-time output capture using the event emitter
      if ((promise as any).events) {
        console.log(`[Process ${id}] Setting up real-time output capture`);
        (promise as any).events.on('output', (output: string, isError: boolean) => {
          // Update our process record with the latest output in real-time
          if (this.processes.has(id)) {
            const process = this.processes.get(id)!;
            process.output += output;
            process.lastOutput = output;
            process.lastActivity = new Date();
            
            // Log for debugging, but only if not empty
            if (output.trim()) {
              console.log(`[Process ${id}] ${isError ? 'STDERR' : 'STDOUT'}: ${output.trim().substring(0, 100)}${output.length > 100 ? '...' : ''}`);
            }
          }
        });
      } else {
        console.warn(`[Process ${id}] No event emitter found for real-time output tracking`);
      }
      
      return promise;
    } catch (error) {
      console.error(`[Process ${id}] Error starting process:`, error);
      // Create a failed promise that rejects with the error
      const failedPromise = Promise.reject(error) as CommandPromise;
      failedPromise.sendInput = () => {}; // Empty function
      return failedPromise;
    }
  }

  /**
   * Send input to an existing process
   */
  public sendInput(id: string, input: string): boolean {
    if (!this.processes.has(id)) {
      return false;
    }

    const process = this.processes.get(id)!;
    
    if (!process.isActive) {
      return false;
    }

    process.promise.sendInput(input);
    process.lastActivity = new Date();
    
    // Append the input to both output tracking variables
    process.output += `${input}\n`;
    process.lastOutput = `${input}\n`; // Echo input to lastOutput for immediate feedback
    
    return true;
  }

  /**
   * Get the current status of a process
   */
  public getProcessStatus(id: string): {
    exists: boolean;
    isActive: boolean;
    command: string;
    args: string[];
    output: string;
    lastOutput: string;
    createdAt: Date;
    lastActivity: Date;
    workingDirectory: string;
  } | null {
    if (!this.processes.has(id)) {
      return null;
    }

    const process = this.processes.get(id)!;
    
    // Set a maximum size for output to prevent memory issues
    const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB max output size
    
    // Trim output if it gets too large, keeping the most recent output
    if (process.output.length > MAX_OUTPUT_SIZE) {
      process.output = process.output.slice(-MAX_OUTPUT_SIZE);
      // Add indicator at the beginning that output was truncated
      process.output = "[...output truncated...]\n" + process.output;
    }
    
    return {
      exists: true,
      isActive: process.isActive,
      command: process.command,
      args: process.args,
      output: process.output,
      lastOutput: process.lastOutput,
      createdAt: process.createdAt,
      lastActivity: process.lastActivity,
      workingDirectory: process.session.getWorkingDirectory()
    };
  }

  /**
   * List all process IDs
   */
  public listProcessIds(): string[] {
    return Array.from(this.processes.keys());
  }

  /**
   * Clean up inactive processes older than the specified minutes
   */
  public cleanupInactiveProcesses(olderThanMinutes: number = 60): number {
    const now = new Date();
    let cleanedCount = 0;

    for (const [id, process] of this.processes.entries()) {
      if (!process.isActive) {
        const minutesSinceLastActivity = (now.getTime() - process.lastActivity.getTime()) / (1000 * 60);
        if (minutesSinceLastActivity > olderThanMinutes) {
          this.processes.delete(id);
          cleanedCount++;
        }
      }
    }

    return cleanedCount;
  }
}

/**
 * Represents a persistent shell session
 */
export class ShellSession {
  private currentWorkingDir: string;
  private env: NodeJS.ProcessEnv;

  constructor(initialWorkingDir?: string, initialEnv?: NodeJS.ProcessEnv) {
    this.currentWorkingDir = initialWorkingDir || process.cwd();
    this.env = initialEnv ? { ...process.env, ...initialEnv } : { ...process.env };
  }

  /**
   * Execute a command in the current session
   */
  executeCommand(command: string, args: string[] = [], options: SpawnOptions = {}): CommandPromise {
    // Merge the session's working directory and environment with the provided options
    const sessionOptions: SpawnOptions = {
      ...options,
      cwd: this.currentWorkingDir,
      env: { ...this.env, ...(options.env || {}) }
    };

    // Execute the command
    const result = executeCommand(command, args, sessionOptions);
    
    // Update session state after command completes
    result.then(commandResult => {
      // Check if the command was a cd command
      if (command === 'cd' && args.length > 0) {
        this.handleCdCommand(args[0]);
      } else if ((command === 'bash' || command === 'sh') && args.includes('-c')) {
        // Look for cd commands in shell scripts
        const shellCommand = args[args.indexOf('-c') + 1] || '';
        this.extractAndHandleCdCommands(shellCommand);
      }
      
      // If any environment variables were set, update the session's environment
      if (options.env) {
        this.env = { ...this.env, ...options.env };
      }
      
      // Store the current working directory in the result
      commandResult.workingDirectory = this.currentWorkingDir;
    });
    
    return result;
  }

  /**
   * Extract and handle cd commands from a shell command string
   */
  private extractAndHandleCdCommands(commandString: string): void {
    // Look for cd commands with various delimiters
    const cdCommands: string[] = [];
    
    // Handle simple 'cd dir' command
    const singleCdRegex = /cd\s+([^;&|<>]+)/g;
    let match;
    
    while ((match = singleCdRegex.exec(commandString)) !== null) {
      if (match[1] && match[1].trim()) {
        cdCommands.push(match[1].trim());
      }
    }
    
    // If multiple cd commands exist, apply only the last one
    if (cdCommands.length > 0) {
      const lastCdDir = cdCommands[cdCommands.length - 1];
      this.handleCdCommand(lastCdDir);
    }
  }

  /**
   * Handle cd commands to update the session's working directory
   */
  private handleCdCommand(directory: string): void {
    // Clean up quotes if present
    const cleanDir = directory.replace(/^['"]|['"]$/g, '');
    
    // Handle special paths
    if (cleanDir === '~') {
      this.currentWorkingDir = os.homedir();
      return;
    }
    
    if (cleanDir === '-') {
      // cd - is not fully supported in this environment, treat as no-op
      console.log("Note: 'cd -' is not fully supported in this environment");
      return;
    }
    
    // Handle relative/absolute paths
    if (path.isAbsolute(cleanDir)) {
      this.currentWorkingDir = cleanDir;
    } else if (cleanDir === '..') {
      this.currentWorkingDir = path.dirname(this.currentWorkingDir);
    } else {
      this.currentWorkingDir = path.join(this.currentWorkingDir, cleanDir);
    }
    
    // Log directory change for debugging
    console.log(`Changed working directory to: ${this.currentWorkingDir}`);
  }

  /**
   * Get the current working directory
   */
  getWorkingDirectory(): string {
    return this.currentWorkingDir;
  }

  /**
   * Get the current environment variables
   */
  getEnvironment(): NodeJS.ProcessEnv {
    return { ...this.env };
  }

  /**
   * Set environment variables for the session
   */
  setEnvironmentVariables(env: NodeJS.ProcessEnv): void {
    this.env = { ...this.env, ...env };
  }
}

/**
 * Executes a Unix command with interactive I/O handling
 * @param command - The command to execute
 * @param args - Command arguments as an array
 * @param options - Spawn options (e.g., cwd, env)
 * @returns Promise resolving to command result with stdout, stderr, exit code, and input function
 */
export function executeCommand(command: string, args: string[] = [], options: SpawnOptions = {}): CommandPromise {
  let sendInputFunction: (input: string) => void;
  
  // Create event emitter for real-time output updates
  const eventEmitter = new EventEmitter();
  
  // Buffer for collecting real-time output
  let outputBuffer = '';
  let errorBuffer = '';
  
  // Function to process real-time output
  const processOutput = (data: Buffer, isError: boolean): string => {
    const output = data.toString();
    if (isError) {
      errorBuffer += output;
      console.error(output); // Log errors in real-time
    } else {
      outputBuffer += output;
      console.log(output); // Log output in real-time
    }
    
    try {
      // Emit an output event that ProcessManager can listen to
      eventEmitter.emit('output', output, isError);
    } catch (error) {
      console.error('Error emitting output event:', error);
    }
    
    return output;
  };
  
  const promise = new Promise<CommandResult>((resolve, reject) => {
    try {
      let effectiveCommand = command;
      let effectiveArgs = [...args]; // Clone the args array
      
      // If command contains shell special characters and no args were provided
      // We'll execute it through bash for proper parsing
      if (effectiveCommand && (!effectiveArgs || effectiveArgs.length === 0) && 
          (effectiveCommand.includes(' ') || effectiveCommand.includes(';') || 
           effectiveCommand.includes('|') || effectiveCommand.includes('>') || 
           effectiveCommand.includes('<') || effectiveCommand.includes('{') || 
           effectiveCommand.includes('}'))) {
        console.log('Detected shell command, executing through bash:', effectiveCommand);
        
        // Important: Don't modify the original command string
        const originalCommand = effectiveCommand;
        effectiveCommand = 'bash';
        
        // Properly quote the command to preserve syntax for bash
        effectiveArgs = ['-c', originalCommand];
        
        console.log(`Executing as: ${effectiveCommand} ${effectiveArgs.join(' ')}`);
      }
      
      // Spawn the process
      const process: ChildProcess = spawn(effectiveCommand, effectiveArgs, {
        ...options,
        stdio: 'pipe', // Enable piping for all streams
        shell: false,  // We're handling shell execution manually with bash -c
      });
      
      let stdout = '';
      let stderr = '';
      
      // Ensure process.stdout and process.stderr exist
      if (!process.stdout || !process.stderr || !process.stdin) {
        reject(new Error('Process streams not available'));
        return;
      }
      
      // Handle stdout data
      process.stdout.on('data', (data: Buffer) => {
        const output = processOutput(data, false);
        stdout += output;
      });
      
      // Handle stderr data
      process.stderr.on('data', (data: Buffer) => {
        const error = processOutput(data, true);
        stderr += error;
      });
      
      // Send input to the process
      sendInputFunction = (input: string): void => {
        if (process.stdin && !process.stdin.destroyed) {
          console.log(`Sending input to process: ${input}`);
          process.stdin.write(input + '\n');
          // Echo the input to the output for better UX
          stdout += `${input}\n`;
          outputBuffer += `${input}\n`;
          
          try {
            // Emit an output event for the input (helps with tracking)
            eventEmitter.emit('output', `${input}\n`, false);
          } catch (error) {
            console.error('Error emitting input event:', error);
          }
        } else {
          console.warn('Cannot send input: stdin is not available or is destroyed');
        }
      };
      
      // Handle process completion
      process.on('close', (exitCode: number | null) => {
        console.log(`Process completed with exit code: ${exitCode}, stdout length: ${stdout.length}`);
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? -1, // Default to -1 if null
          sendInput: sendInputFunction,
          // Use options.cwd from spawn options or the Node.js process current directory
          workingDirectory: typeof options.cwd === 'string' ? options.cwd : 
                           (global.process.cwd ? global.process.cwd() : '/')
        });
      });
      
      // Handle errors
      process.on('error', (error: Error) => {
        console.error('Process error:', error);
        reject(error);
      });
    } catch (error) {
      console.error('Fatal error in executeCommand:', error);
      reject(error);
    }
  });
  
  // Add sendInput method to the promise
  const promiseWithSendInput = promise as CommandPromise;
  promiseWithSendInput.sendInput = (input: string) => {
    if (sendInputFunction) {
      sendInputFunction(input);
    }
  };
  
  // Add the event emitter to the promise for real-time output tracking
  try {
    Object.defineProperty(promiseWithSendInput, 'events', {
      value: eventEmitter,
      writable: false,
      enumerable: false
    });
  } catch (error) {
    console.error('Error attaching event emitter to promise:', error);
  }
  
  return promiseWithSendInput;
}

/**
 * Example: Running an interactive command
 */
export async function runInteractiveCommand(): Promise<CommandResult | undefined> {
  try {
    // Start an interactive process
    const cmdPromise = executeCommand('bash', ['-c', 'read -p "Enter your name: " name && echo "Hello, $name!"']);
    
    // The process is now running and will wait for input
    
    // Simulate waiting for 1 second before sending input
    setTimeout(() => {
      cmdPromise.sendInput('John Doe'); // Send input to the process
    }, 1000);
    
    // Wait for process to complete
    const result = await cmdPromise;
    console.log('Process complete with exit code:', result.exitCode);
    console.log('Full output:', result.stdout);
    
    return result;
  } catch (error) {
    console.error('Error executing command:', error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * Example: Running a non-interactive command
 */
export async function runSimpleCommand(): Promise<CommandResult | undefined> {
  try {
    const result = await executeCommand('ls', ['-la']);
    console.log('Exit code:', result.exitCode);
    return result;
  } catch (error) {
    console.error('Error executing command:', error instanceof Error ? error.message : String(error));
    return undefined;
  }
}