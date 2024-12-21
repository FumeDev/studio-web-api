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

@app.route('/start_browser', methods=['POST'])
def start_browser():
    data = request.json
    debugging_port = data.get('debugging_port', 9222)

    try:
        kill_chrome_processes()
        time.sleep(1)  # Wait for processes to terminate
    except Exception as e:
        print(f"Warning during Chrome cleanup: {str(e)}")

    chrome_path = data.get('chrome_path', '')
    display = data.get('display', ':1')
    user_profile = data.get('user_profile', 'Default')

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

        # Enhanced Chrome flags for automation with aggressive popup blocking
        chrome_command = [
            chrome_path,
            f'--remote-debugging-port={debugging_port}',
            '--start-maximized',
            
            # Core settings for cookie persistence
            f'--user-data-dir=chrome-data/{user_profile}',  # Persistent user data
            '--persist-user-preferences',
            f'--profile-directory={user_profile}',
            
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
            
            # Disable session restore popups
            '--disable-session-crashed-bubble',
            '--no-restore-session-state',
            '--disable-features=RestoreLastSessionOnStartup',
            
            # Disable all promotional content
            '--disable-features=ChromePromoDialog,ChromeWhatsNewUI',
            '--disable-features=ExtensionsToolbarMenu',
            
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
            
            # Automation-related settings
            '--enable-automation',
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--ignore-certificate-errors',
            
            # Additional popup prevention
            '--disable-save-password-bubble',
            '--disable-client-side-phishing-detection',
            '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync',
            '--silent-debugger-extension-api',
        ]

        # If running as root, add sandbox disabling
        if os.geteuid() == 0:
            chrome_command.extend([
                '--disable-setuid-sandbox',
                '--disable-seccomp-filter-sandbox'
            ])

        # Create user data directory if it doesn't exist
        user_data_dir = f'chrome-data/{user_profile}'
        os.makedirs(user_data_dir, exist_ok=True)

        subprocess.Popen(chrome_command, env=os.environ)

        # Bring the Chrome window into focus (Linux-only approach)
        if platform.system() == 'Linux':
            try:
                time.sleep(1)  # Wait briefly for the window to appear
                window_id = subprocess.check_output(["xdotool", "search", "--sync", "--onlyvisible", "--class", "chrome"]).decode().strip().split('\n')[0]
                subprocess.check_call(["xdotool", "windowactivate", window_id])
            except Exception as e:
                print(f"Warning: Could not focus Chrome window: {str(e)}")

        # Wait for Chrome to start
        time.sleep(2)
        
        # Connect to Chrome and inject the console logging script
        try:
            driver = connect_to_chrome(debugging_port)
            driver.execute_script(get_console_logging_script())
        except Exception as e:
            print(f"Warning: Failed to inject console logging script: {str(e)}")

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

def is_chrome_running(port):
    try:
        response = requests.get(f'http://localhost:{port}/json/version')
        return response.status_code == 200
    except requests.exceptions.ConnectionError:
        return False

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

            # Focus the Chrome window first
            window_rect = driver.get_window_rect()
            try:
                if platform.system() == 'Linux':
                    window_id = subprocess.check_output(["xdotool", "search", "--sync", "--onlyvisible", "--class", "chrome"]).decode().strip().split('\n')[0]
                    subprocess.check_call(["xdotool", "windowactivate", window_id])
                pyautogui.moveTo(window_rect['x'] + 100, window_rect['y'] + 100)
                pyautogui.click()
                time.sleep(0.2)
            except Exception as e:
                print(f"Warning: Could not focus window: {str(e)}")

            if xpath:
                # XPath-based clicking logic
                element = WebDriverWait(driver, wait_time).until(
                    EC.presence_of_element_located((By.XPATH, xpath))
                )
                
                element = WebDriverWait(driver, wait_time).until(
                    EC.element_to_be_clickable((By.XPATH, xpath))
                )
                
                element_location = element.location
                content_offset = get_browser_content_offset(driver)
                
                abs_x = window_rect['x'] + content_offset['left'] + element_location['x']
                abs_y = window_rect['y'] + content_offset['top'] + element_location['y']
                
                # Ensure coordinates are integers
                abs_x = int(abs_x)
                abs_y = int(abs_y)
                
                # Move mouse and perform click with retry
                pyautogui.moveTo(abs_x, abs_y, duration=0.2)
                time.sleep(0.1)
                pyautogui.click()
                
                if element.tag_name.lower() == 'input':
                    try:
                        element.is_selected()
                        break
                    except:
                        if attempt == max_retries - 1:
                            raise
                        time.sleep(0.2)
                else:
                    break
                
                result = "Click performed at element location"
                
            else:
                # Coordinate-based clicking logic
                viewport_offset = driver.execute_script("""
                    return {
                        top: window.outerHeight - window.innerHeight,
                        left: window.outerWidth - window.innerWidth,
                        scrollX: window.scrollX || window.pageXOffset,
                        scrollY: window.scrollY || window.pageYOffset
                    };
                """)
                
                # Ensure coordinates are integers
                abs_x = int(window_rect['x'] + x_coord)
                abs_y = int(window_rect['y'] + y_coord + viewport_offset['top'])
                
                # Get element info before clicking
                element_info = driver.execute_script("""
                    function getElementFromPoint(x, y) {
                        const element = document.elementFromPoint(x, y);
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
                    return getElementFromPoint(arguments[0], arguments[1]);
                """, x_coord, y_coord)
                
                # Move mouse and perform click with retry
                pyautogui.moveTo(abs_x, abs_y, duration=0.2)
                time.sleep(0.1)
                pyautogui.click()
                
                result = {
                    "message": "Click performed at coordinates",
                    "intended_coordinates": {"x": x_coord, "y": y_coord},
                    "actual_coordinates": {"x": abs_x, "y": abs_y},
                    "viewport_offset": viewport_offset,
                    "window_info": window_rect,
                    "clicked_element": element_info
                }

            # If we get here, the click was successful
            return jsonify(result), 200

        except Exception as e:
            if attempt == max_retries - 1:
                raise
            print(f"Attempt {attempt + 1} failed: {str(e)}. Retrying in {retry_delay} seconds...")
            time.sleep(retry_delay)

    # This should never be reached due to the raise in the loop
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
            
            # Calculate the browser's content offset
            content_offset = get_browser_content_offset(driver)
            
            # Calculate absolute screen coordinates for the element
            abs_x = window_rect['x'] + content_offset['left'] + element_location['x']
            abs_y = window_rect['y'] + content_offset['top'] + element_location['y']
            
            # Move mouse and double click
            pyautogui.moveTo(abs_x, abs_y)
            pyautogui.doubleClick()
            
            result = "Double click performed at element location"
            
        else:
            # Get window position and size information
            window_rect = driver.get_window_rect()
            
            # Get the browser's viewport offset
            viewport_offset = driver.execute_script("""
                return {
                    top: window.outerHeight - window.innerHeight,
                    left: window.outerWidth - window.innerWidth,
                    scrollX: window.scrollX || window.pageXOffset,
                    scrollY: window.scrollY || window.pageYOffset
                };
            """)
            
            # Calculate absolute screen coordinates accounting for viewport offset
            abs_x = window_rect['x'] + x_coord
            abs_y = window_rect['y'] + y_coord + viewport_offset['top']
            
            # Get element at coordinates before clicking (for debugging)
            element_info = driver.execute_script("""
                function getElementFromPoint(x, y) {
                    const element = document.elementFromPoint(x, y);
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
                return getElementFromPoint(arguments[0], arguments[1]);
            """, x_coord, y_coord)
            
            # Move mouse and double click
            pyautogui.moveTo(abs_x, abs_y)
            pyautogui.doubleClick()
            
            result = {
                "message": "Double click performed at coordinates",
                "intended_coordinates": {"x": x_coord, "y": y_coord},
                "actual_coordinates": {"x": abs_x, "y": abs_y},
                "viewport_offset": viewport_offset,
                "window_info": window_rect,
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
    timeout = data.get('timeout', 50)

    if not url:
        return jsonify({"error": "URL not provided"}), 400

    # Handle missing protocol
    if not re.match(r'^\w+://', url):
        url = f'https://{url}'

    try:
        print(f"Attempting to navigate to: {url}")
        
        # Before navigation, get any existing logs
        existing_logs = driver.execute_script("return window._consoleLogs || [];")
        
        # Perform navigation
        driver.get(url)
        
        # Wait for page load
        WebDriverWait(driver, timeout).until(
            lambda d: d.execute_script('return document.readyState') == 'complete'
        )
        
        # Reinject logging script
        driver.execute_script(get_console_logging_script())
        
        # Restore previous logs
        if existing_logs:
            driver.execute_script("window._consoleLogs = arguments[0];", existing_logs)
        
        current_url = driver.current_url
        page_title = driver.title
        
        print(f"Current URL: {current_url}")
        print(f"Page title: {page_title}")
        
        js_errors = driver.execute_script("return window.JSErrors || []")
        if js_errors:
            print("JavaScript errors encountered:", js_errors)
        
        # Reinject the console logging script
        driver.execute_script(get_console_logging_script())

        return jsonify({
            "message": "Navigation attempt completed",
            "current_url": current_url,
            "page_title": page_title,
            "fully_loaded": driver.execute_script('return document.readyState') == 'complete',
            "js_errors": js_errors
        }), 200

    except WebDriverException as e:
        error_msg = str(e)
        stack_trace = traceback.format_exc()
        print(f"WebDriver error: {error_msg}")
        print(f"Stack trace: {stack_trace}")
        
        # Attempt to get additional information
        try:
            current_url = driver.current_url
            page_source = driver.page_source
            screenshot = driver.get_screenshot_as_base64()
        except Exception as inner_e:
            print(f"Error getting additional information: {str(inner_e)}")
            current_url = page_source = screenshot = None

        return jsonify({
            "error": f"WebDriver error: {error_msg}",
            "stack_trace": stack_trace,
            "current_url": current_url,
            "page_source": page_source,
            "screenshot": screenshot
        }), 500

    except Exception as e:
        error_msg = str(e)
        stack_trace = traceback.format_exc()
        print(f"Unexpected error: {error_msg}")
        print(f"Stack trace: {stack_trace}")
        return jsonify({
            "error": f"Unexpected error: {error_msg}",
            "stack_trace": stack_trace
        }), 500
    
@app.route('/type_input', methods=['POST'])
@handle_alerts
def type_input(driver):
    data = request.json
    input_text = data.get('text')
    special_key = data.get('special_key')
    delay = data.get('delay', 0.1)  # Add configurable delay between keystrokes

    if not input_text and not special_key:
        return jsonify({"error": "Either input text or special key must be provided"}), 400

    try:
        # Configure PyAutoGUI settings
        pyautogui.PAUSE = delay  # Set the delay between actions
        pyautogui.FAILSAFE = True  # Enable fail-safe feature

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
            "text": input_text if input_text else special_key
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
            # If timeout occurs, capture what's available on the page
            error_content = driver.page_source
            error_screenshot = driver.get_screenshot_as_base64()
            return jsonify({
                "error": "Timed out waiting for page to load",
                "error_content": error_content,
                "error_screenshot": error_screenshot,
                "current_url": driver.current_url,
                "page_title": driver.title
            }), 200  # Return 200 to allow further processing of the error

        # Attempt to capture viewport data with error handling
        screenshot, dom_content = safe_capture_viewport_data(driver)

        if dom_content is None:
            # If DOM content capture fails, return what we can
            error_content = driver.page_source
            return jsonify({
                "error": "Failed to capture DOM content",
                "error_content": error_content,
                "screenshot": screenshot if screenshot else driver.get_screenshot_as_base64(),
                "current_url": driver.current_url,
                "page_title": driver.title
            }), 200  # Return 200 to allow further processing of the error

        if screenshot is None:
            # If screenshot capture fails, return what we can
            return jsonify({
                "error": "Failed to capture screenshot",
                "dom_content": dom_content,
                "current_url": driver.current_url,
                "page_title": driver.title
            }), 200  # Return 200 to allow further processing of the error

        # Modified generate_response to include URL and title
        response_data = {
            "screenshot": screenshot,
            "dom_content": dom_content,
            "current_url": driver.current_url,
            "page_title": driver.title
        }
        return jsonify(response_data)
    except Exception as e:
        # Capture any unexpected errors
        error_content = driver.page_source
        error_screenshot = driver.get_screenshot_as_base64()
        return jsonify({
            "error": f"Unexpected error: {str(e)}",
            "error_content": error_content,
            "error_screenshot": error_screenshot,
            "current_url": driver.current_url,
            "page_title": driver.title
        }), 200  # Return 200 to allow further processing of the error

def safe_capture_viewport_data(driver):
    import logging

    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)

    try:
        # Get the document.readyState
        ready_state = driver.execute_script("return document.readyState")
        
        # If the page is not complete, wait a bit more
        if ready_state != "complete":
            try:
                WebDriverWait(driver, 10).until(
                    lambda d: d.execute_script("return document.readyState") == "complete"
                )
            except TimeoutException:
                logger.warning("Timed out waiting for page to be complete. Proceeding anyway.")

        # Attempt to capture screenshot using CDP
        screenshot = None
        try:
            screenshot = driver.execute_cdp_cmd("Page.captureScreenshot", {
                "format": "png",
                "fromSurface": True,
                "captureBeyondViewport": False
            })
        except Exception as e:
            logger.error(f"CDP screenshot failed: {e}")
            try:
                # Fallback to regular screenshot method
                screenshot = {"data": driver.get_screenshot_as_base64()}
            except Exception as e:
                logger.error(f"Regular screenshot method also failed: {e}")

        if screenshot is None:
            raise Exception("Failed to capture screenshot using both CDP and regular methods")

        # Get the visible DOM content with a timeout
        try:
            visible_dom_content = WebDriverWait(driver, 10).until(
                lambda d: d.execute_script("""
                    return (function() {
                        var elements = document.body.getElementsByTagName('*');
                        var visibleElements = [];
                        for (var i = 0; i < elements.length; i++) {
                            var rect = elements[i].getBoundingClientRect();
                            if (rect.top < window.innerHeight && rect.bottom > 0 &&
                                rect.left < window.innerWidth && rect.right > 0) {
                                visibleElements.push(elements[i].outerHTML);
                            }
                        }
                        return visibleElements.join('');
                    })();
                """)
            )
        except TimeoutException:
            logger.error("Timed out while trying to get visible DOM content")
            visible_dom_content = None

        if visible_dom_content is None:
            raise Exception("Failed to capture visible DOM content")

        return screenshot['data'], visible_dom_content
    except Exception as e:
        logger.exception(f"Error capturing viewport data: {str(e)}")
        return None, None
    
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
