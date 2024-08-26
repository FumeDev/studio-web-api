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
from selenium.common.exceptions import TimeoutException, NoSuchElementException, WebDriverException, ElementClickInterceptedException, ElementNotInteractableException, InvalidElementStateException, StaleElementReferenceException, NoAlertPresentException
import re
import time
import os
import subprocess
import requests

from bs4 import BeautifulSoup

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

import psutil
import signal

@app.route('/start_browser', methods=['POST'])
def start_browser():
    data = request.json
    debugging_port = data.get('debugging_port', 9222)
    chrome_path = data.get('chrome_path', '')
    display = data.get('display', ':1')
    user_profile = data.get('user_profile', 'Default')

    # Function to kill Chrome process using a specific debugging port
    def kill_chrome_process(port):
        for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
            if proc.info['name'] and 'chrome' in proc.info['name'].lower():
                if any(f'--remote-debugging-port={port}' in cmd for cmd in proc.info['cmdline']):
                    try:
                        os.kill(proc.info['pid'], signal.SIGTERM)
                        proc.wait(timeout=5)  # Wait for the process to terminate
                    except (psutil.NoSuchProcess, psutil.TimeoutExpired):
                        # Process already terminated or didn't respond to SIGTERM
                        pass

    # Kill any existing Chrome process using the specified debugging port
    kill_chrome_process(debugging_port)

    # Check if Chrome is still running (after attempting to kill)
    chrome_info = get_chrome_info(debugging_port)
    if chrome_info["running"]:
        return jsonify({
            "error": f"Failed to kill existing Chrome process on debugging port {debugging_port}",
        }), 500

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
        # Set the DISPLAY environment variable
        os.environ['DISPLAY'] = display

        # Start Chrome with remote debugging, maximized window, and specified user profile
        chrome_command = [
            chrome_path,
            f'--remote-debugging-port={debugging_port}',
            '--start-maximized',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-infobars',
            '--disable-features=InterestFeedContentSuggestions',
            '--disable-default-apps',
            f'--profile-directory={user_profile}'
        ]

        # If running as root, add these options
        if os.geteuid() == 0:
            chrome_command.extend([
                '--disable-setuid-sandbox',
                '--disable-seccomp-filter-sandbox'
            ])

        subprocess.Popen(chrome_command, env=os.environ)

        # Wait for Chrome to start and get the initial page info
        time.sleep(2)  # Give Chrome a moment to start
        chrome_info = get_chrome_info(debugging_port)

        if chrome_info["running"]:
            return jsonify({
                "message": f"Chrome started on debugging port {debugging_port} with DISPLAY={display} and user profile '{user_profile}'",
                "url": chrome_info["url"],
                "title": chrome_info["title"]
            }), 200
        else:
            return jsonify({"message": f"Chrome started on debugging port {debugging_port} with DISPLAY={display} and user profile '{user_profile}'"}), 200

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

@app.route('/click_element', methods=['POST'])
@handle_alerts
def click_element(driver):
    data = request.json
    xpath = data.get('xpath')
    x = data.get('x')
    y = data.get('y')
    debugging_port = data.get('debugging_port', 9222)
    force_click = data.get('force_click', False)
    wait_time = data.get('wait_time', 10)

    if not xpath and (x is None or y is None):
        return jsonify({"error": "Either xpath or both x and y coordinates must be provided"}), 400

    try:
        if xpath:
            try:
                # Wait for the element to be clickable
                element = WebDriverWait(driver, wait_time).until(
                    EC.element_to_be_clickable((By.XPATH, xpath))
                )
                # Scroll the element into view
                driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", element)

                if force_click:
                    # Use JavaScript to click the element
                    driver.execute_script("arguments[0].click();", element)
                else:
                    # Try regular Selenium click first
                    try:
                        element.click()
                    except ElementClickInterceptedException:
                        # If regular click fails, try JavaScript click
                        driver.execute_script("arguments[0].click();", element)
                    except Exception as e:
                        # If any other exception occurs during Selenium click, try JavaScript click
                        print(f"Selenium click failed: {str(e)}. Attempting JavaScript click.")
                        driver.execute_script("arguments[0].click();", element)

                return jsonify({
                    "message": "Element clicked successfully",
                    "xpath": xpath
                }), 200
            except TimeoutException:
                return jsonify({"error": f"Element not clickable or not found within {wait_time} seconds"}), 404
            except NoSuchElementException:
                return jsonify({"error": "Element not found"}), 404
        else:
            # Handle coordinate-based click (unchanged from previous version)
            window_size = driver.get_window_size()
            center_x = window_size['width'] // 2
            center_y = window_size['height'] // 2
            adjusted_x = center_x + x
            adjusted_y = center_y + y
            adjusted_x = max(0, min(adjusted_x, window_size['width'] - 1))
            adjusted_y = max(0, min(adjusted_y, window_size['height'] - 1))

            action_chains = ActionChains(driver)
            action_chains.move_by_offset(center_x, center_y).perform()
            action_chains.move_by_offset(x, y).click().perform()
            action_chains.move_by_offset(-adjusted_x, -adjusted_y).perform()

            return jsonify({
                "message": "Click action performed successfully",
                "click_coordinates": {"x": x, "y": y},
                "adjusted_coordinates": {"x": adjusted_x, "y": adjusted_y}
            }), 200
    except WebDriverException as e:
        return jsonify({"error": f"WebDriver error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
    
@app.route('/go_to_url', methods=['POST'])
@handle_alerts
def go_to_url(driver):
    data = request.json
    url = data.get('url')
    debugging_port = data.get('debugging_port', 9222)

    if not url:
        return jsonify({"error": "URL not provided"}), 400

    # Handle missing protocol
    if not re.match(r'^\w+://', url):
        url = f'https://{url}'

    try:
        driver.get(url)
        
        # Wait for the page to load
        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
        
        current_url = driver.current_url
        page_title = driver.title
        
        return jsonify({
            "message": "Successfully navigated to URL",
            "current_url": current_url,
            "page_title": page_title
        }), 200

    except TimeoutException:
        return jsonify({"error": "Timeout while loading the page"}), 504
    except WebDriverException as e:
        return jsonify({"error": f"WebDriver error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
    
@app.route('/type_input', methods=['POST'])
@handle_alerts
def type_input(driver):
    data = request.json
    xpath = data.get('xpath')
    x = data.get('x')
    y = data.get('y')
    input_text = data.get('text')
    debugging_port = data.get('debugging_port', 9222)
    wait_time = data.get('wait_time', 10)
    clear = data.get('clear', False)

    if not input_text:
        return jsonify({"error": "Input text must be provided"}), 400
    if not xpath and (x is None or y is None):
        return jsonify({"error": "Either xpath or both x and y coordinates must be provided"}), 400

    try:
        if xpath:
            try:
                # Wait for the element to be visible and interactable
                element = WebDriverWait(driver, wait_time).until(
                    EC.visibility_of_element_located((By.XPATH, xpath))
                )
                # Scroll the element into view
                driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", element)
                
                if clear:
                    # Clear any existing text in the input element
                    element.clear()
                
                # Type the input text character by character
                for char in input_text:
                    if char == ' ':
                        element.send_keys(Keys.SPACE)
                    else:
                        element.send_keys(char)
                    time.sleep(0.1)  # Add a small delay between keypresses
                
                # Unfocus the element by clicking elsewhere
                driver.execute_script("arguments[0].blur();", element)
                
                return jsonify({
                    "message": "Input typed successfully",
                    "xpath": xpath
                }), 200
            except TimeoutException:
                return jsonify({"error": f"Element not found or not interactable within {wait_time} seconds"}), 404
            except NoSuchElementException:
                return jsonify({"error": "Element not found"}), 404
        else:
            # Handle coordinate-based input
            window_size = driver.get_window_size()
            center_x = window_size['width'] // 2
            center_y = window_size['height'] // 2
            adjusted_x = center_x + x
            adjusted_y = center_y + y
            adjusted_x = max(0, min(adjusted_x, window_size['width'] - 1))
            adjusted_y = max(0, min(adjusted_y, window_size['height'] - 1))
            
            action_chains = ActionChains(driver)
            action_chains.move_by_offset(center_x, center_y).perform()
            action_chains.move_by_offset(x, y).click().perform()
            
            # Locate the element that is currently focused (where the cursor is)
            active_element = driver.switch_to.active_element
            
            if clear:
                # Clear any existing text in the input element
                active_element.clear()
            
            # Type the input text character by character
            for char in input_text:
                if char == ' ':
                    active_element.send_keys(Keys.SPACE)
                else:
                    active_element.send_keys(char)
                time.sleep(0.1)  # Add a small delay between keypresses
            
            # Unfocus the element by clicking elsewhere
            action_chains.move_by_offset(-adjusted_x, -adjusted_y).click().perform()
            
            return jsonify({
                "message": "Input typed successfully",
                "click_coordinates": {"x": x, "y": y},
                "adjusted_coordinates": {"x": adjusted_x, "y": adjusted_y}
            }), 200
    except WebDriverException as e:
        return jsonify({"error": f"WebDriver error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
        
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
    yield json.dumps({
        "message": "Screenshot and DOM content captured successfully",
        "screenshot": screenshot,
    }).encode('utf-8')
    yield b'\n"dom_content": "'
    yield dom_content.encode('utf-8').replace(b'"', b'\\"').replace(b'\n', b'\\n')
    yield b'"}'

@app.route('/look', methods=['POST'])
@handle_alerts
def look(driver):
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

        # Use CDP to capture viewport screenshot and visible DOM content
        screenshot, dom_content = capture_viewport_data(driver)

        if screenshot is None or dom_content is None:
            return jsonify({"error": "Failed to capture viewport data"}), 500

        return Response(generate_response(screenshot, dom_content), content_type='application/json')
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500

def capture_viewport_data(driver):
    try:
        # Get the document.readyState
        ready_state = driver.execute_script("return document.readyState")
        
        # If the page is not complete, wait a bit more
        if ready_state != "complete":
            WebDriverWait(driver, 10).until(
                lambda d: d.execute_script("return document.readyState") == "complete"
            )

        # Capture viewport screenshot using CDP
        screenshot = driver.execute_cdp_cmd("Page.captureScreenshot", {
            "format": "png",
            "fromSurface": True,
            "captureBeyondViewport": False  # This ensures we only capture the viewport
        })

        # Get the visible DOM content
        visible_dom_content = driver.execute_script("""
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

        return screenshot['data'], visible_dom_content
    except Exception as e:
        print(f"Error capturing viewport data: {str(e)}")
        return None, None

def generate_response(screenshot, dom_content):
    return json.dumps({
        "screenshot": screenshot,
        "dom_content": dom_content
    })
    
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
        # Press Enter key
        action_chains = ActionChains(driver)
        action_chains.send_keys(Keys.ENTER).perform()

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
    
@app.route('/get_console_log', methods=['POST'])
@handle_alerts
def get_console_log(driver):
    data = request.json
    debugging_port = data.get('debugging_port', 9222)

    try:
        # Get browser logs
        logs = driver.get_log('browser')
        
        # Format logs for readability
        formatted_logs = []
        for log in logs:
            formatted_logs.append({
                'timestamp': log['timestamp'],
                'level': log['level'],
                'message': log['message']
            })
        
        return jsonify({
            "message": "Console logs retrieved successfully",
            "logs": formatted_logs
        }), 200

    except WebDriverException as e:
        return jsonify({"error": f"WebDriver error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Unexpected error: {str(e)}"}), 500
    
@app.route('/folder-tree', methods=['GET'])
def folder_tree():
    folder_path = request.args.get('folder_path')

    # cd into /home/fume/Documents and run find {folder_path} -type f -exec ls -l {} \; | grep -v ^total
    command = f"cd /home/fume/Documents && find {folder_path} -mindepth 1 -maxdepth 2"
    output = subprocess.check_output(command, shell=True).decode('utf-8')
    
    return jsonify({
        "message": "Folder tree retrieved successfully",
        "folder_path": folder_path,
        "output": output
    })
    
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5553, debug=True)