import { executeCommand, type CommandResult, type CommandPromise } from './executeCommand.js';

/**
 * Test various command execution scenarios
 */
async function runTests(): Promise<void> {
  console.log('Starting command execution tests...\n');

  // Test 1: Simple directory listing
  console.log('Test 1: Running simple directory listing (ls -la)');
  try {
    const lsResult = await executeCommand('ls', ['-la']);
    console.log('Exit code:', lsResult.exitCode);
    console.log('Files found:', lsResult.stdout.split('\n').length - 1);
    console.log('Test 1 successful!\n');
  } catch (error) {
    console.error('Test 1 failed:', error instanceof Error ? error.message : String(error), '\n');
  }

  // Test 2: Command with environment variables
  console.log('Test 2: Command with environment variables');
  try {
    const envResult = await executeCommand('bash', ['-c', 'echo $TEST_VAR'], {
      env: { ...process.env, TEST_VAR: 'Hello from TypeScript!' }
    });
    console.log('Result:', envResult.stdout.trim());
    console.log('Test 2 successful!\n');
  } catch (error) {
    console.error('Test 2 failed:', error instanceof Error ? error.message : String(error), '\n');
  }

  // Test 3: Interactive command
  console.log('Test 3: Interactive command with input');
  try {
    const interactivePromise = executeCommand('bash', ['-c', 'read -p "Enter value: " input && echo "You entered: $input"']);
    
    // Send input after a short delay
    setTimeout(() => {
      console.log('Sending input to process...');
      interactivePromise.sendInput('TypeScript Test');
    }, 500);
    
    const interactiveResult = await interactivePromise;
    console.log('Exit code:', interactiveResult.exitCode);
    console.log('Test 3 successful!\n');
  } catch (error) {
    console.error('Test 3 failed:', error instanceof Error ? error.message : String(error), '\n');
  }

  // Test 4: Failed command
  console.log('Test 4: Handling a non-existent command');
  try {
    const failedResult = await executeCommand('command_that_does_not_exist');
    console.log('Exit code (should not reach here):', failedResult.exitCode);
  } catch (error) {
    console.log('Successfully caught error for non-existent command');
    console.log('Error message:', error instanceof Error ? error.message : String(error));
    console.log('Test 4 successful!\n');
  }

  // Test 5: Long-running command with cancellation
  console.log('Test 5: Long-running command with timeout');
  try {
    // Create a promise that will reject after the timeout
    const timeout = new Promise<CommandResult>((_, reject) => {
      setTimeout(() => reject(new Error('Command timed out')), 3000);
    });
    
    console.log('Starting sleep command (10s)...');
    const sleepPromise = executeCommand('sleep', ['10']);
    
    // Race the command against the timeout
    const sleepResult = await Promise.race([sleepPromise, timeout]);
    console.log('Command completed before timeout:', sleepResult);
  } catch (error) {
    console.log('Command was interrupted by timeout as expected');
    console.log('Error message:', error instanceof Error ? error.message : String(error));
    console.log('Test 5 successful!\n');
  }

  console.log('All tests completed!');
}

// Run the tests
runTests().catch(error => {
  console.error('Error in test runner:', error instanceof Error ? error.message : String(error));
});