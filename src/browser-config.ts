/**
 * This file contains helper functions to ensure the browser is properly configured for headless mode
 */

/**
 * Ensures the browser configuration is properly set for headless mode
 * @param config The browser configuration
 * @returns The updated browser configuration
 */
export function ensureHeadlessConfig(config: any): any {
  const updatedConfig = JSON.parse(JSON.stringify(config));
  const headlessEnabled = config.headless !== false;
  updatedConfig.browser = updatedConfig.browser || {};
  updatedConfig.browser.args = updatedConfig.browser.args || [];
  updatedConfig.launchOptions = updatedConfig.launchOptions || {};
  updatedConfig.launchOptions.env = updatedConfig.launchOptions.env || {};

  if (headlessEnabled) {
    updatedConfig.browser.headless = "new";
    if (!updatedConfig.browser.args.includes("--headless=new")) {
      updatedConfig.browser.args.push("--headless=new");
    }
    updatedConfig.launchOptions.env.PUPPETEER_HEADLESS = "new";
  } else {
    updatedConfig.browser.headless = false;
    updatedConfig.browser.args = updatedConfig.browser.args.filter((arg: string) => !arg.startsWith("--headless"));
    if ("PUPPETEER_HEADLESS" in updatedConfig.launchOptions.env) {
      delete updatedConfig.launchOptions.env.PUPPETEER_HEADLESS;
    }
  }

  return updatedConfig;
}

/**
 * Logs the browser configuration
 * @param config The browser configuration
 */
export function logBrowserConfig(config: any): void {
  console.log('Browser configuration:');
  console.log('- Running under PM2:', process.env.PM2_HOME !== undefined);
  console.log('- Headless mode:', config.browser?.headless);
  console.log('- Args includes headless=new:', config.browser?.args?.includes('--headless=new'));
  console.log('- PUPPETEER_HEADLESS:', config.launchOptions?.env?.PUPPETEER_HEADLESS);
} 