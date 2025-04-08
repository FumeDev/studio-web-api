/**
 * Test file for the Interactive Command Execution API
 */
import fetch from 'node-fetch';

const API_BASE_URL = 'http://localhost:5553';

/**
 * Helper to make API calls to our command execution endpoint
 */
async function callCommandAPI(endpoint: string, data: any): Promise<any> {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    
    return await response.json();
  } catch (error) {
    console.error('API call failed:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Test various command execution scenarios
 */
async function testCommandAPI(): Promise<void> {
  console.log('Starting command API tests...\n');
  
  // Test 1: Run a simple command
  console.log('Test 1: Run a simple command');
  try {
    const result1 = await callCommandAPI('/execute-command', {
      process_id: 'test-ls-1',
      command: 'ls',
      args: ['-la']
    });
    
    console.log('API response:', JSON.stringify(result1, null, 2));
    console.log('Test 1 successful!\n');
  } catch (error) {
    console.error('Test 1 failed:', error instanceof Error ? error.message : String(error), '\n');
  }
  
  // Test 2: Run a command with environment variables
  console.log('Test 2: Run a command with environment variables');
  try {
    const result2 = await callCommandAPI('/execute-command', {
      process_id: 'test-env-1',
      command: 'bash',
      args: ['-c', 'echo $TEST_VAR'],
      options: {
        env: { TEST_VAR: 'Hello from API!' }
      }
    });
    
    console.log('API response:', JSON.stringify(result2, null, 2));
    console.log('Test 2 successful!\n');
  } catch (error) {
    console.error('Test 2 failed:', error instanceof Error ? error.message : String(error), '\n');
  }
  
  // Test 3: Run an interactive command
  console.log('Test 3: Run an interactive command');
  try {
    // Start the interactive process
    const result3a = await callCommandAPI('/execute-command', {
      process_id: 'test-interactive-1',
      command: 'bash',
      args: ['-c', 'read -p "Enter value: " input && echo "You entered: $input"']
    });
    
    console.log('Initial process start:', JSON.stringify(result3a, null, 2));
    
    // Wait for a moment
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Send input to the process
    const result3b = await callCommandAPI('/execute-command', {
      process_id: 'test-interactive-1',
      input: 'Hello from the API test'
    });
    
    console.log('After sending input:', JSON.stringify(result3b, null, 2));
    console.log('Test 3 successful!\n');
  } catch (error) {
    console.error('Test 3 failed:', error instanceof Error ? error.message : String(error), '\n');
  }
  
  // Test 4: Create a process with command and input in one request
  console.log('Test 4: Create a process with command and input in one request');
  try {
    const result4 = await callCommandAPI('/execute-command', {
      process_id: 'test-combined-1',
      command: 'bash',
      args: ['-c', 'read -p "Enter value: " input && echo "You entered: $input"'],
      input: 'Combined Input'
    });
    
    console.log('API response:', JSON.stringify(result4, null, 2));
    console.log('Test 4 successful!\n');
  } catch (error) {
    console.error('Test 4 failed:', error instanceof Error ? error.message : String(error), '\n');
  }
  
  // Test 5: Check status of a running process
  console.log('Test 5: Check status of a non-existent process');
  try {
    const result5 = await callCommandAPI('/execute-command', {
      process_id: 'nonexistent-process'
    });
    
    console.log('API response:', JSON.stringify(result5, null, 2));
    console.log('Test 5 successful!\n');
  } catch (error) {
    console.error('Test 5 failed:', error instanceof Error ? error.message : String(error), '\n');
  }
  
  // List all processes
  console.log('Listing all processes:');
  try {
    const response = await fetch(`${API_BASE_URL}/list-processes`);
    const listResult = await response.json();
    console.log('Processes:', JSON.stringify(listResult, null, 2));
  } catch (error) {
    console.error('Error listing processes:', error instanceof Error ? error.message : String(error));
  }
  
  console.log('\nAll command API tests completed!');
}

// Run the tests
testCommandAPI().catch(error => {
  console.error('Error in test runner:', error instanceof Error ? error.message : String(error));
}); 