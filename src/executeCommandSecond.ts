// Install: npm install node-pty
import { spawn } from "node-pty";

/**
 * Runs commands or interactive input in a shell via a pseudo-terminal,
 * returning output when the shell is ready for new input.
 *
 * @param inputs  A string (single command), or array of strings (multiple commands),
 *                or even interactive sequences you want to enter.
 * @param shell   The path to the shell to spawn. Defaults to /bin/bash.
 * @returns       A Promise resolving to the shell output once it reaches our custom prompt.
 */
export async function runInPseudoTerminal(
  inputs: string | string[],
  shell: string = "/bin/bash"
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Convert single command into array for consistency.
    const commands = Array.isArray(inputs) ? inputs : [inputs];

    // Spawn a shell in a pseudo-tty
    const ptyProcess = spawn(shell, [], {
      name: "xterm-color",
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 30,
    });

    // We will detect this prompt to know the shell is "idle" again.
    const UNIQUE_PROMPT = "__END_OF_COMMAND__";

    let outputBuffer = "";
    let promptSet = false;
    let readyToResolve = false;

    /**
     * Writes a command to the pseudo-terminal with a trailing newline (\r or \n).
     * The command can be interactive text, a typical shell command, or even partial input.
     */
    function writeCommand(cmd: string): void {
      // In a typical shell, you can send each command or user input
      // followed by a newline (\r).
      ptyProcess.write(cmd.trim() + "\r");
    }

    // Watch the data stream from the shell
    ptyProcess.onData((data) => {
      outputBuffer += data;

      // If we haven't yet set the prompt, we look for it in the buffer
      if (!promptSet) {
        // Attempt to set a new prompt
        if (outputBuffer.includes(UNIQUE_PROMPT)) {
          // Once the prompt is found, we know the shell recognized our export of PS1
          promptSet = true;
          // Clear the output buffer up to this point so we start fresh for the actual commands
          outputBuffer = "";
          // Now send the queued-up commands
          commands.forEach((cmd) => writeCommand(cmd));
          return;
        }
      } else {
        // If the prompt is already set, we check if the shell has completed commands
        if (outputBuffer.includes(UNIQUE_PROMPT)) {
          // Indicate we can resolve
          readyToResolve = true;
          // We could remove the prompt from the output if we want a "clean" result
          return;
        }
      }
    });

    // When the process exits unexpectedly, handle errors
    ptyProcess.onExit(({ exitCode, signal }) => {
      // If we already plan to resolve, do it
      if (readyToResolve) {
        // Remove the unique prompt from the final output if present
        const finalOutput = outputBuffer.replace(UNIQUE_PROMPT, "").trim();
        return resolve(finalOutput);
      }
      // Otherwise, treat it as an error
      const errMsg = signal
        ? `Shell exited with signal: ${signal}`
        : `Shell exited with code: ${exitCode}`;
      return reject(new Error(errMsg));
    });

    // Step 1: Immediately set our unique prompt
    // We do this by writing an export line, and then we wait for that new prompt to show up.
    ptyProcess.write(`export PS1="${UNIQUE_PROMPT}"\r`);
  });
}

async function exampleUsage() {
  try {
    const result = await runInPseudoTerminal([
      'echo "Hello World"',
      // Simulate interactive input:
      // e.g. password prompt or subcommand.
      // This is just a simplistic example to show multiple writes:
      'echo "Are we done? Yes."',
    ]);

    console.log("Shell output:\n", result);
  } catch (err) {
    console.error("Error running command:", err);
  }
}

exampleUsage();
