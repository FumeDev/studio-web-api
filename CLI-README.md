# Browser CLI Tool

A command-line interface for controlling a browser using slash commands with Stagehand.

## Prerequisites

- Node.js (v16 or higher)
- An API key for either OpenAI or Anthropic (set in `.env` file)

## Setup

1. Make sure you have the required environment variables set in your `.env` file:
   ```
   OPENAI_API_KEY=your_openai_api_key
   # OR
   ANTHROPIC_API_KEY=your_anthropic_api_key
   ```

2. Install dependencies:
   ```
   npm install
   ```

## Running the CLI

```
npm run cli
```

For debugging mode with more verbose output:
```
./run-cli.sh
```
or
```
DEBUG=true npm run cli
```

This will start a browser and open a CLI interface where you can enter commands.

## Available Commands

- `/goto <url>` - Navigate to a URL
- `/act <instruction>` - Perform a complex action using AI
- `/click <selector>` - Click on an element
- `/type <selector> <text>` - Type text into an element
- `/wait <ms>` - Wait for specified milliseconds
- `/screenshot` - Take a screenshot
- `/eval <js-code>` - Evaluate JavaScript in the browser
- `/info` - Show current page info
- `/help` - Show available commands
- `/exit` - Exit the CLI

## Examples

```
/goto https://www.google.com
/type input[name="q"] hello world
/click input[name="btnK"]
/act search for the weather in New York
/screenshot
/info
/exit
```

## Screenshots

Screenshots are saved to the `./screenshots` directory with timestamps in the filename.

## Troubleshooting

If you encounter issues:

1. Make sure your API keys are correctly set in the `.env` file
2. Check that you have the latest version of the dependencies
3. Try running with `DEBUG=true npm run cli` for more verbose output
4. Common errors:
   - `TypeError: stagehand.goto is not a function` - This means you're trying to use a method directly on the Stagehand instance that should be used on the page object. The correct usage is `stagehand.page.goto()`.
   - `Error: Browser not initialized` - Make sure the browser has been properly initialized before running commands.

## How It Works

This CLI tool uses the Stagehand library, which is built on top of Playwright. It provides a high-level API for browser automation with AI capabilities. The key components are:

1. **Stagehand Instance**: The main entry point for browser automation
2. **Page Object**: Used for most browser interactions like navigation, clicking, typing, etc.
3. **AI Actions**: The `/act` command uses AI to interpret and execute complex instructions

## License

MIT 