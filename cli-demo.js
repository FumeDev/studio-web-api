#!/usr/bin/env node

import { program } from 'commander';
import axios from 'axios';
import readline from 'readline';
import chalk from 'chalk';
import { v4 as uuidv4 } from 'uuid';

const API_URL = 'http://localhost:5553/execute-command';
const LIST_URL = 'http://localhost:5553/list-processes';

// Create a readline interface for interactive input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function for prompting with a question
function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// Execute a command and receive output
async function executeCommand(processId, command, args = [], options = {}) {
  try {
    console.log(chalk.dim(`Executing command: ${command} ${args.join(' ')}`));
    const response = await axios.post(API_URL, {
      process_id: processId,
      command,
      args,
      options
    });
    
    // Add some validation for the response
    if (!response.data) {
      throw new Error('Server returned empty response');
    }
    
    return response.data;
  } catch (error) {
    // Check if it's an Axios error with a response
    if (error.response) {
      console.error(chalk.red('Server error:'), error.response.status, error.response.statusText);
      console.error(chalk.dim('Response data:'), JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      // The request was made but no response was received
      console.error(chalk.red('Network error - no response received from server. Is the server running?'));
    } else {
      // Something happened in setting up the request
      console.error(chalk.red('Error executing command:'), error.message);
    }
    throw error;
  }
}

// Send input to an existing process
async function sendInput(processId, input) {
  try {
    console.log(chalk.dim(`Sending input to process ${processId}`));
    const response = await axios.post(API_URL, {
      process_id: processId,
      input
    });
    
    // Add some validation for the response
    if (!response.data) {
      throw new Error('Server returned empty response');
    }
    
    return response.data;
  } catch (error) {
    // Check if it's an Axios error with a response
    if (error.response) {
      console.error(chalk.red('Server error:'), error.response.status, error.response.statusText);
      console.error(chalk.dim('Response data:'), JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      // The request was made but no response was received
      console.error(chalk.red('Network error - no response received from server. Is the server running?'));
    } else {
      // Something happened in setting up the request
      console.error(chalk.red('Error sending input:'), error.message);
    }
    throw error;
  }
}

// List all processes
async function listProcesses() {
  try {
    const response = await axios.get(LIST_URL);
    return response.data;
  } catch (error) {
    console.error(chalk.red('Error listing processes:'), error.response?.data || error.message);
    throw error;
  }
}

// Interactive shell session
async function interactiveShell() {
  const sessionId = uuidv4();
  console.log(chalk.green(`Starting interactive shell session (ID: ${sessionId})`));
  console.log(chalk.yellow('Type "exit" to quit the session'));
  
  try {
    let currentDir = '/'; // Will be updated with the first command
    
    // First command to get the initial working directory
    try {
      console.log('Initializing shell environment...');
      const pwdResult = await executeCommand(sessionId, 'pwd');
      if (pwdResult.success && pwdResult.output) {
        currentDir = pwdResult.output.trim();
        console.log(`Current directory set to: ${currentDir}`);
      } else {
        console.log('Using default directory path');
      }
    } catch (initError) {
      console.error(chalk.red('Could not initialize working directory:'), initError.message);
      console.log('Using default directory path');
    }
    
    let running = true;
    while (running) {
      try {
        // Prompt with current directory
        const input = await ask(chalk.blue(`${currentDir} $ `));
        
        if (!input.trim()) {
          continue; // Skip empty input
        }
        
        if (input.trim().toLowerCase() === 'exit') {
          running = false;
          console.log(chalk.green('Exiting shell session'));
          continue;
        }
        
        // We'll execute all commands through bash with the -c option
        const actualCommand = 'bash';
        const bashArgs = ['-c', input.trim()];
        
        // Execute the command
        const result = await executeCommand(sessionId, actualCommand, bashArgs);
        
        if (result.success) {
          // Display the output
          if (result.output) {
            console.log(result.output.trim());
          }
          
          // Update the current directory if available
          if (result.working_directory) {
            currentDir = result.working_directory;
          }
        } else {
          console.error(chalk.red(`Command failed: ${result.error || 'Unknown error'}`));
        }
      } catch (cmdError) {
        console.error(chalk.red('Command error:'), cmdError.message);
      }
    }
  } catch (error) {
    console.error(chalk.red('Session error:'), error.message);
  } finally {
    rl.close();
  }
}

// Run a single command
async function runCommand(command, args) {
  const processId = uuidv4();
  try {
    console.log(chalk.blue(`Executing: ${command} ${args.join(' ')}`));
    
    const result = await executeCommand(processId, command, args);
    
    if (result.success) {
      console.log(chalk.green('Command output:'));
      console.log(result.output);
      console.log(chalk.green(`Exit code: ${result.exit_code}`));
    } else {
      console.error(chalk.red(`Command failed: ${result.error || 'Unknown error'}`));
    }
  } catch (error) {
    console.error(chalk.red('Error:'), error.message);
  } finally {
    rl.close();
  }
}

// Interactive input to a command
async function interactiveCommand(command, args) {
  const processId = uuidv4();
  try {
    console.log(chalk.blue(`Starting interactive command: ${command} ${args.join(' ')}`));
    console.log(chalk.yellow('Type "exit" to quit'));
    
    // Start the command
    const initialResult = await executeCommand(processId, command, args);
    
    if (!initialResult.success) {
      console.error(chalk.red(`Command failed to start: ${initialResult.error || 'Unknown error'}`));
      return;
    }
    
    // Show initial output if any
    if (initialResult.output) {
      console.log(initialResult.output);
    }
    
    // If the command has already completed, no need for interaction
    if (initialResult.status === 'completed') {
      console.log(chalk.green(`Command completed with exit code: ${initialResult.exit_code}`));
      return;
    }
    
    // Enter the interactive loop
    let running = true;
    while (running) {
      const input = await ask('> ');
      
      if (input.trim().toLowerCase() === 'exit') {
        running = false;
        console.log(chalk.green('Exiting interactive mode'));
        continue;
      }
      
      // Send input to the command
      const result = await sendInput(processId, input);
      
      if (result.success) {
        // Display the output
        if (result.output) {
          console.log(result.output);
        }
        
        // Check if the command has completed
        if (result.status === 'completed') {
          console.log(chalk.green('Command completed'));
          running = false;
        }
      } else {
        console.error(chalk.red(`Error: ${result.error || 'Unknown error'}`));
        running = false;
      }
    }
  } catch (error) {
    console.error(chalk.red('Error:'), error.message);
  } finally {
    rl.close();
  }
}

// List running processes
async function showProcesses() {
  try {
    const result = await listProcesses();
    
    if (result.success) {
      console.log(chalk.green(`Total processes: ${result.count}`));
      
      if (result.processes.length === 0) {
        console.log(chalk.yellow('No active processes found'));
      } else {
        // Display process table
        console.log('\nProcess ID                             Command        Status     Working Directory');
        console.log('------------------------------------------------------------------------------');
        
        result.processes.forEach(process => {
          console.log(
            `${process.process_id.padEnd(36)} ${(process.command || '').padEnd(14)} ${
              (process.status === 'running' ? chalk.green(process.status) : process.status).padEnd(10)
            } ${process.working_directory || ''}`
          );
        });
      }
    } else {
      console.error(chalk.red(`Failed to list processes: ${result.error || 'Unknown error'}`));
    }
  } catch (error) {
    console.error(chalk.red('Error:'), error.message);
  } finally {
    rl.close();
  }
}

// Setup Commander CLI
program
  .name('cli-demo')
  .description('Demo CLI for interacting with the command execution API')
  .version('1.0.0');

program
  .command('shell')
  .description('Start an interactive shell session')
  .action(interactiveShell);

program
  .command('run <command> [args...]')
  .description('Run a single command')
  .action(runCommand);

program
  .command('interactive <command> [args...]')
  .description('Run an interactive command')
  .action(interactiveCommand);

program
  .command('list')
  .description('List all processes')
  .action(showProcesses);

// Parse command line arguments
program.parse(process.argv);

// If no args, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
} 