import { ShellSession } from './executeCommand.js';

/**
 * Test the shell session functionality
 */
async function testShellSession(): Promise<void> {
  console.log('Starting shell session tests...\n');
  
  // Create a new shell session
  const session = new ShellSession();
  console.log('Initial working directory:', session.getWorkingDirectory());
  
  // Test 1: Run a simple command
  console.log('\nTest 1: Running ls in current directory');
  try {
    const lsResult = await session.executeCommand('ls', ['-la']);
    console.log('Command successful, found', lsResult.stdout.split('\n').length - 1, 'files');
  } catch (error) {
    console.error('Command failed:', error instanceof Error ? error.message : String(error));
  }
  
  // Test 2: Change directory and verify it persists
  console.log('\nTest 2: Changing directory');
  try {
    console.log('Running: cd src');
    await session.executeCommand('cd', ['src']);
    console.log('New working directory:', session.getWorkingDirectory());
    
    console.log('Running ls in the new directory');
    const lsResult = await session.executeCommand('ls', ['-la']);
    console.log('Files in src directory:', lsResult.stdout.split('\n').length - 1);
  } catch (error) {
    console.error('Command failed:', error instanceof Error ? error.message : String(error));
  }
  
  // Test 3: Set and use environment variables
  console.log('\nTest 3: Setting and using environment variables');
  try {
    console.log('Setting TEST_SESSION_VAR=SessionWorks');
    session.setEnvironmentVariables({ TEST_SESSION_VAR: 'SessionWorks' });
    
    console.log('Echoing the environment variable');
    const envResult = await session.executeCommand('bash', ['-c', 'echo "Value: $TEST_SESSION_VAR"']);
    console.log('Result:', envResult.stdout.trim());
  } catch (error) {
    console.error('Command failed:', error instanceof Error ? error.message : String(error));
  }
  
  // Test 4: Run cd command within a shell script
  console.log('\nTest 4: Change directory within a shell command');
  try {
    console.log('Running: bash -c "cd .. && pwd"');
    await session.executeCommand('bash', ['-c', 'cd .. && pwd']);
    console.log('New working directory:', session.getWorkingDirectory());
    
    console.log('Verifying by listing files in the directory');
    const lsResult = await session.executeCommand('ls', ['-la']);
    console.log('Files in new directory:', lsResult.stdout.split('\n').length - 1);
  } catch (error) {
    console.error('Command failed:', error instanceof Error ? error.message : String(error));
  }
  
  console.log('\nAll shell session tests completed!');
}

// Run the tests
testShellSession().catch(error => {
  console.error('Error in test runner:', error instanceof Error ? error.message : String(error));
}); 