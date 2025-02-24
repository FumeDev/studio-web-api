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
  
  // Ensure headless mode is set to "new"
  updatedConfig.browser = updatedConfig.browser || {};
  updatedConfig.browser.headless = "new";
  
  // Ensure the args include headless=new
  updatedConfig.browser.args = updatedConfig.browser.args || [];
  if (!updatedConfig.browser.args.includes('--headless=new')) {
    updatedConfig.browser.args.push('--headless=new');
  }
  
  // Ensure environment variables are set
  updatedConfig.launchOptions = updatedConfig.launchOptions || {};
  updatedConfig.launchOptions.env = updatedConfig.launchOptions.env || {};
  updatedConfig.launchOptions.env.PUPPETEER_HEADLESS = 'new';
  
  return updatedConfig;
}

/**
 * Logs the browser configuration
 * @param config The browser configuration
 */
export function logBrowserConfig(config: any): void {
  console.log('Browser configuration:');
  console.log('- Headless mode:', config.browser?.headless);
  console.log('- Args includes headless=new:', config.browser?.args?.includes('--headless=new'));
  console.log('- PUPPETEER_HEADLESS:', config.launchOptions?.env?.PUPPETEER_HEADLESS);
} 