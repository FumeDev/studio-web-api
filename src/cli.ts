#!/usr/bin/env node

import { Stagehand } from "@browserbasehq/stagehand";
import StagehandConfig from "./stagehand.config";
import { ensureHeadlessConfig, logBrowserConfig } from "./browser-config";
import readline from 'readline';
import chalk from 'chalk';
import boxen from 'boxen';
import dotenv from 'dotenv';

dotenv.config();

// Check for debug mode
const DEBUG = process.env.DEBUG === 'true';

// Debug logging function
function debug(...args: any[]) {
  if (DEBUG) {
    console.log(chalk.gray('[DEBUG]'), ...args);
  }
}

// Create readline interface for CLI input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: chalk.green('browser-cli> ')
});

// Global Stagehand instance
let stagehand: Stagehand | null = null;

// Available commands
const COMMANDS = {
  GOTO: '/goto',
  ACT: '/act',
  CLICK: '/click',
  TYPE: '/type',
  HELP: '/help',
  EXIT: '/exit',
  SCREENSHOT: '/screenshot',
  WAIT: '/wait',
  EVAL: '/eval',
  INFO: '/info'
};

// Help text
const helpText = `
${chalk.bold('Available Commands:')}
  ${chalk.yellow(COMMANDS.GOTO)} ${chalk.gray('<url>')}              - Navigate to a URL
  ${chalk.yellow(COMMANDS.ACT)} ${chalk.gray('<instruction>')}       - Perform a complex action using AI
  ${chalk.yellow(COMMANDS.CLICK)} ${chalk.gray('<selector>')}        - Click on an element
  ${chalk.yellow(COMMANDS.TYPE)} ${chalk.gray('<selector> <text>')}  - Type text into an element
  ${chalk.yellow(COMMANDS.WAIT)} ${chalk.gray('<ms>')}               - Wait for specified milliseconds
  ${chalk.yellow(COMMANDS.SCREENSHOT)}                   - Take a screenshot
  ${chalk.yellow(COMMANDS.EVAL)} ${chalk.gray('<js-code>')}          - Evaluate JavaScript in the browser
  ${chalk.yellow(COMMANDS.INFO)}                         - Show current page info
  ${chalk.yellow(COMMANDS.HELP)}                         - Show this help
  ${chalk.yellow(COMMANDS.EXIT)}                         - Exit the CLI
`;

// Initialize browser
async function initBrowser() {
  try {
    console.log(chalk.blue('Initializing browser...'));
    
    // Build LLM config based on environment variables
    let llmConfig;
    if (process.env.ANTHROPIC_API_KEY) {
      llmConfig = {
        provider: 'anthropic',
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        modelName: 'claude-3-5-sonnet-20241022',
        temperature: 0.7,
        maxTokens: 4096
      };
      debug('Using Anthropic LLM config');
    } else if (process.env.OPENAI_API_KEY) {
      llmConfig = {
        provider: 'openai',
        openaiApiKey: process.env.OPENAI_API_KEY,
        modelName: 'gpt-4o',
        temperature: 0.7,
        maxTokens: 4096
      };
      debug('Using OpenAI LLM config');
    } else {
      throw new Error("Either ANTHROPIC_API_KEY or OPENAI_API_KEY must be set in environment variables");
    }

    // Build the complete config with updated browser settings
    let baseConfig = {
      ...StagehandConfig,
      headless: false,
      llm: llmConfig,
      env: "LOCAL",
      domSettleTimeoutMs: 300_000,
      logger: (message: any) => DEBUG ? console.log(message) : null,
      debugDom: DEBUG
    };

    // Ensure headless mode is properly set
    const currentConfig = ensureHeadlessConfig(baseConfig);
    
    // Log the browser configuration
    logBrowserConfig(currentConfig);
    
    debug('Full config:', JSON.stringify(currentConfig, null, 2));

    // Create a fresh Stagehand instance with the new config
    debug('Creating Stagehand instance...');
    stagehand = new Stagehand(currentConfig);
    
    // Initialize the browser
    debug('Initializing Stagehand...');
    await stagehand.init();
    
    console.log(chalk.green('Browser initialized!'));
    console.log(chalk.yellow('Type /help to see available commands'));
    
    // Navigate to a default page
    debug('Navigating to Google...');
    await stagehand.page.goto('https://www.google.com');
    console.log(chalk.green('Navigated to Google'));
    
    return true;
  } catch (error) {
    console.error(chalk.red('Failed to initialize browser:'), error);
    debug('Error details:', error);
    return false;
  }
}

// Process commands
async function processCommand(input: string) {
  if (!stagehand || !stagehand.page) {
    console.log(chalk.red('Browser not initialized. Please wait...'));
    return;
  }

  const args = input.trim().split(' ');
  const command = args[0].toLowerCase();
  
  debug(`Processing command: ${command} with args:`, args.slice(1));
  
  try {
    switch (command) {
      case COMMANDS.GOTO:
        if (args.length < 2) {
          console.log(chalk.red('Please provide a URL'));
          break;
        }
        const url = args[1];
        console.log(chalk.blue(`Navigating to ${url}...`));
        debug(`Calling page.goto with URL: ${url}`);
        await stagehand.page.goto(url);
        console.log(chalk.green(`Navigated to ${url}`));
        break;
        
      case COMMANDS.ACT:
        if (args.length < 2) {
          console.log(chalk.red('Please provide an instruction'));
          break;
        }
        const instruction = args.slice(1).join(' ');
        console.log(chalk.blue(`Performing action: ${instruction}...`));
        debug(`Calling page.act with instruction: ${instruction}`);
        await stagehand.page.act(instruction);
        console.log(chalk.green('Action completed'));
        break;
        
      case COMMANDS.CLICK:
        if (args.length < 2) {
          console.log(chalk.red('Please provide a selector'));
          break;
        }
        const selector = args.slice(1).join(' ');
        console.log(chalk.blue(`Clicking on ${selector}...`));
        debug(`Calling page.click with selector: ${selector}`);
        await stagehand.page.click(selector);
        console.log(chalk.green('Click completed'));
        break;
        
      case COMMANDS.TYPE:
        if (args.length < 3) {
          console.log(chalk.red('Please provide a selector and text'));
          break;
        }
        const typeSelector = args[1];
        const text = args.slice(2).join(' ');
        console.log(chalk.blue(`Typing "${text}" into ${typeSelector}...`));
        debug(`Calling page.fill with selector: ${typeSelector} and text: ${text}`);
        await stagehand.page.fill(typeSelector, text);
        console.log(chalk.green('Typing completed'));
        break;
        
      case COMMANDS.WAIT:
        if (args.length < 2) {
          console.log(chalk.red('Please provide a time in milliseconds'));
          break;
        }
        const ms = parseInt(args[1]);
        console.log(chalk.blue(`Waiting for ${ms}ms...`));
        await stagehand.page.waitForTimeout(ms);
        console.log(chalk.green('Wait completed'));
        break;
        
      case COMMANDS.SCREENSHOT:
        console.log(chalk.blue('Taking screenshot...'));
        const screenshotPath = `./screenshots/screenshot-${Date.now()}.png`;
        await stagehand.page.screenshot({ path: screenshotPath });
        console.log(chalk.green(`Screenshot saved to ${screenshotPath}`));
        break;
        
      case COMMANDS.EVAL:
        if (args.length < 2) {
          console.log(chalk.red('Please provide JavaScript code to evaluate'));
          break;
        }
        const jsCode = args.slice(1).join(' ');
        console.log(chalk.blue(`Evaluating JavaScript: ${jsCode}...`));
        const result = await stagehand.page.evaluate(jsCode);
        console.log(chalk.green('Evaluation result:'), result);
        break;
        
      case COMMANDS.INFO:
        const url2 = await stagehand.page.url();
        const title = await stagehand.page.title();
        console.log(boxen(
          `${chalk.bold('Current Page Info')}\n` +
          `URL: ${chalk.blue(url2)}\n` +
          `Title: ${chalk.yellow(title)}`,
          { padding: 1, borderColor: 'green' }
        ));
        break;
        
      case COMMANDS.HELP:
        console.log(helpText);
        break;
        
      case COMMANDS.EXIT:
        console.log(chalk.blue('Closing browser and exiting...'));
        if (stagehand) {
          await stagehand.close();
        }
        rl.close();
        process.exit(0);
        break;
        
      default:
        console.log(chalk.red(`Unknown command: ${command}`));
        console.log(chalk.yellow('Type /help to see available commands'));
    }
  } catch (error) {
    console.error(chalk.red('Error executing command:'), error);
    debug('Error details:', error);
  }
}

// Main function
async function main() {
  console.log(boxen(chalk.bold('Browser CLI'), { padding: 1, borderColor: 'blue' }));
  
  // Create screenshots directory if it doesn't exist
  const fs = await import('fs/promises');
  try {
    await fs.mkdir('./screenshots', { recursive: true });
  } catch (error) {
    console.error('Error creating screenshots directory:', error);
  }
  
  // Initialize browser
  const success = await initBrowser();
  if (!success) {
    console.log(chalk.red('Failed to initialize browser. Exiting...'));
    process.exit(1);
  }
  
  // Start CLI loop
  rl.prompt();
  rl.on('line', async (line) => {
    if (line.trim()) {
      await processCommand(line.trim());
    }
    rl.prompt();
  }).on('close', async () => {
    console.log(chalk.blue('Closing browser and exiting...'));
    if (stagehand) {
      await stagehand.close();
    }
    process.exit(0);
  });
}

// Start the CLI
main().catch(error => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
}); 