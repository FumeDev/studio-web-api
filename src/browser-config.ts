/**
 * This file contains helper functions to ensure the browser is properly configured for headless mode
 */

/**
 * Ensures the browser configuration is properly set for headless mode
 * @param config The browser configuration
 * @returns The updated browser configuration
 */
export function ensureHeadlessConfig(config: any): any {
  // Make a deep copy of the config
  const updatedConfig = JSON.parse(JSON.stringify(config));
  
  // Check if running under PM2
  const isRunningUnderPM2 = true;
  
  // If running under PM2, force headless mode
  if (isRunningUnderPM2) {
    console.log('Running under PM2, forcing headless mode');
    updatedConfig.browser = updatedConfig.browser || {};
    updatedConfig.browser.headless = "new";
    updatedConfig.browser.args = updatedConfig.browser.args || [];
    if (!updatedConfig.browser.args.includes('--headless=new')) {
      updatedConfig.browser.args.push('--headless=new');
    }
    updatedConfig.launchOptions = updatedConfig.launchOptions || {};
    updatedConfig.launchOptions.env = updatedConfig.launchOptions.env || {};
    updatedConfig.launchOptions.env.PUPPETEER_HEADLESS = 'new';
  } else {
    // Not running under PM2, use the configured headless setting
    updatedConfig.browser = updatedConfig.browser || {};
    updatedConfig.browser.headless = config.headless === false ? false : "new";
    updatedConfig.browser.args = updatedConfig.browser.args || [];
    if (config.headless !== false && !updatedConfig.browser.args.includes('--headless=new')) {
      updatedConfig.browser.args.push('--headless=new');
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