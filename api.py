import os
import platform

# Add this near the top of the file, after the imports but before any other code
if not os.getenv('DISPLAY'):
    os.environ['DISPLAY'] = ':1'

from functools import wraps
import json
from flask import Flask, Response, request, jsonify
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.keys import Keys
from selenium.common.exceptions import TimeoutException, NoSuchElementException, WebDriverException, ElementNotInteractableException, NoAlertPresentException
import re
import time
import subprocess
import requests
import traceback

from bs4 import BeautifulSoup
import psutil
import requests
import pyautogui


# Add these global variables after the imports
BUNNY_API_KEY = os.getenv('BUNNY_API_KEY')
BUNNY_STORAGE_ZONE = os.getenv('BUNNY_STORAGE_ZONE')
BUNNY_STORAGE_URL = f'https://{os.getenv("BUNNY_REGION")}.storage.bunnycdn.com'
RECORDING_PROCESS = None
RECORDING_START_TIME = None

def get_console_logging_script():
    return """
        // Only initialize if not already initialized
        if (!window._consoleLogs) {
            // Initialize our log storage
            window._consoleLogs = [];
            
            // Store original console methods
            const originalConsole = {
                log: console.log,
                info: console.info,
                warn: console.warn,
                error: console.error,
                debug: console.debug
            };

            // Function to capture stack trace
            function getStackTrace() {
                try {
                    throw new Error();
                } catch (e) {
                    return e.stack.split('\\n').slice(2).join('\\n');
                }
            }

            // Override console methods before anything else runs
            ['log', 'info', 'warn', 'error', 'debug'].forEach(function(method) {
                console[method] = function(...args) {
                    // Format the message
                    const message = args.map(arg => {
                        if (arg === null) return 'null';
                        if (arg === undefined) return 'undefined';
                        if (typeof arg === 'object') {
                            try {
                                return JSON.stringify(arg);
                            } catch (e) {
                                return String(arg);
                            }
                        }
                        return String(arg);
                    }).join(' ');
                    
                    // Get stack trace for more context
                    const stack = getStackTrace();
                    
                    // Store the log with additional context
                    window._consoleLogs.push({
                        level: method,
                        message: message,
                        timestamp: new Date().toISOString(),
                        url: window.location.href,
                        stack: stack
                    });
                    
                    // Limit log size to 1000 entries
                    if (window._consoleLogs.length > 1000) {
                        window._consoleLogs = window._consoleLogs.slice(-1000);
                    }
                    
                    // Call original console method
                    originalConsole[method].apply(console, args);
                };
            });

            // Capture uncaught errors
            window.addEventListener('error', function(event) {
                window._consoleLogs.push({
                    level: 'error',
                    message: `${event.message} (in ${event.filename}:${event.lineno}:${event.colno})`,
                    timestamp: new Date().toISOString(),
                    url: event.filename,
                    line: event.lineno,
                    column: event.colno,
                    error: event.error ? event.error.stack : null
                });
            }, true);  // Use capturing to get errors before they're handled

            // Capture unhandled promise rejections
            window.addEventListener('unhandledrejection', function(event) {
                window._consoleLogs.push({
                    level: 'error',
                    message: 'Unhandled Promise Rejection: ' + (event.reason.stack || event.reason),
                    timestamp: new Date().toISOString(),
                    url: window.location.href,
                    error: event.reason.stack
                });
            }, true);  // Use capturing

            // Inject into any iframes that get created
            const observeIframes = new MutationObserver(function(mutations) {
                mutations.forEach(function(mutation) {
                    mutation.addedNodes.forEach(function(node) {
                        if (node.tagName === 'IFRAME') {
                            try {
                                node.addEventListener('load', function() {
                                    try {
                                        node.contentWindow.eval(`(${arguments.callee.toString()})()`);
                                    } catch (e) {
                                        console.error('Failed to inject logging into iframe:', e);
                                    }
                                });
                            } catch (e) {
                                console.error('Failed to add iframe listener:', e);
                            }
                        }
                    });
                });
            });

            observeIframes.observe(document, {
                childList: true,
                subtree: true
            });

            // Also inject into any existing iframes
            document.querySelectorAll('iframe').forEach(function(iframe) {
                try {
                    iframe.contentWindow.eval(`(${arguments.callee.toString()})()`);
                } catch (e) {
                    console.error('Failed to inject logging into existing iframe:', e);
                }
            });

            console.log('Console logging system initialized');
        }
    """

def extract_body_content(dom_string):
    # Parse the DOM string
    soup = BeautifulSoup(dom_string, 'html.parser')
    
    # Find the body tag
    body = soup.body
    
    if body:
        # Remove all script tags
        for script in body(["script"]):
            script.decompose()
        
        # Get the HTML content
        content = ''.join(str(child) for child in body.children)
        
        return "<body>\n" + content + "\n</body>"
    else:
        return "No body tag found in the DOM string."

app = Flask(__name__)

def get_chrome_info(port):
    try:
        # Get the list of pages
        response = requests.get(f'http://localhost:{port}/json')
        if response.status_code == 200:
            pages = response.json()
            if pages:
                # Get the first page (you might want to modify this if you need a specific page)
                page = pages[0]
                return {
                    "running": True,
                    "url": page.get('url', 'N/A'),
                    "title": page.get('title', 'N/A')
                }
    except requests.exceptions.ConnectionError:
        pass
    return {"running": False}

def dismiss_alerts(driver, timeout=1):
    """
    Dismiss any alerts present on the page.
    :param driver: Selenium WebDriver instance
    :param timeout: Maximum time to wait for an alert (default 1 second)
    :return: True if an alert was dismissed, False otherwise
    """
    try:
        # Wait for an alert to be present
        WebDriverWait(driver, timeout).until(EC.alert_is_present())
        # Switch to the alert and dismiss it
        alert = driver.switch_to.alert
        alert.dismiss()
        return True
    except (TimeoutException, NoAlertPresentException):
        # No alert found within the timeout period or no alert present
        return False

def handle_alerts(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        max_attempts = 3
        for attempt in range(max_attempts):
            try:
                debugging_port = kwargs.get('debugging_port', 9222)
                driver = connect_to_chrome(debugging_port)
                
                # Dismiss any initial alerts
                dismiss_alerts(driver, timeout=2)

                # Call the original function
                result = func(driver, *args, **kwargs)

                # Dismiss any alerts that may have appeared during function execution
                dismiss_alerts(driver, timeout=2)

                return result
            except Exception as e:
                if attempt == max_attempts - 1:
                    raise
                print(f"Attempt {attempt + 1} failed: {str(e)}. Retrying...")
                time.sleep(1)
    return wrapper

def kill_chrome_processes():
    """Helper function to kill all Chrome-related processes"""
    chrome_names = ['chrome', 'chromium', 'chromedriver']
    
    for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
        try:
            # Check process name and cmdline
            proc_name = proc.info['name'].lower() if proc.info['name'] else ''
            proc_cmdline = ' '.join(proc.info['cmdline']).lower() if proc.info['cmdline'] else ''
            
            # Kill if process matches any chrome-related names
            if any(chrome_name in proc_name or chrome_name in proc_cmdline 
                  for chrome_name in chrome_names):
                proc.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

def clear_chrome_session(user_profile):
    """Clear Chrome session data without deleting the entire profile"""
    profile_dir = f'chrome-data/{user_profile}/Default'
    
    # Files and directories that store session/state data
    session_items = [
        'Current Session',
        'Current Tabs',
        'Last Session',
        'Last Tabs',
        'Sessions',  # This is a directory
        'Visited Links',
        'History',
        'Login Data',
        'Network Action Predictor',
        'Network Persistent State',
        'Last URL'
    ]
    
    try:
        # Remove session files/directories
        for item in session_items:
            item_path = os.path.join(profile_dir, item)
            if os.path.exists(item_path):
                try:
                    if os.path.isdir(item_path):
                        # If it's a directory, remove it and its contents
                        import shutil
                        shutil.rmtree(item_path, ignore_errors=True)
                    else:
                        # If it's a file, remove it
                        os.remove(item_path)
                except Exception as e:
                    print(f"Warning: Could not remove {item}: {str(e)}")
                    
        # Update preferences to start with blank page
        prefs_file = os.path.join(profile_dir, 'Preferences')
        if os.path.exists(prefs_file):
            try:
                with open(prefs_file, 'r') as f:
                    prefs = json.load(f)
                
                # Force start with blank page
                prefs['session'] = {
                    'restore_on_startup': 5,  # Don't restore
                    'startup_urls': [],  # No startup URLs
                    'last_opened_url': ''  # Clear last URL
                }
                
                with open(prefs_file, 'w') as f:
                    json.dump(prefs, f)
            except Exception as e:
                print(f"Warning: Could not update preferences: {str(e)}")
                    
    except Exception as e:
        print(f"Warning during session cleanup: {str(e)}")

def is_chrome_running(port):
    """Check if Chrome is running on the specified debugging port"""
    try:
        response = requests.get(f'http://localhost:{port}/json/version', timeout=1)
        return response.status_code == 200
    except requests.exceptions.RequestException:
        return False

def close_chrome_gracefully(debugging_port=9222):
    """Attempt to close Chrome gracefully before forcing kill"""
    # First check if Chrome is running to avoid timeout
    if not is_chrome_running(debugging_port):
        print("No Chrome instance found running")
        return True
        
    try:
        # Try to connect to existing Chrome instance
        chrome_options = Options()
        chrome_options.add_experimental_option("debuggerAddress", f"localhost:{debugging_port}")
        driver = webdriver.Chrome(options=chrome_options)
        
        # Close all windows/tabs
        for handle in driver.window_handles:
            driver.switch_to.window(handle)
            driver.close()
            
        # Quit the browser
        driver.quit()
        time.sleep(1)  # Give it a moment to close
        
        return True
    except Exception as e:
        print(f"Graceful close failed: {str(e)}")
        return False

@app.route('/start_browser', methods=['POST'])
def start_browser():
    data = request.json
    debugging_port = data.get('debugging_port', 9222)
    refresh_enabled = data.get('refresh_enabled', False)

    try:
        if refresh_enabled:
            # Try graceful close first
            if not close_chrome_gracefully(debugging_port):
                # Fall back to force kill if graceful close fails
                kill_chrome_processes()

            time.sleep(1)  # Wait for processes to terminate
        
        chrome_path = data.get('chrome_path', '')
        display = data.get('display', ':1')
        user_profile = data.get('user_profile', 'Default')
        
        # Clear session data before starting new browser
        clear_chrome_session(user_profile)

        if not chrome_path:
            common_locations = [
                r'C:\Program Files\Google\Chrome\Application\chrome.exe',
                r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable'
            ]
            for location in common_locations:
                if os.path.exists(location):
                    chrome_path = location
                    break

        if not chrome_path:
            return jsonify({"error": "Chrome executable not found. Please provide the path."}), 400

        try:
            os.environ['DISPLAY'] = display
            
            # Add these environment variables
            os.environ['DBUS_SESSION_BUS_ADDRESS'] = '/dev/null'
            os.environ['CHROME_DBUS_DISABLE'] = '1'
            
            chrome_command = [
                chrome_path,
                f'--remote-debugging-port={debugging_port}',
                '--start-maximized',
                
                # Add these flags to force blank start
                '--homepage=about:blank',
                '--start-page=about:blank',
                '--restore-last-session=false',
                
                # Safer alternatives to --no-sandbox
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                
                # If running in Docker/CI, use these instead
                '--no-zyote',              # Alternative to full sandbox disable
                
                # Rest of your flags...
                '--force-device-scale-factor=1.25',
                
                # Add these D-Bus related flags
                '--disable-dbus',  # Disable D-Bus usage
                '--disable-notifications',  # Disable notifications that might need D-Bus
                '--disable-features=MediaRouter,WebRTC',  # Disable features that might use D-Bus
                
                # Core settings for cookie persistence
                f'--user-data-dir=chrome-data/{user_profile}',
                '--persist-user-preferences',
                f'--profile-directory={user_profile}',
                
                # Aggressive session restore disabling
                '--disable-session-crashed-bubble',
                '--no-restore-session-state',
                '--disable-features=RestoreLastSessionOnStartup,SessionRestore,TabHoverCards,PageInfoV2Cards',
                '--disable-session-service',
                '--disable-crash-reporter',
                '--disable-features=MediaRouter',
                '--restore-last-session=false',
                
                # Aggressive popup and notification blocking
                '--disable-notifications',
                '--disable-popup-blocking',
                '--disable-infobars',
                '--disable-translate',
                '--disable-sync',  # Prevents sync popups while keeping cookies
                '--no-default-browser-check',
                '--no-first-run',
                
                # Disable all update-related popups
                '--disable-component-update',
                '--simulate-outdated',
                '--disable-features=UpdateNotifications',
                
                # Disable various automatic popups
                '--disable-features=AutofillSaveCardBubbleV2',
                '--disable-features=AutofillCreditCardAuthentication',
                '--disable-features=PasswordRevamp',
                '--disable-features=InterestFeedContentSuggestions',
                
                # Performance and stability settings
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-software-rasterizer',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-background-networking',
                
                # Additional popup prevention
                '--disable-save-password-bubble',
                '--disable-client-side-phishing-detection',
                '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync',
                '--silent-debugger-extension-api',
            ]


            # Create user data directory if it doesn't exist
            user_data_dir = f'chrome-data/{user_profile}'
            os.makedirs(user_data_dir, exist_ok=True)

            # Enhanced script with more aggressive tooltip removal
            remove_automation_flags_script = """
            // Remove webdriver flag
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });

            // Remove automation flags from Chrome
            window.chrome = {
                runtime: {},
                loadTimes: function(){},
                csi: function(){},
                app: {},
            };

            // Remove automation-specific CSS
            let automationStyle = document.querySelector('link[rel="stylesheet"][href*="automation"]');
            if (automationStyle) {
                automationStyle.remove();
            }

            // Function to remove unwanted elements
            function removeUnwantedElements() {
                // Remove automation banner
                const banners = document.getElementsByClassName('infobar');
                for (const banner of banners) {
                    if (banner.textContent.includes('automated')) {
                        banner.remove();
                    }
                }
                
                // More aggressive tooltip/button removal
                const selectors = [
                    '[role="button"]',
                    '[role="tooltip"]',
                    '.restore-button',
                    '.restore-tab-button',
                    '.restore-pages-button',
                    '.session-restore',
                    '.tooltip',
                    '#restore-button',
                    '[title*="Restore"]',
                    '[aria-label*="Restore"]',
                    '[data-tooltip*="Restore"]'
                ];
                
                selectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(element => {
                        if (element.textContent?.includes('Restore') || 
                            element.getAttribute('title')?.includes('Restore') ||
                            element.getAttribute('aria-label')?.includes('Restore')) {
                            element.remove();
                        }
                    });
                });

                // Remove any Chrome UI elements that might contain tooltips
                const chromeUIElements = document.querySelectorAll('*');
                chromeUIElements.forEach(element => {
                    if (element.shadowRoot) {
                        const shadowElements = element.shadowRoot.querySelectorAll('*');
                        shadowElements.forEach(shadowElement => {
                            if (shadowElement.textContent?.includes('Restore')) {
                                shadowElement.remove();
                            }
                        });
                    }
                });
            }
            
            // Initial removal
            removeUnwantedElements();
            
            // Monitor and remove any dynamically added elements
            const observer = new MutationObserver((mutations) => {
                removeUnwantedElements();
            });
            
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['role', 'title', 'aria-label', 'data-tooltip']
            });

            // Also try to prevent the session restore functionality
            try {
                chrome.sessions.restore = undefined;
                chrome.sessions = undefined;
            } catch(e) {}
            """

            # Create a preferences file to disable session restore
            prefs_file = os.path.join(user_data_dir, 'Default', 'Preferences')
            os.makedirs(os.path.dirname(prefs_file), exist_ok=True)
            
            prefs = {
                "profile": {
                    "exit_type": "Normal",
                    "exited_cleanly": True
                },
                "session": {
                    "restore_on_startup": 5,
                    "startup_urls": []
                },
                "browser": {
                    "custom_chrome_frame": False,
                    "has_seen_welcome_page": True,
                    "show_home_button": False,
                    "should_restore_session": False,
                    "enable_session_restore": False
                }
            }
            
            with open(prefs_file, 'w') as f:
                json.dump(prefs, f)

            subprocess.Popen(chrome_command, env=os.environ)

            # Wait for Chrome to start
            time.sleep(2)
            
            # Connect to Chrome and inject the scripts
            try:
                driver = connect_to_chrome(debugging_port)
                driver.execute_script(remove_automation_flags_script)
                driver.execute_script(get_console_logging_script())
            except Exception as e:
                print(f"Warning: Failed to inject scripts: {str(e)}")

            # Get Chrome info and return response
            chrome_info = get_chrome_info(debugging_port)
            if chrome_info["running"]:
                return jsonify({
                    "message": f"Chrome started on debugging port {debugging_port} with DISPLAY={display} and user profile '{user_profile}'",
                    "url": chrome_info["url"],
                    "title": chrome_info["title"]
                }), 200
            else:
                return jsonify({
                    "message": f"Chrome started on debugging port {debugging_port} with DISPLAY={display} and user profile '{user_profile}'"
                }), 200

        except Exception as e:
            return jsonify({"error": f"Failed to start Chrome: {str(e)}"}), 500

    except Exception as e:
        print(f"Warning during Chrome cleanup: {str(e)}")

def connect_to_chrome(debugging_port=9222):
    chrome_options = Options()
    chrome_options.add_experimental_option("debuggerAddress", f"localhost:{debugging_port}")
    driver = webdriver.Chrome(options=chrome_options)
    return driver

def establish_stable_connection(debugging_port=9222, max_retries=3):
    """Establish a stable connection to Chrome with retries"""
    for attempt in range(max_retries):
        try:
            chrome_options = Options()
            chrome_options.add_experimental_option("debuggerAddress", f"localhost:{debugging_port}")
            driver = webdriver.Chrome(options=chrome_options)
            
            # Test the connection by executing a simple command
            driver.execute_script("return document.readyState")
            return driver
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            time.sleep(1)  # Wait before retry
            
    raise Exception("Failed to establish stable connection")

@app.route('/click_element', methods=['POST'])
@handle_alerts
def click_element(driver):
    data = request.json
    xpath = data.get('xpath')
    x_coord = data.get('x')
    y_coord = data.get('y')
    debugging_port = data.get('debugging_port', 9222)
    wait_time = data.get('wait_time', 10)
    SCREENSHOT_TOP_CROP = 50  # Define constant for element detection only

    if not xpath and (x_coord is None or y_coord is None):
        return jsonify({"error": "Either XPath or both X and Y coordinates must be provided"}), 400

    max_retries = 3
    retry_delay = 1  # seconds

    for attempt in range(max_retries):
        try:
            # Re-establish connection on each retry
            if attempt > 0:
                driver = establish_stable_connection(debugging_port)

            # Configure PyAutoGUI settings
            pyautogui.PAUSE = 0.1
            pyautogui.FAILSAFE = True

            if xpath:
                # XPath-based clicking logic
                element = WebDriverWait(driver, wait_time).until(
                    EC.presence_of_element_located((By.XPATH, xpath))
                )
                
                element = WebDriverWait(driver, wait_time).until(
                    EC.element_to_be_clickable((By.XPATH, xpath))
                )
                
                # Get element's position relative to viewport
                element_rect = element.rect
                
                # Calculate center point of the element
                center_x = element_rect['x'] + (element_rect['width'] / 2)
                center_y = element_rect['y'] + (element_rect['height'] / 2)
                
                # Get the window position
                window_rect = driver.get_window_rect()
                
                # Calculate absolute screen coordinates (no offset for clicking)
                abs_x = window_rect['x'] + center_x
                abs_y = window_rect['y'] + center_y
                
                # Move mouse and perform click with retry
                pyautogui.moveTo(abs_x, abs_y, duration=0.2)
                time.sleep(0.1)
                pyautogui.click()
                
                result = "Click performed at element location"
                
            else:
                # Get window position
                window_rect = driver.get_window_rect()
                
                # Calculate absolute screen coordinates (no offset for clicking)
                abs_x = window_rect['x'] + x_coord
                abs_y = window_rect['y'] + y_coord
                
                # Get element info before clicking (adjust Y for element detection)
                element_info = driver.execute_script("""
                    function getElementFromPoint(x, y) {
                        // Adjust y-coordinate for element detection to match screenshot
                        const adjustedY = y - arguments[2];  // Subtract crop offset
                        const element = document.elementFromPoint(x, adjustedY);
                        if (element) {
                            return {
                                html: element.outerHTML,
                                id: element.id,
                                tagName: element.tagName,
                                className: element.className,
                                offset: {
                                    top: element.getBoundingClientRect().top,
                                    left: element.getBoundingClientRect().left
                                }
                            };
                        }
                        return null;
                    }
                    return getElementFromPoint(arguments[0], arguments[1], arguments[2]);
                """, x_coord, y_coord, SCREENSHOT_TOP_CROP)
                
                # Move mouse and perform click with retry
                pyautogui.moveTo(abs_x, abs_y, duration=0.2)
                time.sleep(0.1)
                pyautogui.click()
                
                result = {
                    "message": "Click performed at coordinates",
                    "intended_coordinates": {"x": x_coord, "y": y_coord},
                    "actual_coordinates": {"x": abs_x, "y": abs_y},
                    "clicked_element": element_info
                }

            return jsonify(result), 200

        except Exception as e:
            if attempt == max_retries - 1:
                raise
            print(f"Attempt {attempt + 1} failed: {str(e)}. Retrying in {retry_delay} seconds...")
            time.sleep(retry_delay)

    return jsonify({"error": "All retry attempts failed"}), 500

@app.route('/double_click_element', methods=['POST'])
@handle_alerts
def double_click_element(driver):
    data = request.json
    xpath = data.get('xpath')
    x_coord = data.get('x')
    y_coord = data.get('y')
    debugging_port = data.get('debugging_port', 9222)
    wait_time = data.get('wait_time', 10)
    SCREENSHOT_TOP_CROP = 50  # Define constant for element detection only

    if not xpath and (x_coord is None or y_coord is None):
        return jsonify({"error": "Either XPath or both X and Y coordinates must be provided"}), 400

    try:
        # Configure PyAutoGUI settings
        pyautogui.PAUSE = 0.1
        pyautogui.FAILSAFE = True

        if xpath:
            # XPath-based double clicking logic
            element = WebDriverWait(driver, wait_time).until(
                EC.presence_of_element_located((By.XPATH, xpath))
            )
            
            # Get element's location and browser window position
            element_location = element.location
            window_rect = driver.get_window_rect()
            
            # Calculate absolute screen coordinates (no offset for clicking)
            abs_x = window_rect['x'] + element_location['x']
            abs_y = window_rect['y'] + element_location['y']
            
            # Move mouse and double click
            pyautogui.moveTo(abs_x, abs_y)
            pyautogui.doubleClick()
            
            result = "Double click performed at element location"
            
        else:
            # Get window position
            window_rect = driver.get_window_rect()
            
            # Calculate absolute screen coordinates (no offset for clicking)
            abs_x = window_rect['x'] + x_coord
            abs_y = window_rect['y'] + y_coord
            
            # Get element info before clicking (adjust Y for element detection)
            element_info = driver.execute_script("""
                function getElementFromPoint(x, y) {
                    // Adjust y-coordinate for element detection to match screenshot
                    const adjustedY = y - arguments[2];  // Subtract crop offset
                    const element = document.elementFromPoint(x, adjustedY);
                    if (element) {
                        return {
                            html: element.outerHTML,
                            id: element.id,
                            tagName: element.tagName,
                            className: element.className,
                            offset: {
                                top: element.getBoundingClientRect().top,
                                left: element.getBoundingClientRect().left
                            }
                        };
                    }
                    return null;
                }
                return getElementFromPoint(arguments[0], arguments[1], arguments[2]);
            """, x_coord, y_coord, SCREENSHOT_TOP_CROP)
            
            # Move mouse and double click
            pyautogui.moveTo(abs_x, abs_y)
            pyautogui.doubleClick()
            
            result = {
                "message": "Double click performed at coordinates",
                "intended_coordinates": {"x": x_coord, "y": y_coord},
                "actual_coordinates": {"x": abs_x, "y": abs_y},
                "clicked_element": element_info
            }

        return jsonify(result), 200

    except TimeoutException:
        return jsonify({"error": f"Element not found within {wait_time} seconds"}), 404
    except WebDriverException as e:
        return jsonify({"error": f"WebDriver error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500

def get_browser_content_offset(driver):
    """
    Calculate the offset of the browser's content area from the window edge.
    This accounts for things like the address bar, bookmarks bar, etc.
    """
    return driver.execute_script("""
        return {
            top: window.outerHeight - window.innerHeight + 
                 (window.screenY || window.screenTop || 0),
            left: (window.screenX || window.screenLeft || 0)
        };
    """)
    
@app.route('/go_to_url', methods=['POST'])
@handle_alerts
def go_to_url(driver):
    data = request.json
    url = data.get('url')
    debugging_port = data.get('debugging_port', 9222)
    timeout = data.get('timeout', 300)
    page_load_timeout = data.get('page_load_timeout', 300)

    if not url:
        return jsonify({"error": "URL not provided"}), 400

    # Handle missing protocol
    if not re.match(r'^\w+://', url):
        url = f'https://{url}'

    try:
        # Start a timer for the overall operation
        start_time = time.time()
        
        print(f"Attempting to navigate to: {url}")
        
        # Get all tabs information
        response = requests.get(f'http://localhost:{debugging_port}/json')
        if response.status_code != 200:
            return jsonify({"error": "Failed to get tabs information"}), 500
            
        tabs = response.json()
        
        # Find the active tab by looking for focused:true or the most recently active tab
        active_tab = None
        for tab in tabs:
            if tab.get('type') == 'page' and tab.get('focused', False):
                active_tab = tab
                break
        
        # If no focused tab found, try to get the most recently active one
        if not active_tab:
            for tab in tabs:
                if tab.get('type') == 'page':
                    active_tab = tab
                    break
                
        if not active_tab:
            return jsonify({"error": "Could not find active tab"}), 500

        # Create a new driver instance connected to the active tab
        chrome_options = Options()
        chrome_options.add_experimental_option("debuggerAddress", f"localhost:{debugging_port}")
        active_driver = webdriver.Chrome(options=chrome_options)
        active_driver.switch_to.window(active_tab['id'])
        
        # Set page load timeout
        active_driver.set_page_load_timeout(page_load_timeout)
        
        try:
            # Execute JavaScript to navigate in the active tab
            active_driver.execute_script(f"window.location.href = '{url}';")
            
            # Wait for page load with timeout
            WebDriverWait(active_driver, timeout).until(
                lambda d: d.execute_script('return document.readyState') == 'complete'
            )
        except TimeoutException:
            elapsed_time = time.time() - start_time
            return jsonify({
                "error": f"Navigation timed out after {elapsed_time:.1f} seconds",
                "partial_url": active_driver.current_url,
                "partial_title": active_driver.title,
                "status": "timeout"
            }), 504

        current_url = active_driver.current_url
        page_title = active_driver.title
        
        print(f"Current URL: {current_url}")
        print(f"Page title: {page_title}")

        # Clean up the active driver
        active_driver.quit()

        return jsonify({
            "message": "Navigation completed successfully",
            "current_url": current_url,
            "page_title": page_title,
            "fully_loaded": True,
            "elapsed_time": time.time() - start_time
        }), 200

    except Exception as e:
        error_msg = str(e)
        stack_trace = traceback.format_exc()
        print(f"Unexpected error: {error_msg}")
        print(f"Stack trace: {stack_trace}")
        return jsonify({
            "error": f"Unexpected error: {error_msg}",
            "stack_trace": stack_trace,
            "status": "error"
        }), 500
    
@app.route('/type_input', methods=['POST'])
@handle_alerts
def type_input(driver):
    data = request.json
    input_text = data.get('text')
    special_key = data.get('special_key')
    delay = data.get('delay', 0.1)  # Add configurable delay between keystrokes
    clear_first = data.get('clear_first', True)  # New parameter, defaults to True

    if not input_text and not special_key:
        return jsonify({"error": "Either input text or special key must be provided"}), 400

    try:
        # Configure PyAutoGUI settings
        pyautogui.PAUSE = delay  # Set the delay between actions
        pyautogui.FAILSAFE = True  # Enable fail-safe feature

        # Clear the input field first if requested
        if clear_first:
            # Select all text (Ctrl+A) and delete it
            if platform.system() == 'Darwin':  # macOS
                pyautogui.hotkey('command', 'a')
            else:  # Windows/Linux
                pyautogui.hotkey('ctrl', 'a')
            pyautogui.press('delete')
            time.sleep(delay)  # Wait a bit after clearing

        if special_key:
            # Map special keys to PyAutoGUI keys
            special_keys_map = {
                'DELETE': 'delete',
                'BACKSPACE': 'backspace',
                'TAB': 'tab',
                'RETURN': 'return',
                'ENTER': 'enter',
                'PAGE_UP': 'pageup',
                'PAGE_DOWN': 'pagedown',
                'HOME': 'home',
                'END': 'end',
                'ESCAPE': 'esc',
                'UP': 'up',
                'DOWN': 'down',
                'LEFT': 'left',
                'RIGHT': 'right',
                'CONTROL': 'ctrl',
                'COMMAND': 'command',
                'ALT': 'alt',
                'SHIFT': 'shift',
            }
            
            # Split compound keys (e.g., "CONTROL A" -> ["CONTROL", "A"])
            key_combination = special_key.upper().split()
            
            if len(key_combination) > 1:
                # Handle key combinations (e.g., Ctrl+A, Ctrl+C)
                keys = [special_keys_map.get(k, k.lower()) for k in key_combination]
                pyautogui.hotkey(*keys)
            else:
                # Handle single special key
                key = special_keys_map.get(key_combination[0])
                if not key:
                    return jsonify({"error": f"Unsupported special key: {special_key}"}), 400
                pyautogui.press(key)
        else:
            # Type the regular text
            pyautogui.write(input_text)

        return jsonify({
            "message": "Keys sent successfully",
            "text": input_text if input_text else special_key,
            "cleared_first": clear_first
        }), 200

    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
    

@app.route('/inspect_element', methods=['POST'])
@handle_alerts
def inspect_element(driver):
    data = request.json
    x = data.get('x')
    y = data.get('y')
    html_content = driver.execute_script(f"return document.elementFromPoint({x}, {y}).outerHTML;")
    return jsonify({"html_content": html_content}), 200
        
@app.route('/scroll_page', methods=['POST'])
@handle_alerts
def scroll_page(driver):
    data = request.json
    scroll_type = data.get('scroll_type', 'pixels')  # 'pixels' or 'element'
    value = data.get('value')  # pixels to scroll or xpath of element
    debugging_port = data.get('debugging_port', 9222)

    if not value:
        return jsonify({"error": "Scroll value or element xpath must be provided"}), 400

    try:   
        if scroll_type == 'pixels':
            # Scroll by pixel amount
            driver.execute_script(f"window.scrollBy(0, {value});")
            message = f"Scrolled by {value} pixels"
        elif scroll_type == 'element':
            # Scroll to element
            element = WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.XPATH, value))
            )
            driver.execute_script("arguments[0].scrollIntoView(true);", element)
            message = f"Scrolled to element with xpath: {value}"
        else:
            return jsonify({"error": "Invalid scroll_type. Use 'pixels' or 'element'."}), 400

        # Get current scroll position
        scroll_position = driver.execute_script("return window.pageYOffset;")
        
        return jsonify({
            "message": message,
            "scroll_position": scroll_position
        }), 200

    except NoSuchElementException:
        return jsonify({"error": "Element not found"}), 404
    except WebDriverException as e:
        return jsonify({"error": f"WebDriver error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
    
@app.route('/drag_element', methods=['POST'])
@handle_alerts
def drag_element(driver):
    data = request.json
    source_xpath = data.get('source_xpath')
    target_xpath = data.get('target_xpath')
    debugging_port = data.get('debugging_port', 9222)

    if not source_xpath or not target_xpath:
        return jsonify({"error": "Both source_xpath and target_xpath must be provided"}), 400

    try:
        # Wait for the source element to be present and clickable
        source_element = WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.XPATH, source_xpath))
        )
        
        # Wait for the target element to be present
        target_element = WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.XPATH, target_xpath))
        )
        
        # Perform the drag and drop action
        action_chains = ActionChains(driver)
        action_chains.drag_and_drop(source_element, target_element).perform()
        
        # Log the action details
        print(f"Dragged element from {source_xpath} to {target_xpath}")
        
        return jsonify({
            "message": "Element dragged successfully",
            "source_xpath": source_xpath,
            "target_xpath": target_xpath
        }), 200

    except TimeoutException:
        return jsonify({"error": "Element not interactable within timeout period"}), 404
    except NoSuchElementException:
        return jsonify({"error": "One or both elements not found"}), 404
    except ElementNotInteractableException:
        return jsonify({"error": "Element is not interactable"}), 400
    except WebDriverException as e:
        return jsonify({"error": f"WebDriver error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
    

def get_dom_content(driver):
    try:
        dom_content = driver.execute_script("return document.documentElement.outerHTML;")
        return dom_content
    except Exception as e:
        print(f"Error getting DOM content: {e}")
        return None

def generate_response(screenshot, dom_content):
    try:
        # Limit the size of dom_content if it's too large
        max_dom_size = 1000000  # 1MB limit
        if len(dom_content) > max_dom_size:
            dom_content = dom_content[:max_dom_size] + "... (truncated)"

        return json.dumps({
            "screenshot": screenshot,
            "dom_content": dom_content
        })
    except Exception as e:
        print(f"Error generating response: {str(e)}")
        return json.dumps({"error": "Failed to generate response"})

@app.route('/look', methods=['POST'])
@handle_alerts
def look(driver):
    data = request.json
    debugging_port = data.get('debugging_port', 9222)
    try:
        # Wait for the page to be fully loaded with a shorter timeout
        try:
            WebDriverWait(driver, 15).until(
                EC.presence_of_element_located((By.TAG_NAME, "body"))
            )
        except TimeoutException:
            # If timeout occurs, capture what's available
            window_rect = driver.get_window_rect()
            
            # Take full screenshot
            screenshot = pyautogui.screenshot()
            
            # Get screen size
            screen_width, screen_height = screenshot.size
            
            # Crop 30 pixels from top (to avoid partial window)
            cropped_screenshot = screenshot.crop((0, 50, screen_width, screen_height))
            
            # Convert PIL image to base64
            import io
            import base64
            buffered = io.BytesIO()
            cropped_screenshot.save(buffered, format="PNG")
            screenshot_base64 = base64.b64encode(buffered.getvalue()).decode()
            
            return jsonify({
                "error": "Timed out waiting for page to load",
                "screenshot": screenshot_base64,
                "current_url": driver.current_url,
                "page_title": driver.title
            }), 200

        # Take full screenshot
        screenshot = pyautogui.screenshot()
        
        # Get screen size
        screen_width, screen_height = screenshot.size
        
        # Crop 30 pixels from top (to avoid partial window)
        cropped_screenshot = screenshot.crop((0, 50, screen_width, screen_height))
        
        # Convert PIL image to base64
        import io
        import base64
        buffered = io.BytesIO()
        cropped_screenshot.save(buffered, format="PNG")
        screenshot_base64 = base64.b64encode(buffered.getvalue()).decode()

        # Get DOM content
        dom_content = driver.execute_script("return document.documentElement.outerHTML;")

        # Return the response
        response_data = {
            "screenshot": screenshot_base64,
            "dom_content": dom_content,
            "current_url": driver.current_url,
            "page_title": driver.title
        }
        return jsonify(response_data)
    except Exception as e:
        # Capture any unexpected errors
        try:
            # Take full screenshot
            screenshot = pyautogui.screenshot()
            
            # Get screen size
            screen_width, screen_height = screenshot.size
            
            # Crop 30 pixels from top
            cropped_screenshot = screenshot.crop((0, 50, screen_width, screen_height))
            
            # Convert to base64
            buffered = io.BytesIO()
            cropped_screenshot.save(buffered, format="PNG")
            error_screenshot_base64 = base64.b64encode(buffered.getvalue()).decode()
        except:
            error_screenshot_base64 = None

        return jsonify({
            "error": f"Unexpected error: {str(e)}",
            "error_screenshot": error_screenshot_base64,
            "current_url": driver.current_url,
            "page_title": driver.title
        }), 200
    
@app.route('/deep-look', methods=['POST'])
@handle_alerts
def deep_look(driver):
    data = request.json
    debugging_port = data.get('debugging_port', 9222)

    try:
        # Wait for the page to be fully loaded
        try:
            WebDriverWait(driver, 30).until(
                EC.presence_of_element_located((By.TAG_NAME, "body"))
            )
        except TimeoutException:
            return jsonify({"error": "Timed out waiting for page to load"}), 504
        
        color_change="""// Function to generate a distinct light color based on index
function getDistinctLightColor(index) {
    const hueStep = 360 / 20; // Divide the color wheel into 20 parts
    const hue = index * hueStep % 360;
    const saturation = 60 + (index % 4) * 10; // Vary saturation between 60-90%
    const lightness = 80 + (index % 3) * 5; // Vary lightness between 80-90%
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

// Function to check if an element is visible
function isVisible(element) {
    if (element.offsetParent === null && element.tagName !== 'BODY') return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
}

// Function to apply color to a div element and set all text within it to black
function applyColorToDiv(div, index) {
    if (isVisible(div)) {
        const color = getDistinctLightColor(index);
        div.style.backgroundColor = color;
        div.style.color = 'black';
        div.style.outline = '2px solid ' + color.replace('hsl', 'hsla').replace(')', ', 0.7)');
        
        // Set all text elements within the div to black
        div.querySelectorAll('*').forEach(element => {
            if (window.getComputedStyle(element).color !== 'rgb(0, 0, 0)') {
                element.style.setProperty('color', 'black', 'important');
            }
        });
    }
}

// Select all div elements, filter visible ones, and apply distinct colors
const visibleDivs = Array.from(document.querySelectorAll('div')).filter(isVisible);
visibleDivs.forEach(applyColorToDiv);

// Optional: If you want newly added divs to also get distinct colors
let divIndex = visibleDivs.length;
const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'DIV') {
                applyColorToDiv(node, divIndex++);
            }
        });
    });
});
observer.observe(document.body, { childList: true, subtree: true });
"""
        driver.execute_script(color_change)
        # Allow some time for dynamic content to load
        time.sleep(0.5)
        
        # Take a screenshot
        screenshot = driver.get_screenshot_as_base64()

        time.sleep(0.5)

        reverse_script = """// Function to reverse the color effects
function reverseColorEffects() {
    // Select all elements
    document.querySelectorAll('*').forEach(element => {
        // Check if the element has inline background-color style
        if (element.style.backgroundColor) {
            // Remove the background color
            element.style.removeProperty('background-color');
            
            // Remove the outline
            element.style.removeProperty('outline');
        }

        // Remove the text color (assuming it was set to black)
        if (element.style.color === 'black' || element.style.color === 'rgb(0, 0, 0)') {
            element.style.removeProperty('color');
        }
    });
}

// Run the reverse function
reverseColorEffects();

// Stop the MutationObserver if it exists
if (window.observer && window.observer.disconnect) {
    window.observer.disconnect();
}

// Remove any global variables or functions created by the original script
if (window.getDistinctLightColor) delete window.getDistinctLightColor;
if (window.isVisible) delete window.isVisible;
if (window.applyColorToDiv) delete window.applyColorToDiv;
"""

        driver.execute_script(reverse_script)
        
        return jsonify({
            "screenshot": screenshot,
            "message": "Screenshot captured successfully"
        })

    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
    
@app.route('/press_enter', methods=['POST'])
@handle_alerts
def press_enter(driver):
    data = request.json
    debugging_port = data.get('debugging_port', 9222)

    try:
        # Use ActionChains to send Enter key - most reliable cross-browser method
        ActionChains(driver).send_keys(Keys.RETURN).perform()
        
        return jsonify({
            "message": "Enter key pressed successfully"
        }), 200

    except WebDriverException as e:
        return jsonify({"error": f"WebDriver error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
    
@app.route('/go_back', methods=['POST'])
@handle_alerts
def go_back(driver):
    data = request.json
    debugging_port = data.get('debugging_port', 9222)

    try:
        # Go back to the previous page
        driver.back()
        
        # Wait for the page to load
        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
        
        current_url = driver.current_url
        page_title = driver.title
        
        return jsonify({
            "message": "Successfully navigated back",
            "current_url": current_url,
            "page_title": page_title
        }), 200

    except TimeoutException:
        return jsonify({"error": "Timeout while loading the previous page"}), 504
    except WebDriverException as e:
        return jsonify({"error": f"WebDriver error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
    
@app.route('/get_console_log', methods=['GET'])
@handle_alerts
def get_console_log(driver):
    debugging_port = request.args.get('debugging_port', 9222)

    try:
        # First, check if our logging is initialized
        is_initialized = driver.execute_script("""
            return window._consoleLogs !== undefined;
        """)
        
        print(f"Logging initialized: {is_initialized}")

        # If not initialized, inject our logging script
        if not is_initialized:
            print("Initializing console logging...")
            # Inject the logging script in parts to ensure it's all executed
            driver.execute_script("""
                // Create the storage array
                window._consoleLogs = [];
                
                // Create a function to format messages
                window._formatLogMessage = function(arg) {
                    if (arg === null) return 'null';
                    if (arg === undefined) return 'undefined';
                    if (typeof arg === 'object') {
                        try {
                            return JSON.stringify(arg);
                        } catch (e) {
                            return String(arg);
                        }
                    }
                    return String(arg);
                };
            """)

            # Override console methods
            driver.execute_script("""
                ['log', 'info', 'warn', 'error', 'debug'].forEach(function(method) {
                    const originalFn = console[method];
                    console[method] = function(...args) {
                        const message = Array.from(args).map(window._formatLogMessage).join(' ');
                        window._consoleLogs.push({
                            level: method,
                            message: message,
                            timestamp: new Date().toISOString(),
                            url: window.location.href
                        });
                        originalFn.apply(console, args);
                    };
                });
            """)

            # Add error listeners
            driver.execute_script("""
                window.addEventListener('error', function(event) {
                    window._consoleLogs.push({
                        level: 'error',
                        message: event.message,
                        timestamp: new Date().toISOString(),
                        url: event.filename,
                        line: event.lineno,
                        column: event.colno
                    });
                });

                window.addEventListener('unhandledrejection', function(event) {
                    window._consoleLogs.push({
                        level: 'error',
                        message: 'Unhandled Promise Rejection: ' + event.reason,
                        timestamp: new Date().toISOString(),
                        url: window.location.href
                    });
                });
            """)

            print("Console logging initialization complete")

        # Get the logs
        logs = driver.execute_script("return window._consoleLogs;")
        print(f"Retrieved {len(logs) if logs else 0} logs")
        
        # Verify logs exist
        if not logs:
            print("No logs found, checking console directly...")
            # Try to directly log and retrieve
            driver.execute_script("""
                if (!window._consoleLogs) {
                    console.error('_consoleLogs is undefined!');
                } else {
                    console.log('Current log count:', window._consoleLogs.length);
                }
            """)
        
        return jsonify({
            "message": "Console logs retrieved successfully",
            "logs": logs
        }), 200

    except Exception as e:
        print(f"Error getting console logs: {str(e)}")
        traceback.print_exc()
        return jsonify({"error": f"Failed to get console logs: {str(e)}"}), 500

# Add a method to clear logs if needed
@app.route('/clear_console_log', methods=['POST'])
@handle_alerts
def clear_console_log(driver):
    try:
        driver.execute_script("window._consoleLogs = [];")
        return jsonify({
            "message": "Console logs cleared successfully"
        }), 200
    except Exception as e:
        return jsonify({"error": f"Failed to clear console logs: {str(e)}"}), 500
    
@app.route('/folder-tree', methods=['GET'])
def folder_tree():
    folder_path = request.args.get('folder_path')

    # cd into /home/fume/Documents and run find {folder_path} -type f -exec ls -l {} \; | grep -v ^total
    command = f"cd /home/fume/Documents && find {folder_path} -mindepth 1 -maxdepth 3"
    output = subprocess.check_output(command, shell=True).decode('utf-8')
    
    return jsonify({
        "message": "Folder tree retrieved successfully",
        "folder_path": folder_path,
        "output": output
    })

@app.route('/find-repo', methods=['POST'])
def find_repo():
    data = request.json
    remote_url = data.get('remote_url')
    
    if not remote_url:
        return jsonify({"error": "Remote URL not provided"}), 400
    
    try:
        # Start from /home/fume/Documents
        base_path = '/home/fume/Documents'
        
        # Function to get immediate subdirectories
        def get_subdirs(path):
            try:
                return [entry.path for entry in os.scandir(path) 
                       if entry.is_dir() and not entry.name.startswith('.')]
            except PermissionError:
                return []

        # Function to check if a directory is the target repo
        def is_target_repo(path):
            git_config_path = os.path.join(path, '.git', 'config')
            if os.path.exists(git_config_path):
                try:
                    with open(git_config_path, 'r') as f:
                        config_content = f.read()
                    return remote_url in config_content
                except Exception as e:
                    print(f"Error reading git config at {git_config_path}: {str(e)}")
            return False

        # BFS implementation with layer tracking
        visited = set()
        current_layer = [base_path]
        depth = 0
        max_depth = 3  # Maximum depth to search
        
        while current_layer and depth < max_depth:
            print(f"Searching depth {depth}...")
            next_layer = []
            
            # Process current layer
            for current_path in current_layer:
                if current_path in visited:
                    continue
                    
                visited.add(current_path)
                
                # Check if this is the target repo
                if is_target_repo(current_path):
                    abs_path = os.path.abspath(current_path)
                    return jsonify({
                        "message": "Repository found",
                        "path": abs_path,
                        "depth": depth
                    }), 200
                
                # Add subdirectories to next layer
                next_layer.extend(get_subdirs(current_path))
            
            # Move to next layer
            current_layer = next_layer
            depth += 1
        
        return jsonify({
            "message": "Repository not found",
            "path": None,
            "max_depth_reached": depth >= max_depth
        }), 404

    except Exception as e:
        return jsonify({
            "error": f"Unexpected error: {str(e)}",
            "traceback": traceback.format_exc()
        }), 500
    
    
def can_connect_to_driver(debugging_port=9222):
    """
    Check if there is a Chrome instance running that we can connect to.
    
    Args:
        debugging_port (int): The debugging port to check (default: 9222)
        
    Returns:
        dict: A dictionary containing:
            - connected (bool): Whether connection is possible
            - error (str): Error message if connection failed
            - browser_info (dict): Browser information if connection successful
    """
    try:
        # First check if the debugging port is responding
        response = requests.get(f'http://localhost:{debugging_port}/json/version', timeout=2)
        
        if response.status_code != 200:
            return {
                "connected": False,
                "error": f"Chrome debugging port {debugging_port} responded with status {response.status_code}",
                "browser_info": None
            }
            
        # Try to create a WebDriver instance
        chrome_options = Options()
        chrome_options.add_experimental_option("debuggerAddress", f"localhost:{debugging_port}")
        
        driver = webdriver.Chrome(options=chrome_options)
        
        # Get browser information
        browser_info = {
            "url": driver.current_url,
            "title": driver.title,
            "ready_state": driver.execute_script("return document.readyState"),
            "browser_version": response.json().get("Browser"),
            "websocket_url": response.json().get("webSocketDebuggerUrl")
        }
        
        # Clean up the driver
        driver.quit()
        
        return {
            "connected": True,
            "error": None,
            "browser_info": browser_info
        }
        
    except requests.exceptions.ConnectionError:
        return {
            "connected": False,
            "error": f"Could not connect to Chrome debugging port {debugging_port}",
            "browser_info": None
        }
    except WebDriverException as e:
        return {
            "connected": False,
            "error": f"WebDriver error: {str(e)}",
            "browser_info": None
        }
    except Exception as e:
        return {
            "connected": False,
            "error": f"Unexpected error: {str(e)}",
            "browser_info": None
        }

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5553, debug=True)